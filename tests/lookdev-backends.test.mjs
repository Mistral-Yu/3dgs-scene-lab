import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  LOOKDEV_LAB_NAME,
  RENDERER_MANIFEST,
  createSceneSnapshot,
  flattenVisibleSnapshot,
  updateFlattenedSnapshotItemTransforms,
} from "../renderer-contract.mjs";
import { bakeAllSplatsDirectLight } from "../viewer-static-lighting.mjs";
import { BACKEND_VENDOR_DEFINITIONS, LookDevBackendManager, loadBackendVendor } from "../viewer-backends.mjs";

const read = (fileName) => readFileSync(new URL(`../${fileName}`, import.meta.url), "utf8");

const assertArrayNear = (actual, expected, tolerance = 1e-5) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(
      Math.abs(value - expected[index]) <= tolerance,
      `index ${index}: expected ${expected[index]}, received ${value}`,
    );
  });
};

const identityMatrix = () => [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

const makeCovarianceSceneItem = ({
  id = "covariance-item",
  matrix = identityMatrix(),
  quaternion = [0, 0, 0, 1],
  scale = [1, 1, 1],
  color = { r: 0.2, g: 0.3, b: 0.4 },
} = {}) => ({
  id,
  mesh: {
    numSplats: 1,
    matrixWorld: { elements: matrix },
    forEachSplat(callback) {
      callback(
        0,
        { x: 0, y: 0, z: 0 },
        { x: scale[0], y: scale[1], z: scale[2] },
        { x: quaternion[0], y: quaternion[1], z: quaternion[2], w: quaternion[3] },
        1,
        color,
      );
    },
  },
  visible: true,
});

test("renderer contract copies every Spark-style callback into typed snapshot arrays", () => {
  const mesh = {
    visible: true,
    numSplats: 2,
    matrixWorld: {
      elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1],
    },
    forEachSplat(callback) {
      callback(0, { x: 1, y: 2, z: 3 }, { x: 0.1, y: 0.2, z: 0.3 }, { x: 0, y: 0, z: 0, w: 1 }, 0.75, { r: 0.2, g: 0.3, b: 0.4 });
      callback(1, { x: -1, y: 0, z: 1 }, { x: 0.4, y: 0.5, z: 0.6 }, { x: 0, y: 0, z: 0, w: 1 }, 0.5, { r: 0.8, g: 0.7, b: 0.6 });
    },
  };
  const snapshot = createSceneSnapshot([{
    id: "item-a",
    mesh,
    modelMeta: { name: "A" },
    settings: { opacity: 0.5 },
    visible: true,
  }]);

  assert.equal(snapshot.splatCount, 2);
  assert.ok(snapshot.items[0].center instanceof Float32Array);
  assert.ok(snapshot.items[0].quaternion instanceof Float32Array);
  assert.deepEqual([...snapshot.items[0].center], [1, 2, 3, -1, 0, 1]);
  assert.deepEqual([...snapshot.items[0].opacity], [0.75, 0.5]);
  assert.equal(snapshot.items[0].worldMatrix[12], 3);
  assert.equal(snapshot.items[0].visible, true);

  const flat = flattenVisibleSnapshot(snapshot);
  assert.deepEqual([...flat.center], [4, 6, 8, 2, 4, 6]);
  assert.deepEqual([...flat.opacity], [0.375, 0.25]);
  assert.deepEqual([...flat.sourceIndex], [0, 1]);
  assert.deepEqual([...flat.itemIndex], [0, 0]);
  assert.deepEqual([...flat.hasAuthoredNormal], [0, 0]);
});

test("static snapshots skip hidden source allocation and can omit render-only quaternions", () => {
  let hiddenReads = 0;
  const makeMesh = (x, onRead = () => {}) => ({
    visible: true,
    numSplats: 1,
    matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    forEachSplat(callback) {
      onRead();
      callback(0, { x, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0, w: 1 }, 1, { r: 0.2, g: 0.3, b: 0.4 });
    },
  });
  const snapshot = createSceneSnapshot([
    { id: "hidden", mesh: makeMesh(1, () => { hiddenReads += 1; }), visible: false },
    { id: "visible", mesh: makeMesh(2), visible: true },
  ], { includeQuaternion: false, visibleOnly: true });
  const flat = flattenVisibleSnapshot(snapshot, { includeQuaternion: false });
  assert.equal(hiddenReads, 0);
  assert.equal(snapshot.splatCount, 1);
  assert.equal(snapshot.items[0].stableItemIndex, 1);
  assert.equal(snapshot.items[0].quaternion, null);
  assert.equal(flat.quaternion, null);
  assert.deepEqual([...flat.itemIndex], [1]);
  assert.equal(flat.itemIds[1], "visible");
});

test("world covariance is opt-in and preserves identity and uniform-transform parity", () => {
  // The covariance path normalizes this intentionally non-unit local quaternion.
  const localRz90 = [0, 0, 2 * Math.SQRT1_2, 2 * Math.SQRT1_2];
  const snapshot = createSceneSnapshot([makeCovarianceSceneItem({
    quaternion: localRz90,
    scale: [1, 2, 3],
  })]);
  const defaultFlat = flattenVisibleSnapshot(snapshot);
  const identityFlat = flattenVisibleSnapshot(snapshot, { includeQuaternion: false, includeCovariance: true });
  const uniformFlat = flattenVisibleSnapshot(createSceneSnapshot([makeCovarianceSceneItem({
    matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
    quaternion: localRz90,
    scale: [1, 2, 3],
  })]), { includeQuaternion: false, includeCovariance: true });

  assert.equal(defaultFlat.covarianceDiagonal, undefined);
  assert.equal(defaultFlat.covarianceOffDiagonal, undefined);
  assert.equal(identityFlat.quaternion, null);
  assertArrayNear(identityFlat.covarianceDiagonal, [4, 1, 9]);
  assertArrayNear(identityFlat.covarianceOffDiagonal, [0, 0, 0]);
  assertArrayNear(uniformFlat.covarianceDiagonal, [16, 4, 36]);
  assertArrayNear(uniformFlat.covarianceOffDiagonal, [0, 0, 0]);
});

test("world covariance keeps rotated local anisotropy under non-uniform world scale", () => {
  const flat = flattenVisibleSnapshot(createSceneSnapshot([makeCovarianceSceneItem({
    matrix: [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1],
    quaternion: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    scale: [1, 2, 3],
  })]), { includeQuaternion: false, includeCovariance: true });

  // A * Rz(90deg) * diag(1, 2, 3)^2 * Rz(90deg)^T * A^T.
  // Independent scale/quaternion flattening incorrectly produces [36, 4, 144].
  assertArrayNear(flat.covarianceDiagonal, [16, 9, 144]);
  assertArrayNear(flat.covarianceOffDiagonal, [0, 0, 0]);
});

test("world covariance retains shear and reflection terms from the full world linear matrix", () => {
  const flat = flattenVisibleSnapshot(createSceneSnapshot([makeCovarianceSceneItem({
    // A maps (x, y, z) to (-2x + y, 3y, 4z): both reflected and sheared.
    matrix: [-2, 0, 0, 0, 1, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1],
    scale: [1, 2, 3],
  })]), { includeQuaternion: false, includeCovariance: true });

  assertArrayNear(flat.covarianceDiagonal, [8, 36, 144]);
  assertArrayNear(flat.covarianceOffDiagonal, [12, 0, 0]);
});

test("world covariance normalizes local quaternions and falls back to identity for a degenerate one", () => {
  const flat = flattenVisibleSnapshot(createSceneSnapshot([makeCovarianceSceneItem({
    matrix: [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1],
    quaternion: [0, 0, 0, 0],
    scale: [1, 2, 3],
  })]), { includeQuaternion: false, includeCovariance: true });

  assert.ok([...flat.covarianceDiagonal, ...flat.covarianceOffDiagonal].every(Number.isFinite));
  assertArrayNear(flat.covarianceDiagonal, [4, 36, 144]);
  assertArrayNear(flat.covarianceOffDiagonal, [0, 0, 0]);
});

test("incremental covariance updates reuse buffers and preserve unrelated flat data", () => {
  const snapshot = createSceneSnapshot([
    makeCovarianceSceneItem({ id: "first", scale: [1, 2, 3], color: { r: 0.2, g: 0.3, b: 0.4 } }),
    makeCovarianceSceneItem({ id: "second", scale: [4, 5, 6], color: { r: 0.6, g: 0.7, b: 0.8 } }),
  ]);
  const flat = flattenVisibleSnapshot(snapshot, { includeQuaternion: false, includeCovariance: true });
  const diagonalBuffer = flat.covarianceDiagonal;
  const offDiagonalBuffer = flat.covarianceOffDiagonal;
  const linearRgbBefore = [...flat.linearRgb];
  const opacityBefore = [...flat.opacity];
  const secondDiagonalBefore = [...flat.covarianceDiagonal.subarray(3)];
  const secondOffDiagonalBefore = [...flat.covarianceOffDiagonal.subarray(3)];
  const updated = updateFlattenedSnapshotItemTransforms(snapshot, flat, [{
    id: "first",
    worldMatrix: [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1],
  }]);

  assert.notEqual(updated, flat);
  assert.equal(updated.covarianceDiagonal, diagonalBuffer);
  assert.equal(updated.covarianceOffDiagonal, offDiagonalBuffer);
  assertArrayNear(updated.covarianceDiagonal.subarray(0, 3), [4, 36, 144]);
  assert.deepEqual([...updated.covarianceDiagonal.subarray(3)], secondDiagonalBefore);
  assert.deepEqual([...updated.covarianceOffDiagonal.subarray(3)], secondOffDiagonalBefore);
  assert.deepEqual([...updated.linearRgb], linearRgbBefore);
  assert.deepEqual([...updated.opacity], opacityBefore);
});

test("incremental flat transform updates only transform-derived arrays for the changed item", () => {
  const makeItem = (id, x, color) => ({
    id,
    mesh: {
      visible: true,
      numSplats: 1,
      matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      forEachSplat(callback) {
        callback(0, { x, y: 0, z: 0 }, { x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0, w: 1 }, 0.75, color);
      },
    },
    visible: true,
  });
  const snapshot = createSceneSnapshot([
    makeItem("first", 1, { r: 0.2, g: 0.3, b: 0.4 }),
    makeItem("second", 5, { r: 0.6, g: 0.7, b: 0.8 }),
  ]);
  const flat = flattenVisibleSnapshot(snapshot);
  const rgbBefore = [...flat.linearRgb];
  const opacityBefore = [...flat.opacity];
  const sourceBefore = [...flat.sourceIndex];
  const updated = updateFlattenedSnapshotItemTransforms(snapshot, flat, [{
    id: "first",
    worldMatrix: [0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 10, 0, 0, 1],
  }]);
  assert.notEqual(updated, flat);
  assert.deepEqual([...updated.center], [10, 2, 0, 5, 0, 0]);
  assert.deepEqual([...updated.scale], [2, 4, 6, 1, 2, 3]);
  assert.ok(Math.abs(updated.quaternion[2] - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(updated.quaternion[3] - Math.SQRT1_2) < 1e-6);
  assert.deepEqual([...updated.linearRgb], rgbBefore);
  assert.deepEqual([...updated.opacity], opacityBefore);
  assert.deepEqual([...updated.sourceIndex], sourceBefore);
  assert.equal(updateFlattenedSnapshotItemTransforms(snapshot, updated, [{ id: "first", worldMatrix: snapshot.items[0].worldMatrix }]), updated);
});

test("renderer contract forwards authored primitive normals without inferring covariance normals", () => {
  const mesh = {
    numSplats: 1,
    forEachSplat(callback) {
      callback(0, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0, w: 1 }, 1, { r: 0.2, g: 0.3, b: 0.4 });
    },
  };
  const snapshot = createSceneSnapshot([{
    authoredNormalEntries: [{ normal: { x: 0, y: 1, z: 0 } }],
    id: "primitive",
    mesh,
    visible: true,
  }]);
  const flat = flattenVisibleSnapshot(snapshot);
  assert.deepEqual([...flat.hasAuthoredNormal], [1]);
  assert.deepEqual([...flat.normal], [0, 1, 0]);
  assert.deepEqual(flat.itemIds, ["primitive"]);
});

test("renderer contract carries explicit authored bounce provenance and transforms its area with the normal-aware Jacobian", () => {
  const mesh = {
    numSplats: 1,
    matrixWorld: {
      // Non-uniform scale (2, 3, 4): a local +Z patch has world area 2 * 3.
      elements: [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1],
    },
    forEachSplat(callback) {
      callback(0, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0, w: 1 }, 1, { r: 0.9, g: 0.1, b: 0.2 });
    },
  };
  const flat = flattenVisibleSnapshot(createSceneSnapshot([{
    authoredBounceMaterialEntries: [{ authoredDiffuseAlbedo: [0.25, 0.5, 0.75], authoredSurfaceArea: 2 }],
    authoredNormalEntries: [{ normal: { x: 0, y: 0, z: 1 } }],
    id: "authored-surface",
    mesh,
    visible: true,
  }]));
  assert.deepEqual([...flat.hasAuthoredBounceMaterial], [1]);
  assert.deepEqual([...flat.authoredDiffuseAlbedo], [0.25, 0.5, 0.75]);
  assert.equal(flat.authoredSurfaceArea[0], 12);
  assert.notDeepEqual([...flat.authoredDiffuseAlbedo], [...flat.linearRgb]);
});

test("renderer contract matches tangent-cross area under arbitrary rotation and non-uniform scale", () => {
  const angle = 0.37;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const matrix = [
    2 * cosine, 2 * sine, 0, 0,
    -3 * sine, 3 * cosine, 0, 0,
    0, 0, 4, 0,
    0, 0, 0, 1,
  ];
  const normal = [1, 2, 3];
  const normalLength = Math.hypot(...normal);
  const unitNormal = normal.map((value) => value / normalLength);
  const tangentU = [-2 / Math.sqrt(5), 1 / Math.sqrt(5), 0];
  const tangentV = [
    (unitNormal[1] * tangentU[2]) - (unitNormal[2] * tangentU[1]),
    (unitNormal[2] * tangentU[0]) - (unitNormal[0] * tangentU[2]),
    (unitNormal[0] * tangentU[1]) - (unitNormal[1] * tangentU[0]),
  ];
  const transformVector = (vector) => [
    (matrix[0] * vector[0]) + (matrix[4] * vector[1]) + (matrix[8] * vector[2]),
    (matrix[1] * vector[0]) + (matrix[5] * vector[1]) + (matrix[9] * vector[2]),
    (matrix[2] * vector[0]) + (matrix[6] * vector[1]) + (matrix[10] * vector[2]),
  ];
  const worldU = transformVector(tangentU);
  const worldV = transformVector(tangentV);
  const cross = [
    (worldU[1] * worldV[2]) - (worldU[2] * worldV[1]),
    (worldU[2] * worldV[0]) - (worldU[0] * worldV[2]),
    (worldU[0] * worldV[1]) - (worldU[1] * worldV[0]),
  ];
  const expectedArea = Math.hypot(...cross);
  const mesh = {
    numSplats: 1,
    matrixWorld: { elements: matrix },
    forEachSplat(callback) {
      callback(0, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0, w: 1 }, 1, { r: 0.1, g: 0.2, b: 0.3 });
    },
  };
  const flat = flattenVisibleSnapshot(createSceneSnapshot([{
    authoredBounceMaterialEntries: [{ authoredDiffuseAlbedo: [0.2, 0.3, 0.4], authoredSurfaceArea: 1 }],
    authoredNormalEntries: [{ normal: { x: normal[0], y: normal[1], z: normal[2] } }],
    id: "rotated-authored-surface",
    mesh,
    visible: true,
  }]));
  assert.ok(Math.abs(flat.authoredSurfaceArea[0] - expectedArea) < 1e-5);
  assert.equal(flat.unsupportedStaticBakeTransformCount, 1);
});

test("static bake rejects rotated anisotropic world transforms before BVH construction", () => {
  const mesh = {
    numSplats: 1,
    // diag(100, 1, 1) * Rz(90deg) * diag(.01, 1, 1)
    matrixWorld: { elements: [0, 0.01, 0, 0, -100, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    forEachSplat(callback) {
      callback(0, { x: 0, y: 0, z: 0 }, { x: 0.1, y: 0.1, z: 0.1 }, { x: 0, y: 0, z: 0, w: 1 }, 1, { r: 0.2, g: 0.3, b: 0.4 });
    },
  };
  const flat = flattenVisibleSnapshot(createSceneSnapshot([{
    id: "anisotropic-rotation",
    mesh,
    visible: true,
  }]));
  assert.equal(flat.unsupportedStaticBakeTransformCount, 1);
  assert.throws(
    () => bakeAllSplatsDirectLight({ light: { color: [1, 1, 1], intensity: 1, position: [1, 0, 0] }, snapshot: flat }),
    /non-uniform, sheared, or mirrored world transform/,
  );
});

test("static bake rejects mirrored transforms instead of flipping authored normal orientation", () => {
  const mesh = {
    numSplats: 1,
    matrixWorld: { elements: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    forEachSplat(callback) {
      callback(0, { x: 1, y: 0, z: 0 }, { x: 0.1, y: 0.1, z: 0.1 }, { x: 0, y: 0, z: 0, w: 1 }, 1, { r: 0.2, g: 0.3, b: 0.4 });
    },
  };
  const flat = flattenVisibleSnapshot(createSceneSnapshot([{
    authoredNormalEntries: [{ normal: { x: 1, y: 0, z: 0 } }],
    id: "mirrored-authored-surface",
    mesh,
    visible: true,
  }]));
  assert.equal(flat.unsupportedStaticBakeTransformCount, 1);
  assert.throws(
    () => bakeAllSplatsDirectLight({ light: { color: [1, 1, 1], intensity: 1, position: [-4, 0, 0] }, snapshot: flat }),
    /mirrored world transform/,
  );
});

test("only Cube and Macbeth source explicit authored bounce material", () => {
  const source = read("primitives/primitive-library.js");
  assert.match(source, /authoredSurfaceArea: \(2 \/ steps\) \*\* 2/);
  assert.match(source, /authoredSurfaceArea: \(\(patchStep \/ patchSubdivisions\) \*\* 2\) \/ 2/);
  assert.equal((source.match(/authoredDiffuseAlbedo:/g) ?? []).length, 2);
});

test("manifest advertises only implemented Gaussian capabilities", () => {
  assert.equal(LOOKDEV_LAB_NAME, "3DGS Scene Lab");
  assert.deepEqual(Object.keys(RENDERER_MANIFEST), ["spark", "playcanvas", "three-r186"]);
  Object.values(RENDERER_MANIFEST).forEach((backend) => {
    assert.equal(backend.capabilities.gaussianRenderer, true);
    assert.equal(backend.capabilities.directionalCaster, false);
    assert.equal(backend.capabilities.splatReceivesShadows, false);
  });
  assert.match(RENDERER_MANIFEST.playcanvas.capabilities.sh, /SH0/);
  assert.match(RENDERER_MANIFEST["three-r186"].capabilities.sh, /SH0/);
  assert.equal(RENDERER_MANIFEST.playcanvas.capabilities.animation, "Spark only");
  assert.equal(RENDERER_MANIFEST["three-r186"].capabilities.animation, "Spark only");
});

test("alternate adapters use actual GSplat and official r186 sorting", () => {
  const source = read("viewer-backends.mjs");
  assert.match(source, /new PlayCanvas\.GSplatData/);
  assert.match(source, /new PlayCanvas\.GSplatResource/);
  assert.match(source, /data\.activated = true/);
  assert.match(source, /setCanvasFillMode\(PlayCanvas\.FILLMODE_NONE\)/);
  assert.match(source, /graphicsDevice\.resizeCanvas\(renderWidth, renderHeight\)/);
  assert.match(source, /PlayCanvas\.AppBase\.cancelTick\(this\.app\)/);
  assert.match(source, /systems\.gsplat\?\.on\("frame:request", \(\) => this\.onFrameRequest\?\.\(\)\)/);
  assert.match(source, /scene\.on\("gsplat:sorted", \(\) => this\.onFrameRequest\?\.\(\)\)/);
  assert.match(source, /syncSnapshot\(snapshot\)[\s\S]*?this\.needsSystemUpdate \|\|= placementsChanged;/);
  assert.match(source, /resourcesById[\s\S]*?resource\.updateColorData\(data\);[\s\S]*?resource\.updateTransformData\(data\);[\s\S]*?workBufferUpdate = PlayCanvas\.WORKBUFFER_UPDATE_ONCE;/);
  assert.match(source, /const nextResources = visibleItems\.map[\s\S]*?resourcesById\.forEach[\s\S]*?this\.resources = nextResources;/);
  assert.match(source, /if \(!topologyMatches && this\.hasSnapshot && !this\.app\.graphicsDevice\.isWebGPU\) \{[\s\S]*?this\.dispose\(\);[\s\S]*?this\.createApplication\(stage\);[\s\S]*?this\.syncSnapshot\(snapshot\);/);
  assert.match(source, /syncFrame\([\s\S]*?if \(this\.needsSystemUpdate\) \{[\s\S]*?this\.app\.update\(0\);/);
  assert.match(source, /syncFrame\([\s\S]*?this\.app\.fire\("framerender"\);[\s\S]*?this\.app\.render\(\)/);
  assert.match(source, /this\.app\.render\(\)/);
  assert.match(source, /this\.app\.drawLine\(origin/);
  assert.match(source, /if \(helpers\?\.showGrid\)/);
  assert.match(source, /if \(helpers\?\.showBounds && helpers\.bounds\)/);
  assert.match(source, /ThreeR186\.REVISION !== EXPECTED_THREE_REVISION/);
  assert.match(source, /this\.flat = flattenVisibleSnapshot\(snapshot, \{ includeQuaternion: false, includeCovariance: true \}\)/);
  assert.match(source, /new ThreeR186\.GaussianSplat\(geometry, \{ autoSort: false \}\)/);
  assert.match(source, /ThreeR186\.createNativeAppearance\(this\.mesh, this\.flat,/);
  assert.match(source, /syncItemTransforms\(items\)[\s\S]*?ThreeR186\.updateNativeGeometry\(this\.mesh, this\.flat\);/);
  assert.match(source, /this\.mesh\?\.updateSort\(this\.renderer, this\.camera\);/);
  assert.match(source, /ThreeR186\.disposeNativeSplat\(this\.mesh\);/);
  assert.doesNotMatch(source, /attribute vec3 splatCovarianceDiagonal;/);
  assert.doesNotMatch(source, /attribute vec3 splatCovarianceOffDiagonal;/);
  assert.doesNotMatch(source, /sortByCamera\(sourceCamera\)/);
  assert.doesNotMatch(source, /new ThreeR186\.InstancedBufferAttribute/);
  assert.match(source, /this\.backends\.get\(previousId\)\?\.dispose\(\)/);
  assert.doesNotMatch(source, /ThreeR186\.Points|new ThreeR186\.Points/);
});

test("alternate renderer vendors load as separate classic bundles only when selected", () => {
  const source = read("viewer-backends.mjs");
  const playCanvasEntry = read("viewer-vendor-playcanvas.mjs");
  const threeEntry = read("viewer-vendor-three-r186.mjs");
  const threeBuild = read("tools/build-three-r186.mjs");
  const packageJson = JSON.parse(read("package.json"));

  assert.doesNotMatch(source, /^import \* as PlayCanvas from "playcanvas";/m);
  assert.doesNotMatch(source, /^import \* as ThreeR186 from "three-r186";/m);
  assert.match(source, /viewer-vendor-playcanvas\.bundle\.js/);
  assert.match(source, /viewer-vendor-three-r186\.bundle\.js/);
  assert.match(source, /script\.dataset\.lookdevVendor = id/);
  assert.match(source, /new URL\(definition\.source, documentRef\.baseURI\)/);
  assert.match(source, /await this\.loadVendor\(id\)/);
  assert.match(source, /activationToken !== this\.activationToken/);
  assert.match(playCanvasEntry, /import \* as PlayCanvas from "playcanvas"/);
  assert.match(playCanvasEntry, /__SPATIAL_LOOKDEV_PLAYCANVAS__/);
  assert.match(threeEntry, /import \* as ThreeR186 from "three-r186\/webgpu"/);
  assert.match(threeEntry, /import \{ GaussianSplat \} from "three-r186\/addons\/objects\/GaussianSplat\.js"/);
  assert.match(threeEntry, /ThreeR186\.ColorManagement\.workingColorSpace = ThreeR186\.SRGBColorSpace/);
  assert.match(threeEntry, /__SPATIAL_LOOKDEV_THREE_R186__/);
  assert.match(packageJson.scripts.build, /build:main/);
  assert.match(packageJson.scripts.build, /build:vendor:playcanvas/);
  assert.match(packageJson.scripts.build, /build:vendor:three-r186/);
  assert.match(packageJson.scripts["build:main"], /--minify/);
  assert.match(packageJson.scripts["build:vendor:playcanvas"], /--minify/);
  assert.equal(packageJson.scripts["build:vendor:three-r186"], "node tools/build-three-r186.mjs");
  assert.match(threeBuild, /minify:\s*true/);
});

test("native helper recreation resets the remembered grid subdivision count", async () => {
  const ThreeR186 = await import('three-r186/webgpu');
  const body = read('viewer-backends.mjs').match(/  createHelpers\(\) \{([\s\S]*?)\n  \}\n\n  applySettings/)[1];
  const backend = {scene:new ThreeR186.Scene(),gridDivisions:5,applySettings(){}};
  new Function('ThreeR186',body).call(backend,ThreeR186);
  assert.equal(backend.gridDivisions,10);
  assert.equal(backend.gridHelper.geometry.getAttribute('position').count,44);
  for(const helper of backend.scene.children){helper.geometry.dispose();helper.material.dispose();}
});

test("lazy backend loader resolves a file-relative classic script namespace", async () => {
  const listeners = new Map();
  const namespace = Object.freeze({ version: "test-playcanvas" });
  const globalRef = {};
  let appendedScript = null;
  let removed = false;
  const script = {
    dataset: {},
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    remove() {
      removed = true;
    },
  };
  const documentRef = {
    baseURI: "file:///tmp/spatial-lookdev/index.html",
    createElement(tagName) {
      assert.equal(tagName, "script");
      return script;
    },
    head: {
      append(node) {
        appendedScript = node;
        globalRef[BACKEND_VENDOR_DEFINITIONS.playcanvas.globalName] = namespace;
        queueMicrotask(() => listeners.get("load")());
      },
    },
  };

  const loaded = await loadBackendVendor("playcanvas", { documentRef, globalRef });

  assert.equal(loaded, namespace);
  assert.equal(appendedScript, script);
  assert.equal(script.async, true);
  assert.equal(script.dataset.lookdevVendor, "playcanvas");
  assert.equal(script.src, "file:///tmp/spatial-lookdev/viewer-vendor-playcanvas.bundle.js");
  assert.equal(removed, false);
});

test("Spark avoids renderer snapshots until an alternate backend is selected", () => {
  const source = read("viewer.js");
  assert.match(source, /refreshActiveBackendSnapshot\(reason = "scene updated", \{ force = false, syncActive = true, appearanceOnly = false \} = \{\}\)/);
  assert.match(source, /if \(!force && this\.backendManager\.isSparkActive\(\)\) return;/);
  assert.match(source, /setSnapshot\(this\.captureRendererSnapshot\(\), \{ syncActive \}\);[\s\S]*?if \(syncActive\) this\.forceVisualRefresh\(2\);/);
  assert.match(source, /getSnapshot: \(options\) => this\.captureRendererSnapshot\(options\)/);
  assert.match(source, /createSceneSnapshot\(this\.sceneItems, \{[\s\S]*?mapLinearRgb:[\s\S]*?visibleOnly: true/);
  assert.match(source, /syncActiveBackendItemTransforms\(\)[\s\S]*?pendingActiveBackendTransformSync = true;[\s\S]*?invalidateRender\(\)/);
  assert.match(source, /flushActiveBackendItemTransforms\(\)[\s\S]*?backendManager\.syncItemTransforms/);
  assert.match(source, /renderActiveBackendFrame\(\)[\s\S]*?flushActiveBackendItemTransforms\(\)/);
  assert.match(source, /onFrameRequest: \(\) => this\.forceVisualRefresh\(2\)/);
  assert.match(source, /if \(!commit\) this\.syncActiveBackendItemTransforms\(\);/);
  assert.match(source, /showGrid: this\.state\.showGrid/);
  assert.match(source, /showBounds: this\.state\.showBounds/);
});

function makeCanvasStub() {
  const classes = new Set();
  return { classes, classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } } };
}

function makeBackendManager(loadVendor = async () => {}) {
  const events = [];
  const makeBackend = (id) => ({
    canvas: null,
    telemetry: id,
    disposed: 0,
    ensure() {
      events.push(`${id}:ensure`);
      this.canvas = makeCanvasStub();
      if (this.failEnsure) throw new Error(`${id} init failed`);
    },
    syncSnapshot(snapshot) {
      events.push(`${id}:snapshot`);
      this.snapshot = snapshot;
      if (this.failSnapshot) throw new Error(`${id} snapshot failed`);
    },
    dispose() {
      events.push(`${id}:dispose`);
      this.disposed += 1;
      this.canvas = null;
    },
  });
  const manager = new LookDevBackendManager({ stage: {}, inputCanvas: makeCanvasStub(), loadVendor });
  const playcanvas = makeBackend('playcanvas');
  const three = makeBackend('three-r186');
  manager.backends = new Map([['playcanvas', playcanvas], ['three-r186', three]]);
  return { manager, playcanvas, three, events };
}

for (const failure of ['failEnsure', 'failSnapshot']) {
  test(`a failed alternate switch (${failure}) preserves the prior canvas and snapshot`, async () => {
    const { manager, playcanvas, three } = makeBackendManager();
    const prior = { items: [], splatCount: 2 };
    const next = { items: [], splatCount: 3 };
    await manager.setActive('playcanvas', { getSnapshot: () => prior });
    const priorCanvas = playcanvas.canvas;
    three[failure] = true;
    await assert.rejects(manager.setActive('three-r186', { getSnapshot: () => next }), /failed/);
    assert.equal(manager.activeId, 'playcanvas');
    assert.equal(manager.snapshot, prior);
    assert.equal(playcanvas.disposed, 0);
    assert.equal(playcanvas.canvas, priorCanvas);
    assert.equal(priorCanvas.classes.has('is-active-backend'), true);
    assert.equal(three.disposed, 1);
    assert.equal(three.canvas, null);
  });
}

test('a successful switch disposes the old renderer only after the replacement is prepared', async () => {
  const { manager, playcanvas, three, events } = makeBackendManager();
  await manager.setActive('playcanvas');
  await manager.setActive('three-r186');
  assert.equal(manager.activeId, 'three-r186');
  assert.equal(playcanvas.disposed, 1);
  assert.equal(three.canvas.classes.has('is-active-backend'), true);
  assert.ok(events.indexOf('three-r186:snapshot') < events.indexOf('playcanvas:dispose'));
});

test('GPU device initialization captures the latest snapshot and ignores a superseded activation', async () => {
  for (const superseded of [false,true]) {
    const { manager, playcanvas } = makeBackendManager();
    let release, entered;
    const gate = new Promise(resolve => { release=resolve; });
    const ready = new Promise(resolve => { entered=resolve; });
    playcanvas.supportsGpuAppearance = true;
    playcanvas.ensure = async () => { playcanvas.canvas=makeCanvasStub(); entered(); await gate; };
    let reads=0;
    const latest={items:[],splatCount:7};
    const pending=manager.setActive('playcanvas',{getSnapshot(options){reads++;assert.equal(options.gpuAppearance,true);return latest;}});
    await ready; assert.equal(reads,0);
    if(superseded)await manager.setActive('spark');
    release();assert.equal(await pending,!superseded);
    assert.equal(reads,superseded?0:1);
    if(superseded)assert.equal(playcanvas.disposed,1);
    else assert.equal(manager.snapshot,latest);
  }
});

test('a delayed vendor load captures the latest scene once, after loading', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { manager, playcanvas } = makeBackendManager(() => gate);
  let latest = { items: [], splatCount: 1 };
  let reads = 0;
  const switching = manager.setActive('playcanvas', { getSnapshot: () => { reads += 1; return latest; } });
  assert.equal(reads, 0);
  latest = { items: [], splatCount: 4 };
  release();
  assert.equal(await switching, true);
  assert.equal(reads, 1);
  assert.equal(manager.snapshot, latest);
  assert.equal(playcanvas.snapshot, latest);
});

test('a superseded switch never captures a scene or creates an alternate renderer', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { manager, events } = makeBackendManager(() => gate);
  const pending = manager.setActive('playcanvas', { getSnapshot() { throw new Error('stale capture'); } });
  await manager.setActive('spark');
  release();
  assert.equal(await pending, false);
  assert.equal(manager.activeId, 'spark');
  assert.deepEqual(events, []);
});

test('vendor load failure leaves the current renderer and its snapshot untouched', async () => {
  const { manager, playcanvas, three } = makeBackendManager(async (id) => {
    if (id === 'three-r186') throw new Error('vendor unavailable');
  });
  await manager.setActive('playcanvas');
  const snapshot = manager.snapshot;
  await assert.rejects(manager.setActive('three-r186', { getSnapshot() { throw new Error('unneeded capture'); } }), /vendor unavailable/);
  assert.equal(manager.activeId, 'playcanvas');
  assert.equal(manager.snapshot, snapshot);
  assert.equal(playcanvas.disposed, 0);
  assert.equal(three.disposed, 0);
});

test("tool UI exposes one concise global backend selector before Camera", () => {
  const markup = read("index.html");
  assert.match(markup, /<h1>3DGS Scene Lab<\/h1>/);
  assert.match(markup, /<title>3DGS Scene Lab<\/title>/);
  const leftPanel = markup.match(/<aside class="panel panel-left">([\s\S]*?)<\/aside>/)?.[1] ?? "";
  assert.match(leftPanel, /<section class="backend-panel backend-panel-workspace"[\s\S]*id="backend-select"[\s\S]*<h2>Camera<\/h2>/);
  assert.match(markup, /id="backend-select"/);
  assert.equal((markup.match(/id="backend-select"/g) ?? []).length, 1);
  assert.match(markup, /value="spark" selected/);
  assert.match(markup, /value="playcanvas"/);
  assert.match(markup, /value="three-r186"/);
  assert.doesNotMatch(markup, /id="backend-telemetry"/);
  assert.doesNotMatch(markup, /id="backend-capability"/);
  assert.doesNotMatch(markup, /live look-dev|Spark effects unavailable/);
});

test("package pins PlayCanvas and the exact official Three.js r186 alias", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.name, "3dgs-scene-lab");
  const lockfile = JSON.parse(read("package-lock.json"));
  assert.equal(lockfile.name, packageJson.name);
  assert.equal(lockfile.packages[""].name, packageJson.name);
  assert.equal(packageJson.dependencies.playcanvas, "2.22.0");
  assert.equal(
    packageJson.dependencies["three-r186"],
    "npm:three@0.186.0",
  );
  assert.equal(lockfile.packages["node_modules/three-r186"].version, "0.186.0");
  assert.match(packageJson.scripts["build:main"], /external:node:worker_threads/);
});
