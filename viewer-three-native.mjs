import { REVISION, StorageBufferAttribute, Vector3 } from 'three-r186/webgpu';
import { Fn, instanceIndex, storage, texture, uniform, vec4, packUnorm4x8, wgslFn } from 'three-r186/tsl';
import { APPEARANCE_WGSL } from './viewer-gpu-appearance.mjs';

// r186 has no public dynamic-color/geometry update hook. Isolate and guard the
// private integration. Projection, alpha compensation and sorting are upstream.
function nativeBuffers(mesh) {
  const b = mesh._buffers;
  if (REVISION !== '186' || !mesh.isGaussianSplat || b?.sphericalHarmonicsDegree !== 0 || !b?.colorRead?.value?.isStorageBufferAttribute
    || !(b.colorRead.value.array instanceof Uint32Array) || b.colorRead.value.itemSize !== 1
    || b.colorRead.value.count !== mesh.splatGeometry.getAttribute('position').count
    || !b.centerRead?.value || !b.covarianceARead?.value || !b.covarianceBRead?.value || !mesh._sort) {
    throw new Error('Unsupported official GaussianSplat buffer layout');
  }
  return b;
}

const ap = wgslFn('fn ap(t: texture_2d<f32>, i: i32, row: i32) -> vec4f { return textureLoad(t,vec2i(i,row),0); }');
const ar = wgslFn('fn ar(t: texture_2d<f32>, i: i32) -> vec4f { let w=i32(textureDimensions(t).x); return textureLoad(t,vec2i(i%w,i/w),0); }');
// Reuse shared equations, passing textures explicitly into TSL function nodes.
const shared = APPEARANCE_WGSL.replaceAll('ap(', 'ap(params,').replaceAll('ar(', 'ar(receivers,')
  .replaceAll('acurve(', 'acurve(params,')
  .replace('fn acurve(params,input:', 'fn acurve(params: texture_2d<f32>, input:');
const split = shared.indexOf('fn ashade(');
const curve = wgslFn(shared.slice(0, split), [ap]);
const shade = wgslFn(shared.slice(split).replace('fn ashade(position:',
  'fn ashade(params: texture_2d<f32>, receivers: texture_2d<f32>, position:'), [ap, ar, curve]);
const encode = wgslFn('fn encodeSplat(c: vec3f) -> vec3f { return select(12.92*c,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308)); }');

export function createNativeAppearance(mesh, flat, slots, paramsTexture, receiverTexture) {
  const b = nativeBuffers(mesh);
  const points = new Float32Array(flat.count * 4);
  for (let i=0;i<flat.count;i++) points.set([...flat.center.subarray(i*3,i*3+3),flat.opacity[i]],i*4);
  const pointAttribute = new StorageBufferAttribute(points,4);
  const slotAttribute = new StorageBufferAttribute(new Uint32Array(slots),2);
  const position = storage(pointAttribute,'vec4',flat.count).toReadOnly();
  const slot = storage(slotAttribute,'uvec2',flat.count).toReadOnly();
  const output = storage(b.colorRead.value,'uint',flat.count);
  const camera = uniform(new Vector3());
  const params = texture(paramsTexture), receivers = texture(receiverTexture);
  const compute = Fn(() => {
    const p = position.element(instanceIndex), s = slot.element(instanceIndex);
    const color = shade(params, receivers, p.xyz, s.x.toInt(), s.y.toInt(), camera);
    output.element(instanceIndex).assign(packUnorm4x8(vec4(encode(color), p.w.clamp(0,1))));
  })().compute(flat.count, [64]).setName('SceneLabAppearance');
  mesh.geometry.setAttribute('sceneLabAppearancePoints', pointAttribute);
  mesh.geometry.setAttribute('sceneLabAppearanceSlots', slotAttribute);
  return { compute, camera, updatePositions(next) {
    for(let i=0;i<next.count;i++) points.set(next.center.subarray(i*3,i*3+3),i*4);
    pointAttribute.needsUpdate=true;
  } };
}

export function updateNativeGeometry(mesh, flat) {
  const b = nativeBuffers(mesh);
  const centers = b.centerRead.value, a = b.covarianceARead.value, c = b.covarianceBRead.value;
  for (let i=0;i<flat.count;i++) {
    const j=i*3,k=i*4,d=flat.covarianceDiagonal,o=flat.covarianceOffDiagonal;
    centers.array.set(flat.center.subarray(j,j+3),k);
    a.array.set([d[j],o[j],o[j+1],d[j+1]],k);
    c.array.set([o[j+2],d[j+2]],k);
  }
  for(const attribute of [centers,a,c]) {
    attribute.needsUpdate=true;
    if(attribute.pbo)attribute.pbo.needsUpdate=true;
  }
  mesh.splatGeometry.getAttribute('position').array.set(flat.center);
  const covariance=mesh.splatGeometry.getAttribute('covariance').array;
  for(let i=0;i<flat.count;i++) {
    const j=i*3,d=flat.covarianceDiagonal,o=flat.covarianceOffDiagonal;
    covariance.set([d[j],o[j],o[j+1],d[j+1],o[j+2],d[j+2]],i*6);
  }
  mesh.computeBoundingSphere();
  mesh._sortInitialized=false;
}

export function disposeNativeSplat(mesh) {
  if (!mesh) return;
  // The addon has no dispose(). Register storage attributes with geometry
  // ownership and release the counting-sort compute bindings explicitly.
  // Cleanup must still work if an upstream layout guard rejected installation.
  // Never require that same private layout to release public owned resources.
  const b=mesh._buffers ?? {};
  for(const [name,node] of Object.entries(b)) if(node?.value?.isStorageBufferAttribute)
    mesh.geometry.setAttribute(`sceneLabOwned_${name}`,node.value);
  for(const [name,value] of Object.entries(mesh._sort ?? {})) {
    if(value?.isStorageBufferAttribute) mesh.geometry.setAttribute(`sceneLabSort_${name}`,value);
    if(value?.value?.isStorageBufferAttribute) mesh.geometry.setAttribute(`sceneLabSortBuffer_${name}`,value.value);
    if(value?.isComputeNode) value.dispose();
  }
  // WebGL fallback storage reads allocate PBO DataTextures. Attribute disposal
  // deletes GL buffers, not these textures; shared read/write nodes alias them.
  for(const attribute of new Set(Object.values(mesh.geometry?.attributes ?? {}))) attribute.pbo?.dispose();
  mesh.geometry?.dispose(); mesh.material?.dispose(); mesh.splatGeometry?.dispose();
}
