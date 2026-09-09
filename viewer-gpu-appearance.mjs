import { getToneCurveSpline, normalizeToneCurveState } from './viewer-tone-curve.mjs';
import { lightTypeCode, lightVector } from './viewer-light-types.mjs';

// Linear-sRGB appearance stays on the rendering GPU. These are capacity limits,
// not sampling limits: callers must use the complete CPU path when unsupported.
export const APPEARANCE_WIDTH = 256;
export const APPEARANCE_MAX_LIGHTS = 8;
export const APPEARANCE_MAX_POINTS = 32;
export const appearanceSupported = (state) => Boolean(state && !state.legacy && !state.bounce
  && state.lights.length <= APPEARANCE_MAX_LIGHTS
  && Object.values(normalizeToneCurveState(state.toneCurve).curves).every(p => p.length <= APPEARANCE_MAX_POINTS));

export function packAppearance(state) {
  if (!appearanceSupported(state)) throw new Error('GPU appearance capacity or preview mode unsupported; use CPU compatibility');
  const data = new Float32Array(APPEARANCE_WIDTH * 4);
  data.set([state.exposure, state.faceForward ? 1 : 0, state.lights.length, 0]);
  const curves = normalizeToneCurveState(state.toneCurve).curves;
  ['master', 'red', 'green', 'blue'].forEach((channel, c) => {
    const { curve, tangents } = getToneCurveSpline(curves[channel]);
    data[4 + c] = curve.length;
    curve.forEach((p, i) => data.set([p.x, p.y, tangents[i], 0], (32 + c * 32 + i) * 4));
  });
  state.lights.forEach((light, i) => {
    const p = light.type === 'directional' ? lightVector(light.direction).map(v => -v / (Math.hypot(...lightVector(light.direction)) || 1)) : light.position;
    data.set([p.x ?? p[0], p.y ?? p[1], p.z ?? p[2], light.intensity], (4 + i * 2) * 4);
    const c = light.color;
    data.set([c.r ?? c[0], c.g ?? c[1], c.b ?? c[2], lightTypeCode(light)], (5 + i * 2) * 4);
    data.set(lightVector(light.direction), (20 + i) * 4);
  });
  return data;
}

// Four RGBA32F texels per receiver. The source colors and normals are immutable
// between geometry edits; only the visibility lanes are refreshed after a trace.
export function packAppearanceReceivers(item, state) {
  const data = new Float32Array(Math.max(1, item.opacity.length) * 16);
  for (let i = 0; i < item.opacity.length; i++) {
    data.set(item.linearRgb.subarray(i * 3, i * 3 + 3), i * 16);
    data.set(item.appearanceNormals.subarray(i * 3, i * 3 + 3), i * 16 + 4);
    data.fill(1, i * 16 + 8, i * 16 + 16);
  }
  updateAppearanceVisibility(data, state, item.opacity.length);
  return data;
}

export function updateAppearanceVisibility(data, state, count, offset = 0) {
  const cache = state.visibility;
  const slots = state.lights.map(light => cache?.lightIds.indexOf(light.id) ?? -1);
  for (let i = 0; i < count; i++) for (let l = 0; l < 8; l++) {
    const slot = slots[l] ?? -1;
    data[(offset + i) * 16 + 8 + l] = slot >= 0 ? cache.data[i * cache.lightIds.length + slot] : 1;
  }
}

// The backend supplies ap(index,row), ar(texel), and the camera world position.
export const APPEARANCE_GLSL = `
float acurve(float x, int channel, int row) {
  x = clamp(x, 0.0, 1.0);
  int count = int(ap(1, row)[channel]);
  vec4 a = ap(32 + channel * 32, row), b = a;
  for (int i = 1; i < 32; i++) {
    if (i >= count) break;
    b = ap(32 + channel * 32 + i, row);
    if (x <= b.x || i == count - 1) break;
    a = b;
  }
  float span = max(b.x - a.x, 0.001), t = clamp((x - a.x) / span, 0.0, 1.0);
  float t2 = t*t, t3 = t2*t;
  return clamp((2.0*t3-3.0*t2+1.0)*a.y+(t3-2.0*t2+t)*span*a.z+(-2.0*t3+3.0*t2)*b.y+(t3-t2)*span*b.z,0.0,1.0);
}
vec3 ashade(vec3 position, int receiver, int row, vec3 camera) {
  vec4 settings = ap(0,row);
  vec3 base = max(ar(receiver*4).rgb * settings.x, vec3(0.0));
  vec3 normal = ar(receiver*4+1).xyz;
  if (settings.y > 0.5 && dot(normal,camera-position)<0.0) normal = -normal;
  vec3 irradiance = vec3(0.0);
  for (int l=0; l<8; l++) {
    if (l>=int(settings.z)) break;
    vec4 light = ap(4+l*2,row);
    float type = ap(5+l*2,row).w;
    vec3 delta = type == 1.0 ? light.xyz : light.xyz-position;
    float ds = dot(delta,delta), ns = dot(normal,normal);
    float transmission = ar(receiver*4+2+l/4)[l%4];
    float emission = type == 2.0 ? max(dot(ap(20+l,row).xyz,-delta)/max(sqrt(ds),0.000001),0.0) : 1.0;
    if (ds>0.0 && ns>0.0) irradiance += ap(5+l*2,row).rgb * (max(light.w,0.0)*emission*transmission*max(dot(normal,delta)/sqrt(ns*ds),0.0)/(type == 1.0 ? 1.0 : max(ds,0.0001)));
  }
  vec3 color = base*(vec3(1.0)+irradiance);
  return vec3(acurve(acurve(color.r,0,row),1,row),acurve(acurve(color.g,0,row),2,row),acurve(acurve(color.b,0,row),3,row));
}
`;

export const APPEARANCE_WGSL = `
fn acurve(input: f32, channel: i32, row: i32) -> f32 {
  let x = clamp(input,0.0,1.0);
  let count = i32(ap(1,row)[channel]);
  var a = ap(32+channel*32,row); var b = a;
  for(var i=1; i<32; i++) {
    if(i>=count){break;}
    b=ap(32+channel*32+i,row);
    if(x<=b.x || i==count-1){break;}
    a=b;
  }
  let span=max(b.x-a.x,0.001); let t=clamp((x-a.x)/span,0.0,1.0);
  let t2=t*t; let t3=t2*t;
  return clamp((2.0*t3-3.0*t2+1.0)*a.y+(t3-2.0*t2+t)*span*a.z+(-2.0*t3+3.0*t2)*b.y+(t3-t2)*span*b.z,0.0,1.0);
}
fn ashade(position: vec3f, receiver: i32, row: i32, camera: vec3f) -> vec3f {
  let settings=ap(0,row);
  let base=max(ar(receiver*4).rgb*settings.x,vec3f(0.0));
  var normal=ar(receiver*4+1).xyz;
  if(settings.y>0.5 && dot(normal,camera-position)<0.0){normal=-normal;}
  var irradiance=vec3f(0.0);
  for(var l=0; l<8; l++) {
    if(l>=i32(settings.z)){break;}
    let light=ap(4+l*2,row); let lightKind=ap(5+l*2,row).w;
    let delta=select(light.xyz-position,light.xyz,lightKind==1.0);
    let ds=dot(delta,delta); let ns=dot(normal,normal);
    let transmission=ar(receiver*4+2+l/4)[l%4];
    let emission=select(1.0,max(dot(ap(20+l,row).xyz,-delta)/max(sqrt(ds),0.000001),0.0),lightKind==2.0);
    if(ds>0.0 && ns>0.0){irradiance+=ap(5+l*2,row).rgb*(max(light.w,0.0)*emission*transmission*max(dot(normal,delta)/sqrt(ns*ds),0.0)/select(max(ds,0.0001),1.0,lightKind==1.0));}
  }
  let color=base*(vec3f(1.0)+irradiance);
  return vec3f(acurve(acurve(color.r,0,row),1,row),acurve(acurve(color.g,0,row),2,row),acurve(acurve(color.b,0,row),3,row));
}
`;

export const PC_APPEARANCE_MODIFIER = {
  glsl: `uniform sampler2D appearanceParams;
uniform sampler2D appearanceReceivers;
uniform vec3 appearanceCamera;
vec4 ap(int i,int row){return texelFetch(appearanceParams,ivec2(i,row),0);}
vec4 ar(int i){int w=textureSize(appearanceReceivers,0).x;return texelFetch(appearanceReceivers,ivec2(i%w,i/w),0);}
${APPEARANCE_GLSL}
void modifySplatCenter(inout vec3 center){}
void modifySplatRotationScale(vec3 originalCenter,vec3 modifiedCenter,inout vec4 rotation,inout vec3 scale){}
void modifySplatColor(vec3 center,inout vec4 color){vec3 c=ashade(center,int(splat.index),0,appearanceCamera); color.rgb=mix(12.92*c,1.055*pow(c,vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));}`,
  wgsl: `var appearanceParams: texture_2d<f32>;
var appearanceReceivers: texture_2d<f32>;
uniform appearanceCamera: vec3f;
fn ap(i:i32,row:i32)->vec4f{return textureLoad(appearanceParams,vec2i(i,row),0);}
fn ar(i:i32)->vec4f{let w=i32(textureDimensions(appearanceReceivers).x);return textureLoad(appearanceReceivers,vec2i(i%w,i/w),0);}
${APPEARANCE_WGSL}
fn modifySplatCenter(center:ptr<function,vec3f>){}
fn modifySplatRotationScale(originalCenter:vec3f,modifiedCenter:vec3f,rotation:ptr<function,vec4f>,scale:ptr<function,vec3f>){}
fn modifySplatColor(center:vec3f,color:ptr<function,vec4f>){let c=ashade(center,i32(splat.index),0,uniform.appearanceCamera); *color=vec4f(select(12.92*c,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308)),(*color).a);}`,
};
