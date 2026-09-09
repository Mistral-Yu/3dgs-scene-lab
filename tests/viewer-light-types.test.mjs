import test from 'node:test';
import assert from 'node:assert/strict';
import { expandLightSamples, directionalRayLength, directionalRayOrigin } from '../viewer-light-types.mjs';
import { applyDirectLighting } from '../viewer-lighting.mjs';
import { computeAllSplatLightTransmissionAsync, validateLights } from '../viewer-light-occlusion.mjs';
import { createDeterministicSplatBvh } from '../viewer-static-lighting.mjs';

const shade = (lights, position = [0,0,0]) => applyDirectLighting({baseLinearRgb:[0.1,0.1,0.1], normal:[0,0,1], position, lights});
const area = { id:'panel',type:'area',position:[0,0,2],direction:[0,0,-1],right:[1,0,0],up:[0,1,0],width:2,height:2,intensity:4,color:[1,1,1] };
test('rectangle samples preserve energy, orientation, stable ids and independent transmission', () => {
  const samples=expandLightSamples([area]);
  assert.equal(samples.length,4);
  assert.equal(samples.reduce((sum,l)=>sum+l.intensity,0),area.intensity);
  assert.deepEqual(samples[0].position,[-0.5,-0.5,2]);
  assert.deepEqual(samples[3].position,[0.5,0.5,2]);
  const rotated=expandLightSamples([{...area,right:[0,1,0],up:[0,0,1],direction:[-1,0,0]}]);
  assert.deepEqual(rotated[0].position,[0,-0.5,1.5]);
  const lit=shade(samples)[0], partly=shade(samples.map((l,i)=>({...l,visibility:i===0?0:1})))[0];
  assert.ok(Math.abs((partly-0.1)/(lit-0.1)-0.75)<1e-12);
  assert.deepEqual(shade(expandLightSamples([{...area,direction:[0,0,1]}])),[0.1,0.1,0.1]);
  assert.deepEqual(expandLightSamples([{...area,visible:false}]),[]);
});
test('directional illumination has no distance falloff and respects emission direction', () => {
  const light={id:'sun',type:'directional',position:[0,0,2],direction:[0,0,-1],intensity:2,color:[1,0.5,0]};
  assert.deepEqual(shade([light]),shade([{...light,position:[90,30,500]}],[7,9,-100]));
  assert.deepEqual(shade([light]),shade([light],[0,0,1e18]));
  assert.deepEqual(shade([{...light,direction:[0,0,1]}]),[0.1,0.1,0.1]);
  assert.deepEqual(shade([{...light,visibility:0}]),[0.1,0.1,0.1]);
  assert.throws(()=>validateLights([{...light,direction:[0,0,0]}]),/nonzero direction/);
});
test('parallel shadow rays cover the scene, reverse correctly and ignore helper position', async () => {
  const snapshot={count:3,center:new Float32Array([0,0,0,0,0,1,1,0,0]),scale:new Float32Array(9).fill(0.1),opacity:new Float32Array([0,1,0]),itemIndex:new Uint32Array([0,1,2]),sourceIndex:new Uint32Array([0,0,0])};
  const bvh=createDeterministicSplatBvh(snapshot);
  assert.ok(directionalRayLength(bvh)>2);
  assert.ok(directionalRayOrigin(bvh,0,[0,0,-1])[2]>1.3);
  const light={id:'sun',type:'directional',direction:[0,0,-1],position:[0,0,2]};
  const a=await computeAllSplatLightTransmissionAsync({snapshot,lights:[light]});
  const b=await computeAllSplatLightTransmissionAsync({snapshot,lights:[{...light,position:[1e6,4,7]}]});
  const reversed=await computeAllSplatLightTransmissionAsync({snapshot,lights:[{...light,direction:[0,0,1]}]});
  assert.deepEqual(a.transmission,b.transmission);
  assert.ok(a.transmission[0]<0.001);
  assert.equal(a.transmission[2],1);
  assert.equal(reversed.transmission[0],1);
  const distant={...snapshot,center:new Float32Array([0,0,0,0,0,1,1e6,0,0])};
  const distantResult=await computeAllSplatLightTransmissionAsync({snapshot:distant,lights:[light]});
  assert.ok(distantResult.transmission[0]<0.001,'A distant unrelated splat must not increase the receiver endpoint bias');
});
