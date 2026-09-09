import test from 'node:test';
import assert from 'node:assert/strict';
import { appearanceSupported, packAppearance, packAppearanceReceivers, updateAppearanceVisibility, PC_APPEARANCE_MODIFIER } from '../viewer-gpu-appearance.mjs';
import { buildToneCurveState } from '../viewer-tone-curve.mjs';
const state = () => ({ exposure:2,faceForward:true,lights:[{id:'a',position:[1,2,3],color:[0.2,0.5,1],intensity:4}],toneCurve:buildToneCurveState() });
test('GPU appearance packs linear values and exact spline endpoints without truncating unsupported modes',()=>{
  const s=state(), data=packAppearance(s);
  assert.deepEqual([...data.slice(0,4)],[2,1,1,0]);
  assert.deepEqual([...data.slice(16,20)],[1,2,3,4]);
  for (const extra of [{legacy:true},{bounce:true},{lights:Array(9).fill(s.lights[0])}]) {
    assert.equal(appearanceSupported({...s,...extra}),false);
    assert.throws(()=>packAppearance({...s,...extra}),/CPU compatibility/);
  }
  s.toneCurve.curves.red=Array.from({length:33},(_,i)=>({x:i/32,y:i/32}));
  assert.equal(appearanceSupported(s),false);
});
test('visibility refresh preserves immutable source RGB and normals and remaps light IDs',()=>{
  const s=state(), item={opacity:new Float32Array(2),linearRgb:new Float32Array([0.1,0.2,0.3,0.4,0.5,0.6]),appearanceNormals:new Float32Array([0,1,0,1,0,0])};
  const data=packAppearanceReceivers(item,s), before=data.slice();
  s.visibility={lightIds:['b','a'],data:new Float32Array([0.2,0.3,0.4,0.5])};
  updateAppearanceVisibility(data,s,2);
  assert.equal(data[8],Math.fround(0.3));assert.equal(data[24],0.5);
  assert.deepEqual(data.slice(0,8),before.slice(0,8));assert.deepEqual(data.slice(16,24),before.slice(16,24));
  updateAppearanceVisibility(data,{...s,visibility:null},2);assert.equal(data[8],1);
});
test('PlayCanvas resource declarations occupy separate parser-visible lines',()=>{
  assert.match(PC_APPEARANCE_MODIFIER.wgsl,/^var appearanceParams: texture_2d<f32>;$/m);
  assert.match(PC_APPEARANCE_MODIFIER.wgsl,/^var appearanceReceivers: texture_2d<f32>;$/m);
  assert.match(PC_APPEARANCE_MODIFIER.wgsl,/^uniform appearanceCamera: vec3f;$/m);
});
