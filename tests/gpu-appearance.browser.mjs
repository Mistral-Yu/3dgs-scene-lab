import { APPEARANCE_WGSL, packAppearance } from '../viewer-gpu-appearance.mjs';
import { applyDirectLighting, DIRECT_LIGHT_NORMAL_POLICY } from '../viewer-lighting.mjs';
import { applyToneCurveToLinearRgb, buildToneCurveState } from '../viewer-tone-curve.mjs';

export async function testGpuAppearance() {
  const device = await (await navigator.gpu.requestAdapter()).requestDevice();
  const buffers = [];
  try {
    const count = 64, params = new Float32Array(count * 256 * 4), receivers = new Float32Array(count * 16);
    const expected = [];
    for (let i=0;i<count;i++) {
      const toneCurve = buildToneCurveState();
      if(i%2) toneCurve.curves.master = [{x:0,y:0.05},{x:0.3,y:0.14},{x:0.7,y:0.86},{x:1,y:0.93}];
      if(i%3) toneCurve.curves.red = [{x:0,y:0},{x:0.4,y:0.7},{x:1,y:1}];
      const lights = Array.from({length:i%9},(_,l)=>({id:String(l),position:[l-2,1,l%2],color:[0.1+l*0.1,0.3,0.2],intensity:l+1,visible:true,visibility:(l+i)%7/6}));
      for (const [l, light] of lights.entries()) {
        if (i%4 === 1 || i%4 === 3 && l%3 === 1) Object.assign(light,{type:'directional',direction:[0,-1,0]});
        if (i%4 === 2 || i%4 === 3 && l%3 === 2) Object.assign(light,{type:'area-sample',direction:[0,i%5===0?1:-1,0]});
      }
      const exposure = 2 ** (i%7-3), faceForward = i%2===0;
      params.set(packAppearance({exposure,faceForward,toneCurve,lights}),i*1024);
      const base=[i/64,(64-i)/64,0.07], normal=[0,i%3 ? -1 : 1,0];
      receivers.set(base,i*16); receivers.set(normal,i*16+4);
      for(let l=0;l<8;l++)receivers[i*16+8+l]=lights[l]?.visibility??1;
      const lit=applyDirectLighting({baseLinearRgb:base.map(v=>v*exposure),lights,normal,position:[0,0,0],cameraPosition:[0,2,4],normalPolicy:faceForward?DIRECT_LIGHT_NORMAL_POLICY.IMPORTED_COVARIANCE_FACE_FORWARD:DIRECT_LIGHT_NORMAL_POLICY.AUTHORED_ONE_SIDED});
      expected.push(...applyToneCurveToLinearRgb(lit,toneCurve),1);
    }
    const module=device.createShaderModule({code:`
@group(0) @binding(0) var<storage,read> params:array<vec4f>;
@group(0) @binding(1) var<storage,read> receivers:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> output:array<vec4f>;
fn ap(i:i32,row:i32)->vec4f{return params[row*256+i];}
fn ar(i:i32)->vec4f{return receivers[i];}
${APPEARANCE_WGSL}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){output[id.x]=vec4f(ashade(vec3f(0),i32(id.x),i32(id.x),vec3f(0,2,4)),1);}`});
    const errors=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');
    if(errors.length)throw new Error(errors.map(m=>m.message).join('\n'));
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
    const upload=(data)=>{const b=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});buffers.push(b);device.queue.writeBuffer(b,0,data);return b;};
    const a=upload(params),b=upload(receivers);
    const result=device.createBuffer({size:count*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    const readback=device.createBuffer({size:count*16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});buffers.push(result,readback);
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[a,b,result].map((buffer,binding)=>({binding,resource:{buffer}}))});
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(result,0,readback,0,count*16);device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual=new Float32Array(readback.getMappedRange());
    let maxError=0;for(let i=0;i<actual.length;i++){if(!Number.isFinite(actual[i]))throw new Error('Nonfinite appearance');maxError=Math.max(maxError,Math.abs(actual[i]-expected[i]));}
    readback.unmap();if(maxError>1e-5)throw new Error(`Appearance error ${maxError}`);
    return {cases:count,maxError,lights:'0–8',coverage:'exposure, imported/authored normals, colored lights, visibility, master/red PCHIP curves'};
  } finally {buffers.forEach(b=>b.destroy());device.destroy();}
}
