// Native scene units; direction is the direction light travels (local -Z).
// Rectangle intensity is total normalized source strength, independent of size.
// Four deterministic midpoint samples approximate a one-sided diffuse emitter.
export const lightVector = (v) => [v?.x ?? v?.[0] ?? 0, v?.y ?? v?.[1] ?? 0, v?.z ?? v?.[2] ?? 0];
export const lightTypeCode = (light) => light.type === 'directional' ? 1 : light.type === 'area-sample' ? 2 : 0;
export function expandLightSamples(lights) {
  return lights.filter(light => light.visible !== false).flatMap(light => {
    if (light.type !== 'area') return [light];
    const p = lightVector(light.position), u = lightVector(light.right), v = lightVector(light.up);
    return [[-1,-1], [1,-1], [-1,1], [1,1]].map(([x,y], i) => ({
      ...light, id: `${light.id}/sample-${i}`, type: 'area-sample', intensity: light.intensity / 4,
      position: p.map((c,a) => c + u[a]*x*light.width/4 + v[a]*y*light.height/4),
    }));
  });
}

// Every receiver is inside the root bounds. Twice its diagonal places each
// parallel ray origin outside the complete Gaussian support, without a huge
// arbitrary distant point (which would diverge and lose float32 precision).
export function directionalRayLength(bvh) {
  if (!bvh || bvh.root < 0) return 1;
  const o = bvh.root * 6, b = bvh.bounds;
  return Math.max(2 * Math.hypot(b[o+3]-b[o], b[o+4]-b[o+1], b[o+5]-b[o+2]), 1e-6);
}
export function directionalRayOrigin(bvh, receiverIndex, direction) {
  const d = lightVector(direction), norm = Math.hypot(...d);
  if (!(norm > 0) || !Number.isFinite(norm)) throw new Error('Directional light needs a finite nonzero direction');
  const length = directionalRayLength(bvh), o = receiverIndex * 3;
  return d.map((v,a) => bvh.center[o+a] - v/norm*length);
}
