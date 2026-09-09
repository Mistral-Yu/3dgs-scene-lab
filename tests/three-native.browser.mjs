import { LookDevBackendManager } from '../viewer-backends.mjs';
import { applyDirectLighting, DIRECT_LIGHT_NORMAL_POLICY } from '../viewer-lighting.mjs';
import { applyToneCurveToLinearRgb, buildToneCurveState } from '../viewer-tone-curve.mjs';
import { linearToSrgbChannel } from '../viewer-color.mjs';
const T=globalThis.__SPATIAL_LOOKDEV_THREE_R186__;
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
const result=document.querySelector('#result');
document.querySelector('#run').onclick=async()=>{
  document.querySelector('#run').disabled=true;
  let manager;
  const errors=[];
  try {
    const items=Array.from({length:64},(_,i)=>{
      const toneCurve=buildToneCurveState();
      if(i%2)toneCurve.curves.master=[{x:0,y:0.05},{x:0.3,y:0.14},{x:0.7,y:0.86},{x:1,y:0.93}];
      if(i%3)toneCurve.curves.red=[{x:0,y:0},{x:0.4,y:0.7},{x:1,y:1}];
      const lights=Array.from({length:i%9},(_,l)=>({id:String(l),position:[l-2,1,l%2],color:[0.1+l*0.1,0.3,0.2],intensity:l+1,visible:true}));
      lights.forEach((l,j)=>{
        if(i%4===1||i%4===3&&j%3===1)Object.assign(l,{type:'directional',direction:[0,-1,0]});
        if(i%4===2||i%4===3&&j%3===2)Object.assign(l,{type:'area-sample',direction:[0,i%5===0?1:-1,0]});
      });
      const visibility={lightIds:lights.map(l=>l.id),data:Float32Array.from(lights,(_,l)=>(l+i)%7/6)};
      const appearance={id:String(i),exposure:2**(i%7-3),faceForward:i%2===0,toneCurve,lights,visibility};
      return {id:String(i),visible:true,center:new Float32Array([i%8*0.15-0.5,Math.floor(i/8)*0.15-0.5,0]),
        quaternion:new Float32Array([0,0,0,1]),scale:new Float32Array([0.04,0.04,0.01]),
        opacity:new Float32Array([0.2+i%5*0.19]),opacityMultiplier:1,
        linearRgb:new Float32Array([i/64,(64-i)/64,0.07]),appearanceNormals:new Float32Array([0,i%3?-1:1,0]),
        worldMatrix:new Float64Array(new T.Matrix4().toArray()),appearance};
    });
    const snapshot={version:1,items,splatCount:items.length};
    manager=new LookDevBackendManager({stage:document.querySelector('#stage'),inputCanvas:document.createElement('canvas')});
    await manager.setActive('three-r186',{getSnapshot:()=>snapshot});
    const b=manager.activeBackend;
    assert(b.canvas.dataset.graphicsApi==='webgpu','WebGPU required for native GPU test');
    assert(b.mesh.isGaussianSplat&&T.REVISION==='186','Official GaussianSplat r186');
    b.renderer.backend.device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
    const camera=new T.PerspectiveCamera(50,1.5,0.01,100);camera.position.set(0,2,4);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
    const render=()=>manager.renderFrame({camera,background:'#080c12',helpers:{showAxes:true},width:480,height:320,pixelRatio:1});
    let maxByteError=0,checks=0;
    const compare=async(label)=>{
      render();
      const bytes=new Uint8Array(await b.renderer.getArrayBufferAsync(b.mesh._buffers.colorRead.value));
      items.forEach((item,i)=>{
        const state=item.appearance;
        const lights=state.lights.map((l,j)=>({...l,visibility:state.visibility.data[j]}));
        const lit=applyDirectLighting({baseLinearRgb:Array.from(item.linearRgb,v=>v*state.exposure),lights,
          normal:Array.from(item.appearanceNormals),position:Array.from(b.flat.center.subarray(i*3,i*3+3)),cameraPosition:camera.position.toArray(),
          normalPolicy:state.faceForward?DIRECT_LIGHT_NORMAL_POLICY.IMPORTED_COVARIANCE_FACE_FORWARD:DIRECT_LIGHT_NORMAL_POLICY.AUTHORED_ONE_SIDED});
        const expected=applyToneCurveToLinearRgb(lit,state.toneCurve).map(v=>Math.round(linearToSrgbChannel(v)*255));
        expected.push(Math.round(Math.min(1,item.opacity[0])*255));
        expected.forEach((v,c)=>{const error=Math.abs(bytes[i*4+c]-v);maxByteError=Math.max(maxByteError,error);assert(error<=1,`${label} receiver ${i} channel ${c}: ${bytes[i*4+c]} != ${v}`);checks++;});
      });
    };
    await compare('initial mixed lights/grade/visibility');
    const originalMesh=b.mesh;
    items.forEach(item=>{item.appearance={...item.appearance,exposure:0.4,visibility:{...item.appearance.visibility,data:new Float32Array(item.appearance.lights.length).fill(0.25)}};});
    assert(b.setAppearance(items.map(i=>i.appearance)),'Appearance update accepted');
    await compare('stationary appearance refresh');
    assert(b.mesh===originalMesh,'Appearance must not rebuild geometry');
    camera.position.set(0,-2,4);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
    await compare('camera face-forward update');
    b.syncItemTransforms([{id:'0',worldMatrix:new T.Matrix4().makeTranslation(0.2,0,0).toArray()}]);
    await compare('transform without CPU sort');
    const sorted=new Uint32Array(await b.renderer.getArrayBufferAsync(b.mesh._sort.orderAttribute));
    assert(new Set(sorted).size===64&&Math.max(...sorted)===63,'GPU sort is a complete permutation');
    // Opaque neutral splat: verify final render target encoding, not only the
    // intermediate color buffer. A large sigma keeps AA correction negligible.
    const neutral={...items[0],id:'neutral',center:new Float32Array([0,0,0]),scale:new Float32Array([0.5,0.5,0.05]),opacity:new Float32Array([1]),linearRgb:new Float32Array([0.18,0.18,0.18]),appearance:null,worldMatrix:new T.Matrix4().toArray()};
    b.syncSnapshot({version:1,items:[neutral],splatCount:1});
    camera.position.set(0,0,3);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
    // The official sRGB-working example writes encoded colors to an unorm
    // canvas. An sRGB render-target attachment would encode them a second time.
    const target=new T.RenderTarget(64,64,{type:T.UnsignedByteType});target.texture.colorSpace=T.NoColorSpace;
    b.renderer.setRenderTarget(target);
    manager.renderFrame({camera,background:'#000000',helpers:{},width:64,height:64,pixelRatio:1});
    const pixels=await b.renderer.readRenderTargetPixelsAsync(target,32,32,1,1);
    const encoded=Math.round(linearToSrgbChannel(0.18)*255);
    for(let c=0;c<3;c++)assert(Math.abs(pixels[c]-encoded)<=3,`Circular neutral splat output ${Array.from(pixels)} != sRGB ${encoded}`);
    b.renderer.setRenderTarget(null);target.dispose();
    b.syncSnapshot(snapshot);render();
    await b.renderer.backend.device.queue.onSubmittedWorkDone();
    assert(!errors.length,errors.join('\n'));
    result.textContent=JSON.stringify({status:'PASS',revision:T.REVISION,graphicsApi:b.canvas.dataset.graphicsApi,cases:64,passes:4,channelChecks:checks,maxByteError,neutralSrgbPixel:Array.from(pixels),coverage:'point/directional/area, 0–8 lights, RGB/alpha, exposure, occlusion T, curves, camera, transform, global GPU sort, circular splat, sRGB output, rebuild'},null,2);
  }catch(error){result.textContent=`FAIL: ${error.stack}`;console.error(error);}
  finally{manager?.dispose();document.querySelector('#run').disabled=false;}
};
