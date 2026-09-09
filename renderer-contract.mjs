import { SPLAT_COLOR_SPACE, srgbToLinearChannel } from "./viewer-color.mjs";

/**
 * Renderer-neutral scene data for 3DGS Scene Lab.
 *
 * This module is deliberately Spark-free. Spark is used by the host only to
 * decode loaded files through SplatMesh#forEachSplat; alternate renderers
 * receive copied, typed-array data and never touch a Spark render path.
 */

export const LOOKDEV_LAB_NAME = "3DGS Scene Lab";
export const SH_C0 = 0.28209479177387814;

export const RENDERER_MANIFEST = Object.freeze({
  spark: Object.freeze({
    id: "spark",
    label: "Spark 2.1",
    summary: "Native Spark Gaussian renderer",
    capabilities: Object.freeze({
      gaussianRenderer: true,
      sh: "SH0–SH3 (source dependent)",
      directionalCaster: false,
      splatReceivesShadows: false,
      animation: "Spark object modifiers",
      lighting: "Existing Spark look-dev path",
    }),
  }),
  playcanvas: Object.freeze({
    id: "playcanvas",
    label: "PlayCanvas 2.22.0",
    summary: "PlayCanvas unified GSplat renderer",
    capabilities: Object.freeze({
      gaussianRenderer: true,
      sh: "SH0 base RGB snapshot",
      directionalCaster: false,
      splatReceivesShadows: false,
      animation: "Spark only",
      lighting: "CPU appearance snapshot with exposure, lights, bounce, and tone curve",
    }),
  }),
  "three-r186": Object.freeze({
    id: "three-r186",
    label: "Three.js r186",
    summary: "Official GaussianSplat / WebGPURenderer",
    capabilities: Object.freeze({
      gaussianRenderer: true,
      sh: "SH0 base RGB snapshot",
      directionalCaster: false,
      splatReceivesShadows: false,
      animation: "Spark only",
      lighting: "GPU appearance with exposure, direct lights, occlusion and tone curve; CPU compatibility for legacy previews",
    }),
  }),
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const copyVector3 = (target, offset, value) => {
  target[offset] = finite(value?.x);
  target[offset + 1] = finite(value?.y);
  target[offset + 2] = finite(value?.z);
};

const copyQuaternion = (target, offset, value) => {
  target[offset] = finite(value?.x);
  target[offset + 1] = finite(value?.y);
  target[offset + 2] = finite(value?.z);
  target[offset + 3] = finite(value?.w, 1);
};

const copyLinearRgb = (target, offset, value, colorSpace) => {
  const r = finite(value?.r ?? value?.x ?? value?.[0]);
  const g = finite(value?.g ?? value?.y ?? value?.[1]);
  const b = finite(value?.b ?? value?.z ?? value?.[2]);
  const linear = colorSpace === SPLAT_COLOR_SPACE.LINEAR;
  target[offset] = linear ? r : srgbToLinearChannel(r);
  target[offset + 1] = linear ? g : srgbToLinearChannel(g);
  target[offset + 2] = linear ? b : srgbToLinearChannel(b);
};

const copyAuthoredDiffuseAlbedo = (target, offset, value) => {
  target[offset] = finite(value?.r ?? value?.x ?? value?.[0]);
  target[offset + 1] = finite(value?.g ?? value?.y ?? value?.[1]);
  target[offset + 2] = finite(value?.b ?? value?.z ?? value?.[2]);
};

/**
 * Copy every SplatMesh through its public forEachSplat callback. Item world
 * matrices intentionally remain separate so alternate backends can retain the
 * host's per-item transform/visibility semantics without reading Spark state.
 */
export function createSceneSnapshot(sceneItems = [], {
  includeQuaternion = true,
  mapLinearRgb = null,
  visibleOnly = false,
} = {}) {
  const items = [];
  let totalSplats = 0;

  sceneItems.forEach((sceneItem, sceneItemIndex) => {
    const mesh = sceneItem?.mesh;
    if (!mesh?.forEachSplat) {
      return;
    }
    if (visibleOnly && !(sceneItem.visible && mesh.visible !== false)) {
      return;
    }
    const count = Math.max(0, Number(mesh.numSplats ?? mesh.packedSplats?.numSplats ?? 0));
    const center = new Float32Array(count * 3);
    const scale = new Float32Array(count * 3);
    const quaternion = includeQuaternion ? new Float32Array(count * 4) : null;
    const linearRgb = new Float32Array(count * 3);
    const opacity = new Float32Array(count);
    // Normal data is opt-in. Generic Gaussian orientations are covariance
    // ellipsoids, not surface normals, so only authored primitive metadata is
    // copied into this renderer-neutral contract.
    const normal = new Float32Array(count * 3);
    const hasAuthoredNormal = new Uint8Array(count);
    // Authored bounce material is intentionally separate from linearRgb:
    // generic loaded RGB is captured radiance and must never become albedo.
    const authoredDiffuseAlbedo = new Float32Array(count * 3);
    const authoredSurfaceArea = new Float32Array(count);
    const hasAuthoredBounceMaterial = new Uint8Array(count);
    const sourceIndex = new Uint32Array(count);
    const authoredEntries = Array.isArray(sceneItem.authoredNormalEntries)
      ? sceneItem.authoredNormalEntries
      : [];
    const authoredBounceMaterialEntries = Array.isArray(sceneItem.authoredBounceMaterialEntries)
      ? sceneItem.authoredBounceMaterialEntries
      : [];
    let copied = 0;

    mesh.forEachSplat((index, splatCenter, splatScale, splatQuaternion, splatOpacity, splatColor) => {
      const slot = Number.isInteger(index) && index >= 0 && index < count ? index : copied;
      if (slot >= count) {
        return;
      }
      copyVector3(center, slot * 3, splatCenter);
      copyVector3(scale, slot * 3, splatScale);
      if (quaternion) copyQuaternion(quaternion, slot * 4, splatQuaternion);
      copyLinearRgb(linearRgb, slot * 3, splatColor, sceneItem.sourceColorSpace);
      if (typeof mapLinearRgb === "function") {
        const offset = slot * 3;
        const mapped = mapLinearRgb({
          index: slot,
          linearRgb: [linearRgb[offset], linearRgb[offset + 1], linearRgb[offset + 2]],
          sceneItem,
          splatCenter,
          splatQuaternion,
          splatScale,
        });
        if (mapped) {
          linearRgb[offset] = finite(mapped[0], linearRgb[offset]);
          linearRgb[offset + 1] = finite(mapped[1], linearRgb[offset + 1]);
          linearRgb[offset + 2] = finite(mapped[2], linearRgb[offset + 2]);
        }
      }
      opacity[slot] = finite(splatOpacity, 1);
      sourceIndex[slot] = slot;
      const authoredNormal = authoredEntries[slot]?.normal;
      if (authoredNormal) {
        copyVector3(normal, slot * 3, authoredNormal);
        hasAuthoredNormal[slot] = 1;
      }
      const material = authoredBounceMaterialEntries[slot];
      const surfaceArea = finite(material?.authoredSurfaceArea, 0);
      if (material?.authoredDiffuseAlbedo && surfaceArea > 0 && authoredNormal) {
        copyAuthoredDiffuseAlbedo(authoredDiffuseAlbedo, slot * 3, material.authoredDiffuseAlbedo);
        authoredSurfaceArea[slot] = surfaceArea;
        hasAuthoredBounceMaterial[slot] = 1;
      }
      copied = Math.max(copied, slot + 1);
    });

    const matrix = sceneItem.mesh.matrixWorld?.elements ?? sceneItem.rotationPivot?.matrixWorld?.elements;
    const worldMatrix = new Float32Array(16);
    if (matrix?.length === 16) {
      worldMatrix.set(matrix);
    } else {
      worldMatrix.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    }
    const actualCount = Math.min(copied, count);
    items.push({
      id: String(sceneItem.id ?? `snapshot-item-${items.length + 1}`),
      name: String(sceneItem.modelMeta?.name ?? mesh.name ?? "Splat item"),
      center: actualCount === count ? center : center.slice(0, actualCount * 3),
      scale: actualCount === count ? scale : scale.slice(0, actualCount * 3),
      quaternion: quaternion && (actualCount === count ? quaternion : quaternion.slice(0, actualCount * 4)),
      linearRgb: actualCount === count ? linearRgb : linearRgb.slice(0, actualCount * 3),
      opacity: actualCount === count ? opacity : opacity.slice(0, actualCount),
      normal: actualCount === count ? normal : normal.slice(0, actualCount * 3),
      hasAuthoredNormal: actualCount === count ? hasAuthoredNormal : hasAuthoredNormal.slice(0, actualCount),
      authoredDiffuseAlbedo: actualCount === count ? authoredDiffuseAlbedo : authoredDiffuseAlbedo.slice(0, actualCount * 3),
      authoredSurfaceArea: actualCount === count ? authoredSurfaceArea : authoredSurfaceArea.slice(0, actualCount),
      hasAuthoredBounceMaterial: actualCount === count ? hasAuthoredBounceMaterial : hasAuthoredBounceMaterial.slice(0, actualCount),
      sourceIndex: actualCount === count ? sourceIndex : sourceIndex.slice(0, actualCount),
      stableItemIndex: sceneItemIndex,
      worldMatrix,
      visible: Boolean(sceneItem.visible && mesh.visible !== false),
      opacityMultiplier: finite(sceneItem.settings?.opacity, 1),
    });
    totalSplats += actualCount;
  });

  return Object.freeze({
    version: 1,
    items: Object.freeze(items),
    splatCount: totalSplats,
  });
}

export function decomposeWorldMatrix(matrix) {
  const m = matrix?.length === 16 ? matrix : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const sx = Math.hypot(m[0], m[1], m[2]) || 1;
  const sy = Math.hypot(m[4], m[5], m[6]) || 1;
  const sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const m00 = m[0] / sx;
  const m01 = m[4] / sy;
  const m02 = m[8] / sz;
  const m10 = m[1] / sx;
  const m11 = m[5] / sy;
  const m12 = m[9] / sz;
  const m20 = m[2] / sx;
  const m21 = m[6] / sy;
  const m22 = m[10] / sz;
  const trace = m00 + m11 + m22;
  let x;
  let y;
  let z;
  let w;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return {
    position: [m[12], m[13], m[14]],
    quaternion: [x, y, z, w],
    scale: [sx, sy, sz],
  };
}

const transformNormal = (matrix, x, y, z) => {
  const a = matrix[0]; const b = matrix[4]; const c = matrix[8];
  const d = matrix[1]; const e = matrix[5]; const f = matrix[9];
  const g = matrix[2]; const h = matrix[6]; const i = matrix[10];
  const determinant = (a * ((e * i) - (f * h))) - (b * ((d * i) - (f * g))) + (c * ((d * h) - (e * g)));
  if (!Number.isFinite(determinant) || Math.abs(determinant) < Number.EPSILON) return [0, 0, 0];
  const nx = (((e * i) - (f * h)) * x) + (((f * g) - (d * i)) * y) + (((d * h) - (e * g)) * z);
  const ny = (((c * h) - (b * i)) * x) + (((a * i) - (c * g)) * y) + (((b * g) - (a * h)) * z);
  const nz = (((b * f) - (c * e)) * x) + (((c * d) - (a * f)) * y) + (((a * e) - (b * d)) * z);
  const length = Math.hypot(nx, ny, nz);
  return length > Number.EPSILON
    ? [nx / length, ny / length, nz / length]
    : [0, 0, 0];
};

// For a local differential area with unit normal n, |cofactor(A) n| equals
// |det(A)| * |A^-T n|.  This handles both uniform and non-uniform world scale
// without using a covariance radius as a physical surface area.
const transformSurfaceArea = (matrix, x, y, z, area) => {
  const a = matrix[0]; const b = matrix[4]; const c = matrix[8];
  const d = matrix[1]; const e = matrix[5]; const f = matrix[9];
  const g = matrix[2]; const h = matrix[6]; const i = matrix[10];
  const determinant = (a * ((e * i) - (f * h))) - (b * ((d * i) - (f * g))) + (c * ((d * h) - (e * g)));
  const localArea = Math.max(finite(area), 0);
  if (!(localArea > 0) || !Number.isFinite(determinant) || Math.abs(determinant) < Number.EPSILON) return 0;
  const normalLength = Math.hypot(x, y, z);
  if (!(normalLength > Number.EPSILON)) return 0;
  const unitX = x / normalLength;
  const unitY = y / normalLength;
  const unitZ = z / normalLength;
  const nx = (((e * i) - (f * h)) * unitX) + (((f * g) - (d * i)) * unitY) + (((d * h) - (e * g)) * unitZ);
  // These cofactor rows intentionally match transformNormal() above.
  const ny = (((c * h) - (b * i)) * unitX) + (((a * i) - (c * g)) * unitY) + (((b * g) - (a * h)) * unitZ);
  const nz = (((b * f) - (c * e)) * unitX) + (((c * d) - (a * f)) * unitY) + (((a * e) - (b * d)) * unitZ);
  const jacobian = Math.hypot(nx, ny, nz);
  return Number.isFinite(jacobian) ? localArea * jacobian : 0;
};

const hasUnsupportedStaticBakeTransform = (matrix) => {
  const x = [matrix[0], matrix[1], matrix[2]];
  const y = [matrix[4], matrix[5], matrix[6]];
  const z = [matrix[8], matrix[9], matrix[10]];
  const determinant = (x[0] * ((y[1] * z[2]) - (y[2] * z[1])))
    - (y[0] * ((x[1] * z[2]) - (x[2] * z[1])))
    + (z[0] * ((x[1] * y[2]) - (x[2] * y[1])));
  const sx = Math.hypot(...x);
  const sy = Math.hypot(...y);
  const sz = Math.hypot(...z);
  const maxScale = Math.max(sx, sy, sz);
  const minScale = Math.min(sx, sy, sz);
  const scaleTolerance = Math.max(maxScale, 1) * 1e-5;
  // A mirrored transform needs an orientation policy that the live Spark and
  // static-bake paths do not currently share. Reject it rather than silently
  // baking a surface with its normal facing the opposite direction.
  if (!Number.isFinite(determinant) || determinant <= Number.EPSILON) return true;
  if (!Number.isFinite(maxScale) || !(minScale > Number.EPSILON) || maxScale - minScale > scaleTolerance) return true;
  const shearTolerance = Math.max(sx * sy, sx * sz, sy * sz, 1) * 1e-5;
  const dotXY = (x[0] * y[0]) + (x[1] * y[1]) + (x[2] * y[2]);
  const dotXZ = (x[0] * z[0]) + (x[1] * z[1]) + (x[2] * z[2]);
  const dotYZ = (y[0] * z[0]) + (y[1] * z[1]) + (y[2] * z[2]);
  return Math.abs(dotXY) > shearTolerance || Math.abs(dotXZ) > shearTolerance || Math.abs(dotYZ) > shearTolerance;
};

/**
 * Write the symmetric world covariance C = A R_local diag(scale^2) R_local^T A^T.
 *
 * `matrix` is a Three-style column-major Matrix4.elements array, so its 3x3
 * linear block A uses columns [0..2], [4..6], and [8..10].  The output packs
 * [Cxx, Cyy, Czz] and [Cxy, Cxz, Cyz], respectively.  This remains exact for
 * non-uniform scale, shear, and reflection because it does not decompose A.
 */
const writeWorldCovariance = (
  matrix,
  quaternion,
  quaternionOffset,
  scale,
  scaleOffset,
  diagonal,
  offDiagonal,
  output,
) => {
  let x = finite(quaternion?.[quaternionOffset]);
  let y = finite(quaternion?.[quaternionOffset + 1]);
  let z = finite(quaternion?.[quaternionOffset + 2]);
  let w = finite(quaternion?.[quaternionOffset + 3], 1);
  const quaternionLengthSquared = (x * x) + (y * y) + (z * z) + (w * w);
  if (!(quaternionLengthSquared > Number.EPSILON) || !Number.isFinite(quaternionLengthSquared)) {
    x = 0;
    y = 0;
    z = 0;
    w = 1;
  } else {
    const inverseLength = 1 / Math.sqrt(quaternionLengthSquared);
    x *= inverseLength;
    y *= inverseLength;
    z *= inverseLength;
    w *= inverseLength;
  }

  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const r00 = 1 - (yy + zz);
  const r01 = xy - wz;
  const r02 = xz + wy;
  const r10 = xy + wz;
  const r11 = 1 - (xx + zz);
  const r12 = yz - wx;
  const r20 = xz - wy;
  const r21 = yz + wx;
  const r22 = 1 - (xx + yy);

  const a00 = finite(matrix?.[0]); const a01 = finite(matrix?.[4]); const a02 = finite(matrix?.[8]);
  const a10 = finite(matrix?.[1]); const a11 = finite(matrix?.[5]); const a12 = finite(matrix?.[9]);
  const a20 = finite(matrix?.[2]); const a21 = finite(matrix?.[6]); const a22 = finite(matrix?.[10]);
  const sx = finite(scale?.[scaleOffset]);
  const sy = finite(scale?.[scaleOffset + 1]);
  const sz = finite(scale?.[scaleOffset + 2]);
  const axis0x = ((a00 * r00) + (a01 * r10) + (a02 * r20)) * sx;
  const axis0y = ((a10 * r00) + (a11 * r10) + (a12 * r20)) * sx;
  const axis0z = ((a20 * r00) + (a21 * r10) + (a22 * r20)) * sx;
  const axis1x = ((a00 * r01) + (a01 * r11) + (a02 * r21)) * sy;
  const axis1y = ((a10 * r01) + (a11 * r11) + (a12 * r21)) * sy;
  const axis1z = ((a20 * r01) + (a21 * r11) + (a22 * r21)) * sy;
  const axis2x = ((a00 * r02) + (a01 * r12) + (a02 * r22)) * sz;
  const axis2y = ((a10 * r02) + (a11 * r12) + (a12 * r22)) * sz;
  const axis2z = ((a20 * r02) + (a21 * r12) + (a22 * r22)) * sz;
  const output3 = output * 3;
  diagonal[output3] = finite((axis0x * axis0x) + (axis1x * axis1x) + (axis2x * axis2x));
  diagonal[output3 + 1] = finite((axis0y * axis0y) + (axis1y * axis1y) + (axis2y * axis2y));
  diagonal[output3 + 2] = finite((axis0z * axis0z) + (axis1z * axis1z) + (axis2z * axis2z));
  offDiagonal[output3] = finite((axis0x * axis0y) + (axis1x * axis1y) + (axis2x * axis2y));
  offDiagonal[output3 + 1] = finite((axis0x * axis0z) + (axis1x * axis1z) + (axis2x * axis2z));
  offDiagonal[output3 + 2] = finite((axis0y * axis0z) + (axis1y * axis1z) + (axis2y * axis2z));
};

const writeSnapshotItemTransform = (item, index, target, output, transform = decomposeWorldMatrix(item.worldMatrix)) => {
  const centerOffset = index * 3;
  const quaternionOffset = index * 4;
  const output3 = output * 3;
  const x = item.center[centerOffset];
  const y = item.center[centerOffset + 1];
  const z = item.center[centerOffset + 2];
  const matrix = item.worldMatrix;
  target.center[output3] = (matrix[0] * x) + (matrix[4] * y) + (matrix[8] * z) + matrix[12];
  target.center[output3 + 1] = (matrix[1] * x) + (matrix[5] * y) + (matrix[9] * z) + matrix[13];
  target.center[output3 + 2] = (matrix[2] * x) + (matrix[6] * y) + (matrix[10] * z) + matrix[14];
  target.scale[output3] = item.scale[centerOffset] * transform.scale[0];
  target.scale[output3 + 1] = item.scale[centerOffset + 1] * transform.scale[1];
  target.scale[output3 + 2] = item.scale[centerOffset + 2] * transform.scale[2];
  if (target.quaternion) {
    const localX = finite(item.quaternion?.[quaternionOffset]);
    const localY = finite(item.quaternion?.[quaternionOffset + 1]);
    const localZ = finite(item.quaternion?.[quaternionOffset + 2]);
    const localW = finite(item.quaternion?.[quaternionOffset + 3], 1);
    const output4 = output * 4;
    target.quaternion[output4] = (transform.quaternion[3] * localX) + (transform.quaternion[0] * localW) + (transform.quaternion[1] * localZ) - (transform.quaternion[2] * localY);
    target.quaternion[output4 + 1] = (transform.quaternion[3] * localY) - (transform.quaternion[0] * localZ) + (transform.quaternion[1] * localW) + (transform.quaternion[2] * localX);
    target.quaternion[output4 + 2] = (transform.quaternion[3] * localZ) + (transform.quaternion[0] * localY) - (transform.quaternion[1] * localX) + (transform.quaternion[2] * localW);
    target.quaternion[output4 + 3] = (transform.quaternion[3] * localW) - (transform.quaternion[0] * localX) - (transform.quaternion[1] * localY) - (transform.quaternion[2] * localZ);
  }
  if (target.covarianceDiagonal && target.covarianceOffDiagonal) {
    writeWorldCovariance(
      matrix,
      item.quaternion,
      quaternionOffset,
      item.scale,
      centerOffset,
      target.covarianceDiagonal,
      target.covarianceOffDiagonal,
      output,
    );
  }
  target.normal[output3] = 0;
  target.normal[output3 + 1] = 0;
  target.normal[output3 + 2] = 0;
  target.hasAuthoredNormal[output] = 0;
  target.authoredSurfaceArea[output] = 0;
  target.hasAuthoredBounceMaterial[output] = 0;
  if (item.hasAuthoredNormal?.[index]) {
    const transformed = transformNormal(
      matrix,
      item.normal[centerOffset],
      item.normal[centerOffset + 1],
      item.normal[centerOffset + 2],
    );
    target.normal.set(transformed, output3);
    target.hasAuthoredNormal[output] = transformed[0] || transformed[1] || transformed[2] ? 1 : 0;
  }
  if (item.hasAuthoredBounceMaterial?.[index] && target.hasAuthoredNormal[output]) {
    const worldArea = transformSurfaceArea(
      matrix,
      item.normal[centerOffset],
      item.normal[centerOffset + 1],
      item.normal[centerOffset + 2],
      item.authoredSurfaceArea?.[index],
    );
    if (worldArea > 0) {
      target.authoredDiffuseAlbedo.set(item.authoredDiffuseAlbedo.subarray(centerOffset, centerOffset + 3), output3);
      target.authoredSurfaceArea[output] = worldArea;
      target.hasAuthoredBounceMaterial[output] = 1;
    }
  }
};

/** Convert per-item local arrays into one world-space typed-array draw stream. */
export function flattenVisibleSnapshot(snapshot, {
  includeQuaternion = true,
  includeCovariance = false,
} = {}) {
  const count = snapshot?.items?.reduce((sum, item) => sum + (item.visible ? item.opacity.length : 0), 0) ?? 0;
  const center = new Float32Array(count * 3);
  const scale = new Float32Array(count * 3);
  const quaternion = includeQuaternion ? new Float32Array(count * 4) : null;
  const covarianceDiagonal = includeCovariance ? new Float32Array(count * 3) : null;
  const covarianceOffDiagonal = includeCovariance ? new Float32Array(count * 3) : null;
  const linearRgb = new Float32Array(count * 3);
  const opacity = new Float32Array(count);
  const normal = new Float32Array(count * 3);
  const hasAuthoredNormal = new Uint8Array(count);
  const authoredDiffuseAlbedo = new Float32Array(count * 3);
  const authoredSurfaceArea = new Float32Array(count);
  const hasAuthoredBounceMaterial = new Uint8Array(count);
  const itemIndex = new Uint32Array(count);
  const sourceIndex = new Uint32Array(count);
  const itemIds = [];
  const transformTarget = {
    authoredDiffuseAlbedo,
    authoredSurfaceArea,
    center,
    hasAuthoredBounceMaterial,
    hasAuthoredNormal,
    normal,
    quaternion,
    scale,
  };
  if (includeCovariance) {
    transformTarget.covarianceDiagonal = covarianceDiagonal;
    transformTarget.covarianceOffDiagonal = covarianceOffDiagonal;
  }
  let unsupportedStaticBakeTransformCount = 0;
  let output = 0;
  snapshot?.items?.forEach((item, fallbackItemIndex) => {
    if (!item.visible) {
      return;
    }
    itemIds[Number.isFinite(item.stableItemIndex) ? item.stableItemIndex : fallbackItemIndex] = item.id;
    if (hasUnsupportedStaticBakeTransform(item.worldMatrix)) unsupportedStaticBakeTransformCount += 1;
    const transform = decomposeWorldMatrix(item.worldMatrix);
    for (let index = 0; index < item.opacity.length; index += 1) {
      const centerOffset = index * 3;
      writeSnapshotItemTransform(item, index, transformTarget, output, transform);
      linearRgb.set(item.linearRgb.subarray(centerOffset, centerOffset + 3), output * 3);
      opacity[output] = Math.max(0, item.opacity[index] * item.opacityMultiplier);
      itemIndex[output] = Number.isFinite(item.stableItemIndex) ? item.stableItemIndex : fallbackItemIndex;
      sourceIndex[output] = item.sourceIndex?.[index] ?? index;
      output += 1;
    }
  });
  const flat = {
    center,
    count,
    authoredDiffuseAlbedo,
    authoredSurfaceArea,
    hasAuthoredBounceMaterial,
    hasAuthoredNormal,
    itemIds: Object.freeze(itemIds),
    itemIndex,
    linearRgb,
    normal,
    opacity,
    quaternion,
    scale,
    sourceIndex,
    unsupportedStaticBakeTransformCount,
  };
  if (includeCovariance) {
    flat.covarianceDiagonal = covarianceDiagonal;
    flat.covarianceOffDiagonal = covarianceOffDiagonal;
  }
  return Object.freeze(flat);
}

/**
 * Update only transform-derived flat arrays for live alternate-renderer edits.
 * Source colors, opacity, provenance, and stable indices remain untouched.
 */
export function updateFlattenedSnapshotItemTransforms(snapshot, flat, updates = []) {
  if (!snapshot?.items || !flat?.center || !Array.isArray(updates) || !updates.length) return flat;
  const byId = new Map(updates.map((entry) => [String(entry?.id ?? ""), entry?.worldMatrix]));
  let output = 0;
  let changed = false;
  snapshot.items.forEach((item) => {
    const nextMatrix = byId.get(item.id);
    let itemChanged = false;
    if (nextMatrix?.length === 16) {
      itemChanged = nextMatrix.some((value, index) => Number(value) !== item.worldMatrix[index]);
      if (itemChanged) {
        item.worldMatrix.set(nextMatrix);
        changed = true;
      }
    }
    if (!item.visible) return;
    if (itemChanged) {
      const transform = decomposeWorldMatrix(item.worldMatrix);
      for (let index = 0; index < item.opacity.length; index += 1) {
        writeSnapshotItemTransform(item, index, flat, output + index, transform);
      }
    }
    output += item.opacity.length;
  });
  if (!changed) return flat;
  const unsupportedStaticBakeTransformCount = snapshot.items.reduce(
    (total, item) => total + (item.visible && hasUnsupportedStaticBakeTransform(item.worldMatrix) ? 1 : 0),
    0,
  );
  return Object.freeze({ ...flat, unsupportedStaticBakeTransformCount });
}
