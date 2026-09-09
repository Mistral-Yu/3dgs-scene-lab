import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  STATIC_BAKE_MAX_AUTHORED_BOUNCE_PATHS,
  STATIC_BAKE_MAX_AUTHORED_BOUNCE_SOURCES,
  STATIC_BAKE_MODE,
  STATIC_BAKE_GENERIC_POLICY,
  bakeAllSplatsDirectLight,
  bakeAllSplatsDirectLightAsync,
  createDeterministicSplatBvhAsync,
  createStaticBakeJobToken,
  createDeterministicSplatBvh,
  evaluateBvhTransmission,
  gaussianSegmentOpticalDepth,
  getStaticBakeActiveShDegree,
  runStaticBakeColorTransaction,
} from "../viewer-static-lighting.mjs";
import {
  createMainThreadTaskYield,
  createStaticBakeRestoreHandle,
  createStaticBakeWorkerSnapshot,
  createThrottledProgressReporter,
  StaticLightingBakeController,
} from "../viewer-static-lighting-client.mjs";
import { createWorkerTaskYield } from "../viewer-static-lighting-worker.mjs";

const makeSnapshot = ({ centers, normals = [], opacity = [], authored = [], bounceMaterial = [] }) => {
  const count = centers.length;
  const authoredDiffuseAlbedo = new Float32Array(count * 3);
  const authoredSurfaceArea = new Float32Array(count);
  const hasAuthoredBounceMaterial = new Uint8Array(count);
  bounceMaterial.forEach((material, index) => {
    if (!material) return;
    authoredDiffuseAlbedo.set(material.albedo ?? [0, 0, 0], index * 3);
    authoredSurfaceArea[index] = material.area ?? 0;
    hasAuthoredBounceMaterial[index] = material.enabled === false ? 0 : 1;
  });
  return {
    authoredDiffuseAlbedo,
    authoredSurfaceArea,
    center: Float32Array.from(centers.flat()),
    count,
    hasAuthoredBounceMaterial,
    hasAuthoredNormal: Uint8Array.from({ length: count }, (_, index) => authored[index] ?? 0),
    itemIndex: Uint32Array.from({ length: count }, () => 0),
    linearRgb: Float32Array.from(centers.flatMap((_, index) => [0.2 + (index * 0.01), 0.3, 0.4])),
    normal: Float32Array.from(centers.flatMap((_, index) => normals[index] ?? [0, 0, 0])),
    opacity: Float32Array.from(opacity),
    scale: Float32Array.from(centers.flatMap(() => [1, 1, 1])),
    sourceIndex: Uint32Array.from({ length: count }, (_, index) => index),
  };
};

const BOUNCE_LIGHT = {
  color: [1, 1, 1],
  genericPolicy: STATIC_BAKE_GENERIC_POLICY.PRESERVE,
  intensity: 12,
  position: [4, 8, 0],
};

const makeBounceScene = ({ lightBlocker = false, receiverBlocker = false } = {}) => {
  const centers = [[0, 0, 0], [0, 4, 0]];
  const normals = [[1, 1, 0], [0, -1, 0]];
  const opacity = [1, 0];
  const authored = [1, 1];
  const bounceMaterial = [
    { albedo: [0.8, 0.7, 0.6], area: 1 },
    { albedo: [0.2, 0.5, 0.9], area: 1 },
  ];
  if (lightBlocker || receiverBlocker) {
    centers.push(lightBlocker ? [2, 4, 0] : [0, 2, 0]);
    normals.push([0, 0, 0]);
    opacity.push(0.999);
    authored.push(0);
    bounceMaterial.push(null);
  }
  const snapshot = makeSnapshot({ authored, bounceMaterial, centers, normals, opacity });
  snapshot.scale.fill(0.1);
  snapshot.itemIndex[2] = 1;
  return snapshot;
};

const createSeededRandom = (seed) => () => {
  let next = seed >>> 0;
  return () => {
    next = (Math.imul(next, 1664525) + 1013904223) >>> 0;
    return next / 0x100000000;
  };
};

const makeRandomSnapshot = (seed, count) => {
  const random = createSeededRandom(seed)();
  const snapshot = makeSnapshot({
    centers: Array.from({ length: count }, () => [
      (random() * 18) - 9,
      (random() * 12) - 6,
      (random() * 10) - 5,
    ]),
    opacity: Array.from({ length: count }, () => random()),
  });
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    snapshot.scale[offset] = 0.05 + (random() * 1.75);
    snapshot.scale[offset + 1] = 0.05 + (random() * 1.75);
    snapshot.scale[offset + 2] = 0.05 + (random() * 1.75);
    snapshot.itemIndex[index] = index % 4;
    snapshot.sourceIndex[index] = Math.floor(index / 4);
  }
  return snapshot;
};

const approximateEqual = (actual, expected, epsilon = 1e-11) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
};

test("all-splat BVH matches brute-force Gaussian optical depth", () => {
  const snapshot = makeSnapshot({
    centers: [[2, 0, 0], [4, 0, 0], [6, 3, 0], [10, 0, 0]],
    opacity: [0.25, 0.5, 1, 0.75],
  });
  const lightPosition = [0, 0, 0];
  const receiverIndex = 3;
  const expectedDepth = [0, 1, 2].reduce((sum, index) => sum + gaussianSegmentOpticalDepth({
    lightPosition,
    opacity: snapshot.opacity[index],
    receiverPosition: snapshot.center.subarray(receiverIndex * 3, (receiverIndex + 1) * 3),
    sigma: 1,
    splatPosition: snapshot.center.subarray(index * 3, (index + 1) * 3),
  }), 0);
  const received = evaluateBvhTransmission({
    bvh: createDeterministicSplatBvh(snapshot),
    lightPosition,
    receiverIndex,
    snapshot,
  });

  assert.equal(received.opticalDepth, expectedDepth);
  assert.equal(received.transmission, Math.exp(-expectedDepth));
  assert.equal(received.testedCandidates, 3);
});

test("Gaussian occlusion rejects off-ray, endpoint, and only the matching stable splat", () => {
  const segment = { lightPosition: [0, 0, 0], receiverPosition: [10, 0, 0], sigma: 1 };
  assert.equal(gaussianSegmentOpticalDepth({ ...segment, opacity: 1, splatPosition: [5, 3.01, 0] }), 0);
  assert.equal(gaussianSegmentOpticalDepth({ ...segment, opacity: 1, splatPosition: [0, 0, 0] }), 0);
  assert.equal(gaussianSegmentOpticalDepth({ ...segment, opacity: 1, splatPosition: [10, 0, 0] }), 0);

  const snapshot = makeSnapshot({ centers: [[5, 0, 0], [10, 0, 0]], opacity: [1, 0] });
  const bvh = createDeterministicSplatBvh(snapshot);
  assert.equal(evaluateBvhTransmission({ bvh, lightPosition: [0, 0, 0], receiverIndex: 0, snapshot }).transmission, 1);
});

test("Gaussian optical depth is finite and transmission monotonically decreases with opacity", () => {
  const options = { lightPosition: [0, 0, 0], receiverPosition: [10, 0, 0], sigma: 1, splatPosition: [5, 0, 0] };
  const low = gaussianSegmentOpticalDepth({ ...options, opacity: 0.2 });
  const high = gaussianSegmentOpticalDepth({ ...options, opacity: 0.8 });
  assert.ok(Number.isFinite(high));
  assert.ok(high >= low && low >= 0);
  assert.ok(Math.exp(-high) <= Math.exp(-low));
});

test("same-item receiver bias rejects overlapping surface samples without disabling separate-item contact shadows", () => {
  const shared = {
    lightPosition: [0, 0, 0],
    opacity: 0.9,
    receiverPosition: [10, 0, 0],
    sigma: 0.2,
    splatPosition: [9.9, 0, 0],
  };
  assert.ok(gaussianSegmentOpticalDepth(shared) > 0);
  assert.equal(gaussianSegmentOpticalDepth({ ...shared, receiverEndpointBias: 0.2 }), 0);

  const snapshot = makeSnapshot({
    centers: [[9.9, 0, 0], [10, 0, 0]],
    opacity: [0.9, 1],
  });
  snapshot.scale.fill(0.2);
  const sameItemBvh = createDeterministicSplatBvh(snapshot);
  assert.equal(evaluateBvhTransmission({
    bvh: sameItemBvh,
    lightPosition: [0, 0, 0],
    receiverIndex: 1,
    snapshot,
  }).transmission, 1);

  snapshot.itemIndex[0] = 1;
  const separateItemBvh = createDeterministicSplatBvh(snapshot);
  assert.ok(evaluateBvhTransmission({
    bvh: separateItemBvh,
    lightPosition: [0, 0, 0],
    receiverIndex: 1,
    snapshot,
  }).transmission < 1);
});

test("bounce source endpoint bias excludes adjacent same-item surface samples without changing direct contact behavior", () => {
  const snapshot = makeSnapshot({
    centers: [[0, 0, 0], [0.1, 0, 0], [10, 0, 0]],
    opacity: [1, 0.9, 0],
  });
  snapshot.scale.fill(0.2);
  const bvh = createDeterministicSplatBvh(snapshot);
  const direct = evaluateBvhTransmission({
    bvh,
    lightPosition: [0, 0, 0],
    receiverIndex: 2,
    snapshot,
  });
  const bounce = evaluateBvhTransmission({
    bvh,
    lightPosition: [0, 0, 0],
    receiverIndex: 2,
    snapshot,
    sourceIndex: 0,
  });
  assert.ok(direct.transmission < 1);
  assert.equal(bounce.transmission, 1);
  assert.equal(gaussianSegmentOpticalDepth({
    lightPosition: [0, 0, 0],
    opacity: 0.9,
    receiverPosition: [10, 0, 0],
    sigma: 0.2,
    sourceEndpointBias: 0.2,
    splatPosition: [0.1, 0, 0],
  }), 0);
});

test("all receivers are processed without a proxy cap and results are deterministic", () => {
  const snapshot = makeSnapshot({
    centers: Array.from({ length: 48 }, (_, index) => [index + 1, 0, 0]),
    opacity: Array.from({ length: 48 }, () => 0.1),
  });
  const first = bakeAllSplatsDirectLight({ light: { intensity: 1, position: [0, 0, 0], color: [1, 1, 1] }, snapshot });
  const second = bakeAllSplatsDirectLight({ light: { intensity: 1, position: [0, 0, 0], color: [1, 1, 1] }, snapshot });
  assert.equal(first.processed, 48);
  assert.equal(first.total, 48);
  assert.ok(first.diagnostics.testedCandidates > 32);
  assert.deepEqual([...first.transmission], [...second.transmission]);
  assert.deepEqual([...first.bakedLinearRgb], [...second.bakedLinearRgb]);
});

test("packed Morton BVH retains every randomized 3-sigma Gaussian candidate and transmission", () => {
  const snapshot = makeRandomSnapshot(0x4d4f5254, 72);
  const lightPosition = [-11, 3, 4];
  const bvh = createDeterministicSplatBvh(snapshot, { leafSize: 7 });
  assert.ok(bvh.bounds instanceof Float64Array);
  assert.ok(bvh.childLeft instanceof Int32Array);
  assert.ok(bvh.childRight instanceof Int32Array);
  assert.ok(bvh.leafStart instanceof Uint32Array);
  assert.ok(bvh.leafLength instanceof Uint32Array);
  assert.equal(bvh.order.length, snapshot.count);
  assert.equal(new Set(bvh.order).size, snapshot.count);
  for (let receiverIndex = 0; receiverIndex < snapshot.count; receiverIndex += 1) {
    const receiverOffset = receiverIndex * 3;
    let expectedDepth = 0;
    let contributingCandidates = 0;
    for (let occluderIndex = 0; occluderIndex < snapshot.count; occluderIndex += 1) {
      if (
        snapshot.itemIndex[occluderIndex] === snapshot.itemIndex[receiverIndex]
        && snapshot.sourceIndex[occluderIndex] === snapshot.sourceIndex[receiverIndex]
      ) continue;
      const occluderOffset = occluderIndex * 3;
      const receiverSigma = Math.fround(Math.max(...snapshot.scale.slice(receiverOffset, receiverOffset + 3)) * 3) / 3;
      const occluderSigma = Math.fround(Math.max(...snapshot.scale.slice(occluderOffset, occluderOffset + 3)) * 3) / 3;
      const depth = gaussianSegmentOpticalDepth({
        lightPosition,
        opacity: snapshot.opacity[occluderIndex],
        receiverEndpointBias: snapshot.itemIndex[occluderIndex] === snapshot.itemIndex[receiverIndex]
          ? Math.max(receiverSigma, occluderSigma)
          : 0,
        receiverPosition: snapshot.center.slice(receiverOffset, receiverOffset + 3),
        sigma: occluderSigma,
        splatPosition: snapshot.center.slice(occluderOffset, occluderOffset + 3),
      });
      expectedDepth += depth;
      if (depth > 0) contributingCandidates += 1;
    }
    const received = evaluateBvhTransmission({ bvh, lightPosition, receiverIndex, snapshot });
    approximateEqual(received.opticalDepth, expectedDepth);
    approximateEqual(received.transmission, Math.exp(-expectedDepth));
    assert.ok(received.testedCandidates >= contributingCandidates);
  }
});

test("duplicate Morton codes use the stable item/source/original tuple without engine sort", () => {
  const snapshot = makeSnapshot({
    centers: Array.from({ length: 5 }, () => [1, 2, 3]),
    opacity: Array.from({ length: 5 }, () => 0.5),
  });
  snapshot.itemIndex.set([2, 1, 1, 1, 2]);
  snapshot.sourceIndex.set([7, 3, 2, 2, 0]);
  const first = createDeterministicSplatBvh(snapshot, { leafSize: 2 });
  const second = createDeterministicSplatBvh(snapshot, { leafSize: 2 });
  assert.deepEqual([...first.order], [2, 3, 1, 4, 0]);
  assert.deepEqual([...first.order], [...second.order]);
  assert.deepEqual([...first.bounds], [...second.bounds]);
});

test("shuffled stable indices produce the same tuple order for shared Morton cells", () => {
  const snapshot = makeSnapshot({
    centers: Array.from({ length: 6 }, () => [2, -1, 4]),
    opacity: Array.from({ length: 6 }, () => 0.2),
  });
  snapshot.itemIndex.set([9, 2, 9, 1, 2, 1]);
  snapshot.sourceIndex.set([4, 8, 1, 7, 3, 2]);
  const bvh = createDeterministicSplatBvh(snapshot);
  assert.deepEqual([...bvh.order], [5, 3, 4, 1, 2, 0]);
});

test("sync and async packed bakes are byte-identical and report indexing then baking", async () => {
  const snapshot = makeRandomSnapshot(0x5041434b, 48);
  const light = { color: [0.6, 0.8, 1], intensity: 3, position: [-8, 2, 1] };
  const sync = bakeAllSplatsDirectLight({ light, snapshot });
  const phases = [];
  const asynchronous = await bakeAllSplatsDirectLightAsync({
    chunkSize: 5,
    indexingChunkSize: 7,
    light,
    onProgress: ({ phase }) => phases.push(phase),
    snapshot,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.equal(asynchronous.canceled, false);
  assert.deepEqual([...asynchronous.bakedLinearRgb], [...sync.bakedLinearRgb]);
  assert.deepEqual([...asynchronous.opticalDepth], [...sync.opticalDepth]);
  assert.deepEqual([...asynchronous.transmission], [...sync.transmission]);
  assert.deepEqual(asynchronous.diagnostics, sync.diagnostics);
  assert.ok(phases.includes("indexing"));
  assert.ok(phases.includes("baking"));
});

test("large packed median hierarchy has deterministic sync/async typed-array layout", async () => {
  const snapshot = makeRandomSnapshot(0x4d454449, 4096);
  const sync = createDeterministicSplatBvh(snapshot);
  const asynchronous = await createDeterministicSplatBvhAsync(snapshot, {
    chunkSize: 128,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.equal(sync.topology, "median");
  assert.equal(asynchronous.topology, "median");
  assert.equal(asynchronous.nodeCount, sync.nodeCount);
  assert.deepEqual([...asynchronous.order], [...sync.order]);
  assert.deepEqual([...asynchronous.bounds], [...sync.bounds]);
  assert.deepEqual([...asynchronous.childLeft], [...sync.childLeft]);
  assert.deepEqual([...asynchronous.childRight], [...sync.childRight]);
});

test("median hierarchy allocates exact backing buffers for uneven leaf counts", async () => {
  const snapshot = makeRandomSnapshot(0x45584143, 33);
  const sync = createDeterministicSplatBvh(snapshot, { leafSize: 16 });
  const asynchronous = await createDeterministicSplatBvhAsync(snapshot, {
    chunkSize: 64,
    leafSize: 16,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.equal(sync.nodeCount, 5);
  assert.equal(sync.bounds.buffer.byteLength, sync.bounds.byteLength);
  assert.equal(sync.childLeft.buffer.byteLength, sync.childLeft.byteLength);
  assert.equal(sync.leafStart.buffer.byteLength, sync.leafStart.byteLength);
  assert.equal(asynchronous.nodeCount, sync.nodeCount);
  assert.equal(asynchronous.bounds.buffer.byteLength, asynchronous.bounds.byteLength);
  assert.deepEqual([...asynchronous.bounds], [...sync.bounds]);
  assert.deepEqual([...asynchronous.order], [...sync.order]);
});

test("async bake cancels cooperatively during Morton indexing and receiver tracing", async () => {
  const snapshot = makeRandomSnapshot(0x43414e43, 40);
  let indexYields = 0;
  const indexingCanceled = await bakeAllSplatsDirectLightAsync({
    indexingChunkSize: 4,
    light: { position: [-4, 0, 0] },
    shouldCancel: () => indexYields > 0,
    snapshot,
    yieldToEventLoop: () => {
      indexYields += 1;
      return Promise.resolve();
    },
  });
  assert.equal(indexingCanceled.canceled, true);
  assert.equal(indexingCanceled.phase, "indexing");

  let phase = "indexing";
  let bakeYields = 0;
  const bakeCanceled = await bakeAllSplatsDirectLightAsync({
    chunkSize: 4,
    indexingChunkSize: 64,
    light: { position: [-4, 0, 0] },
    onProgress: ({ phase: nextPhase }) => { phase = nextPhase; },
    shouldCancel: () => phase === "baking" && bakeYields > 0,
    snapshot,
    yieldToEventLoop: () => {
      if (phase === "baking") bakeYields += 1;
      return Promise.resolve();
    },
  });
  assert.equal(bakeCanceled.canceled, true);
  assert.equal(bakeCanceled.phase, "baking");
});

test("authored normals use one-sided linear RGB direct lighting while generic splats preserve captured radiance", () => {
  const snapshot = makeSnapshot({
    centers: [[2, 0, 0], [4, 0, 0]],
    normals: [[-1, 0, 0], [0, 0, 0]],
    opacity: [0, 0],
    authored: [1, 0],
  });
  const baked = bakeAllSplatsDirectLight({
    light: { color: [0.5, 1, 0.25], intensity: 4, position: [0, 0, 0] },
    snapshot,
  });
  assert.deepEqual([...baked.bakedLinearRgb.slice(0, 3)], [0.30000001192092896, 0.6000000238418579, 0.5]);
  assert.deepEqual([...baked.bakedLinearRgb.slice(3, 6)], [...snapshot.linearRgb.slice(3, 6)]);
  assert.equal(baked.diagnostics.authoredReceiverCount, 1);
  assert.equal(baked.diagnostics.genericVisibilityOnlyCount, 1);
});

test("explicit generic visibility modulation is nonphysical and reversible from the immutable input RGB", () => {
  const snapshot = makeSnapshot({ centers: [[2, 0, 0], [5, 0, 0]], opacity: [0.9, 0] });
  const baked = bakeAllSplatsDirectLight({
    light: {
      color: [1, 1, 1],
      genericPolicy: STATIC_BAKE_GENERIC_POLICY.VISIBILITY_MODULATION,
      intensity: 1,
      position: [0, 0, 0],
      shadowFloor: 0.1,
    },
    snapshot,
  });
  assert.ok(baked.bakedLinearRgb[3] < snapshot.linearRgb[3]);
  assert.equal(baked.diagnostics.genericVisibilityModulatedCount, 2);
});

test("generic visibility modulation never darkens a back-facing authored receiver", async () => {
  const snapshot = makeSnapshot({
    authored: [0, 1],
    centers: [[2, 0, 0], [5, 0, 0]],
    normals: [[0, 0, 0], [1, 0, 0]],
    opacity: [0.9, 0],
  });
  const light = {
    color: [1, 1, 1],
    genericPolicy: STATIC_BAKE_GENERIC_POLICY.VISIBILITY_MODULATION,
    intensity: 1,
    position: [0, 0, 0],
    shadowFloor: 0,
  };
  const sync = bakeAllSplatsDirectLight({ light, snapshot });
  const asyncResult = await bakeAllSplatsDirectLightAsync({
    chunkSize: 1,
    indexingChunkSize: 1,
    light,
    snapshot,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.deepEqual([...sync.bakedLinearRgb.slice(3, 6)], [...snapshot.linearRgb.slice(3, 6)]);
  assert.deepEqual([...asyncResult.bakedLinearRgb], [...sync.bakedLinearRgb]);
  assert.equal(sync.diagnostics.genericVisibilityModulatedCount, 1);
});

test("direct default keeps the established raw Float32 output bytes", () => {
  const snapshot = makeSnapshot({
    authored: [1, 1, 1],
    centers: [[2, 0, 0], [4, 0, 0], [6, 1, 0]],
    normals: [[-1, 0, 0], [-1, 0, 0], [-1, 0, 0]],
    opacity: [0.1, 0.2, 0.3],
  });
  snapshot.linearRgb.set([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.1, 0.2, 0.3]);
  const baked = bakeAllSplatsDirectLight({
    light: { color: [0.6, 0.8, 1], intensity: 3, position: [-8, 2, 1] },
    snapshot,
  });
  assert.equal(
    Buffer.from(baked.bakedLinearRgb.buffer).toString("hex"),
    "eb39503eb8069d3eaa82d23ea560013fd5cd1b3f096a363fe960ce3d9de74e3ebd929b3e",
  );
});

test("authored one bounce uses only explicit material, preserves generic RGB, and is deterministic Float32", async () => {
  const snapshot = makeBounceScene({ receiverBlocker: true });
  snapshot.linearRgb.set([0, 0, 0, 0, 0, 0, 0.91, 0.42, 0.13]);
  const first = bakeAllSplatsDirectLight({ light: BOUNCE_LIGHT, mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE, snapshot });
  const second = bakeAllSplatsDirectLight({ light: BOUNCE_LIGHT, mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE, snapshot });
  const asynchronous = await bakeAllSplatsDirectLightAsync({
    chunkSize: 1,
    indexingChunkSize: 1,
    light: BOUNCE_LIGHT,
    mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE,
    snapshot,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.ok(first.bakedLinearRgb instanceof Float32Array);
  assert.deepEqual([...first.bakedLinearRgb], [...second.bakedLinearRgb]);
  assert.deepEqual([...first.bakedLinearRgb], [...asynchronous.bakedLinearRgb]);
  assert.deepEqual([...first.selectedSourceIndices], [...second.selectedSourceIndices]);
  assert.deepEqual([...first.selectedSourceIndices], [...asynchronous.selectedSourceIndices]);
  assert.ok(first.bakedLinearRgb[3] > snapshot.linearRgb[3]);
  assert.deepEqual([...snapshot.linearRgb.slice(6, 9)], [...first.bakedLinearRgb.slice(6, 9)]);
  assert.equal(first.diagnostics.authoredBounceReceiverCount, 2);
  assert.equal(first.diagnostics.nonfiniteCount, 0);
});

test("light-to-source and source-to-receiver blockers independently suppress authored bounce", () => {
  const baseline = bakeAllSplatsDirectLight({
    light: BOUNCE_LIGHT,
    mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE,
    snapshot: makeBounceScene(),
  });
  const lightBlocked = bakeAllSplatsDirectLight({
    light: BOUNCE_LIGHT,
    mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE,
    snapshot: makeBounceScene({ lightBlocker: true }),
  });
  const receiverBlocked = bakeAllSplatsDirectLight({
    light: BOUNCE_LIGHT,
    mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE,
    snapshot: makeBounceScene({ receiverBlocker: true }),
  });
  assert.ok(baseline.diagnostics.totalIndirectLuminance > 0);
  assert.ok(lightBlocked.diagnostics.totalIndirectLuminance < baseline.diagnostics.totalIndirectLuminance * 0.01);
  assert.ok(receiverBlocked.diagnostics.totalIndirectLuminance < baseline.diagnostics.totalIndirectLuminance * 0.01);
});

test("authored bounce source and all-receiver path caps hold for Cube-like and Macbeth-like counts", () => {
  const bakeCount = (count) => {
    const snapshot = makeSnapshot({
      authored: Array.from({ length: count }, () => 1),
      bounceMaterial: Array.from({ length: count }, () => ({ albedo: [0.5, 0.5, 0.5], area: 0.01 })),
      centers: Array.from({ length: count }, (_, index) => [
        (index % 18) * 0.4,
        Math.floor(index / 18) * 0.4,
        0,
      ]),
      normals: Array.from({ length: count }, () => [-1, 0, 0]),
      opacity: Array.from({ length: count }, () => 0.5),
    });
    snapshot.scale.fill(0.01);
    return bakeAllSplatsDirectLight({
      light: { ...BOUNCE_LIGHT, position: [-5, 0, 0] },
      mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE,
      snapshot,
    });
  };
  const cube = bakeCount(1944);
  const macbeth = bakeCount(432);
  [cube, macbeth].forEach((result) => {
    assert.ok(result.diagnostics.selectedSourceCount <= STATIC_BAKE_MAX_AUTHORED_BOUNCE_SOURCES);
    assert.ok(result.diagnostics.plannedPaths <= STATIC_BAKE_MAX_AUTHORED_BOUNCE_PATHS);
    assert.equal(result.diagnostics.plannedPaths, result.diagnostics.selectedSourceCount * result.diagnostics.authoredBounceReceiverCount);
  });
  assert.equal(cube.diagnostics.selectedSourceCount, 96);
  assert.equal(cube.diagnostics.plannedPaths, 186624);
});

test("coherent source clusters keep opposite-normal flux out of a back-facing receiver", () => {
  const sourceCount = 97;
  const receiverIndex = sourceCount;
  const snapshot = makeSnapshot({
    authored: Array.from({ length: sourceCount + 1 }, () => 1),
    bounceMaterial: Array.from({ length: sourceCount + 1 }, (_, index) => ({
      albedo: index === sourceCount - 1 ? [1, 1, 1] : [0.4, 0.4, 0.4],
      area: 0.02,
    })),
    centers: [
      ...Array.from({ length: sourceCount - 1 }, (_, index) => [index * 0.01, (index - 48) * 0.03, 0]),
      [8, 0, 0],
      [10, 0, 0],
    ],
    normals: [
      ...Array.from({ length: sourceCount - 1 }, () => [1, 0, 0]),
      [-1, 0, 0],
      [-1, 0, 0],
    ],
    opacity: [...Array.from({ length: sourceCount }, () => 0.5), 0],
  });
  snapshot.scale.fill(0.01);
  const light = { ...BOUNCE_LIGHT, position: [4, 0, 0] };
  const baseline = bakeAllSplatsDirectLight({ light, mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE, snapshot });
  snapshot.authoredDiffuseAlbedo.set([1000, 1000, 1000], (sourceCount - 1) * 3);
  const boostedBackFacing = bakeAllSplatsDirectLight({ light, mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE, snapshot });
  assert.equal(baseline.diagnostics.sourceClusterGroupCount, 2);
  assert.equal(boostedBackFacing.diagnostics.sourceClusterGroupCount, 2);
  assert.equal(boostedBackFacing.diagnostics.selectedSourceCount, STATIC_BAKE_MAX_AUTHORED_BOUNCE_SOURCES);
  assert.ok([...boostedBackFacing.selectedSourceIndices].includes(sourceCount - 1));
  assert.deepEqual(
    [...boostedBackFacing.bakedLinearRgb.slice(receiverIndex * 3, (receiverIndex + 1) * 3)],
    [...baseline.bakedLinearRgb.slice(receiverIndex * 3, (receiverIndex + 1) * 3)],
  );
});

test("coherent source compression does not cross stable item boundaries and fails above the source cap", () => {
  const snapshot = makeSnapshot({
    authored: Array.from({ length: 97 }, () => 1),
    bounceMaterial: Array.from({ length: 97 }, () => ({ albedo: [0.5, 0.5, 0.5], area: 0.01 })),
    centers: Array.from({ length: 97 }, (_, index) => [index * 0.03, 0, 0]),
    normals: Array.from({ length: 97 }, () => [-1, 0, 0]),
    opacity: Array.from({ length: 97 }, () => 0.5),
  });
  snapshot.scale.fill(0.01);
  snapshot.itemIndex[96] = 1;
  const result = bakeAllSplatsDirectLight({
    light: { ...BOUNCE_LIGHT, position: [-4, 0, 0] },
    mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE,
    snapshot,
  });
  assert.equal(result.diagnostics.sourceClusterGroupCount, 2);
  assert.ok([...result.selectedSourceIndices].includes(96));

  snapshot.itemIndex.set(Uint32Array.from({ length: 97 }, (_, index) => index));
  assert.throws(
    () => bakeAllSplatsDirectLight({
      light: { ...BOUNCE_LIGHT, position: [-4, 0, 0] },
      mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE,
      snapshot,
    }),
    /coherent source groups exceed/,
  );
});

test("authored bounce refuses receiver populations that cannot keep all receivers for one source", () => {
  const count = STATIC_BAKE_MAX_AUTHORED_BOUNCE_PATHS + 1;
  const snapshot = makeSnapshot({
    authored: Array.from({ length: count }, () => 1),
    bounceMaterial: Array.from({ length: count }, () => ({ albedo: [1, 1, 1], area: 1 })),
    centers: Array.from({ length: count }, (_, index) => [index, 0, 0]),
    normals: Array.from({ length: count }, () => [-1, 0, 0]),
    opacity: Array.from({ length: count }, () => 0),
  });
  assert.throws(
    () => bakeAllSplatsDirectLight({ light: BOUNCE_LIGHT, mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE, snapshot }),
    /all-receiver path budget/,
  );
});

test("Float64 scale snapshots retain tiny support radii while Float32 support remains unchanged", () => {
  const base = makeSnapshot({ centers: [[0, 0, 0]], opacity: [1] });
  base.scale = new Float64Array([1e-50, 1e-50, 1e-50]);
  const precise = createDeterministicSplatBvh(base);
  assert.ok(precise.supportRadius instanceof Float64Array);
  assert.ok(precise.supportRadius[0] > 0);
  const runtime = makeSnapshot({ centers: [[0, 0, 0]], opacity: [1] });
  runtime.scale.fill(0.25);
  const legacy = createDeterministicSplatBvh(runtime);
  assert.ok(legacy.supportRadius instanceof Float32Array);
  assert.equal(legacy.supportRadius[0], Math.fround(0.75));
});

test("authored bounce cancellation is observable during paths within the 1024-path yield bound", async () => {
  const count = 40;
  const snapshot = makeSnapshot({
    authored: Array.from({ length: count }, () => 1),
    bounceMaterial: Array.from({ length: count }, () => ({ albedo: [0.8, 0.8, 0.8], area: 0.01 })),
    centers: Array.from({ length: count }, (_, index) => [index * 0.2, 0, 0]),
    normals: Array.from({ length: count }, () => [-1, 0, 0]),
    opacity: Array.from({ length: count }, () => 0.5),
  });
  snapshot.scale.fill(0.01);
  let phase = "indexing";
  let yields = 0;
  const result = await bakeAllSplatsDirectLightAsync({
    chunkSize: 40,
    indexingChunkSize: 40,
    light: { ...BOUNCE_LIGHT, position: [-5, 0, 0] },
    mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE,
    onProgress: ({ phase: nextPhase }) => { phase = nextPhase; },
    shouldCancel: () => phase === "bounce" && yields > 0,
    snapshot,
    yieldToEventLoop: () => {
      if (phase === "bounce") yields += 1;
      return Promise.resolve();
    },
  });
  assert.equal(result.canceled, true);
  assert.equal(result.phase, "bounce");
  assert.ok(result.processed <= 1024);
});

test("Worker task yield uses MessageChannel tasks and has a zero-delay timer fallback", async () => {
  let posts = 0;
  class FakeMessageChannel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: () => {
          posts += 1;
          queueMicrotask(() => this.port1.onmessage?.());
        },
      };
    }
  }
  await createWorkerTaskYield({ MessageChannelClass: FakeMessageChannel })();
  assert.equal(posts, 1);

  const delays = [];
  const setTimeoutFn = (resolve, milliseconds) => {
    delays.push(milliseconds);
    queueMicrotask(resolve);
  };
  await createWorkerTaskYield({ MessageChannelClass: null, setTimeoutFn })();
  await createWorkerTaskYield({
    MessageChannelClass: class { constructor() { throw new Error("unavailable"); } },
    setTimeoutFn,
  })();
  assert.deepEqual(delays, [0, 0]);
  const workerSource = readFileSync(new URL("../viewer-static-lighting-worker.mjs", import.meta.url), "utf8");
  assert.match(workerSource, /yieldToEventLoop: createWorkerTaskYield\(\)/);
});

test("main-thread fallback uses task yielding and throttles repeated progress", async () => {
  let posts = 0;
  class FakeMessageChannel {
    constructor() {
      this.port1 = { close() {}, onmessage: null };
      this.port2 = {
        close() {},
        postMessage: () => {
          posts += 1;
          queueMicrotask(() => this.port1.onmessage?.());
        },
      };
    }
  }
  const yieldTask = createMainThreadTaskYield({ MessageChannelClass: FakeMessageChannel });
  await yieldTask();
  yieldTask.dispose();
  assert.equal(posts, 1);

  let time = 100;
  const received = [];
  const report = createThrottledProgressReporter((progress) => received.push(progress), {
    intervalMs: 50,
    now: () => time,
  });
  report({ phase: "indexing", stage: "sort", processed: 1, total: 100 });
  report({ phase: "indexing", stage: "sort", processed: 2, total: 100 });
  time += 51;
  report({ phase: "indexing", stage: "sort", processed: 3, total: 100 });
  report({ phase: "baking", processed: 1, total: 100 });
  assert.deepEqual(received.map((progress) => progress.processed), [1, 3, 1]);

  const clientSource = readFileSync(new URL("../viewer-static-lighting-client.mjs", import.meta.url), "utf8");
  assert.match(clientSource, /yieldToEventLoop = createMainThreadTaskYield\(\)/);
  assert.match(clientSource, /onProgress: reportProgress/);
});

test("Worker dispatch uses a slim snapshot, forwards bounce mode, and preserves canceled phase", async () => {
  class FakeWorker {
    constructor() {
      this.listeners = new Map();
      FakeWorker.instance = this;
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    postMessage(message) {
      this.message = message;
      queueMicrotask(() => this.listeners.get("message")?.({ data: {
        jobId: message.jobId,
        phase: "bounce",
        processed: 1024,
        total: 1600,
        type: "canceled",
      } }));
    }
    terminate() { this.terminated = true; }
  }
  const snapshot = makeBounceScene();
  const slim = createStaticBakeWorkerSnapshot({
    ...snapshot,
    itemIds: ["restore-only"],
    quaternion: new Float32Array(8),
    unsupportedStaticBakeTransformCount: 2,
  });
  assert.equal("itemIds" in slim, false);
  assert.equal("quaternion" in slim, false);
  assert.equal(slim.unsupportedStaticBakeTransformCount, 2);
  const controller = new StaticLightingBakeController({ WorkerClass: FakeWorker });
  const result = await controller.start({ light: BOUNCE_LIGHT, mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE, snapshot });
  assert.equal(result.canceled, true);
  assert.equal(result.phase, "bounce");
  assert.equal(FakeWorker.instance.message.mode, STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE);
  assert.equal("itemIds" in FakeWorker.instance.message.snapshot, false);
  assert.match(readFileSync(new URL("../viewer-static-lighting-worker.mjs", import.meta.url), "utf8"), /now - lastProgressAt < 50/);
  const unavailable = new StaticLightingBakeController({ WorkerClass: undefined });
  const fallback = await unavailable.start({
    light: BOUNCE_LIGHT,
    mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE,
    snapshot,
  });
  assert.equal(fallback.execution, "main-thread-fallback");
  assert.equal(unavailable.active, null);
});

test("restore state retains only stable item/source mapping and original RGB ownership", () => {
  const snapshot = {
    center: new Float32Array(9),
    count: 3,
    itemIds: ["first", "second"],
    itemIndex: Uint32Array.from([0, 1, 1]),
    linearRgb: new Float32Array(9),
    normal: new Float32Array(9),
    opacity: new Float32Array(3),
    quaternion: null,
    scale: new Float32Array(9),
    sourceIndex: Uint32Array.from([4, 8, 9]),
  };
  const handle = createStaticBakeRestoreHandle(snapshot);
  assert.deepEqual(Object.keys(handle), ["count", "itemIds", "itemIndex", "sourceIndex"]);
  assert.equal(handle.count, 3);
  assert.deepEqual(handle.itemIds, ["first", "second"]);
  assert.equal(handle.itemIndex, snapshot.itemIndex);
  assert.equal(handle.sourceIndex, snapshot.sourceIndex);
  assert.equal("linearRgb" in handle, false);
  assert.equal("center" in handle, false);
  assert.throws(() => createStaticBakeRestoreHandle({ count: 2, itemIndex: new Uint32Array(1), sourceIndex: new Uint32Array(2) }), /mapping is incomplete/);
  const viewerSource = readFileSync(new URL("../viewer.js", import.meta.url), "utf8");
  assert.match(viewerSource, /createSceneSnapshot\(this\.sceneItems, \{[\s\S]*?includeQuaternion: false,[\s\S]*?visibleOnly: true,[\s\S]*?\}\)/);
  assert.match(viewerSource, /flattenVisibleSnapshot\([\s\S]*?\{ includeQuaternion: false \},[\s\S]*?\)/);
  assert.match(viewerSource, /staticBakeResultSnapshot = createStaticBakeRestoreHandle\(snapshot\)/);
});

test("file protocol skips Worker construction and runs the uncapped cooperative fallback", async () => {
  const snapshot = makeBounceScene();
  class ForbiddenWorker {
    constructor() { throw new Error("file protocol must not construct a Worker"); }
  }
  const controller = new StaticLightingBakeController({
    protocol: "file:",
    WorkerClass: ForbiddenWorker,
  });
  const result = await controller.start({
    light: BOUNCE_LIGHT,
    mode: STATIC_BAKE_MODE.DIRECT,
    snapshot,
  });
  assert.equal(result.execution, "main-thread-fallback");
  assert.equal(result.workerFailure, "Local file mode");
  assert.equal(controller.active, null);
  assert.equal(controller.cancel(), false);
});

test("job tokens let a controller reject stale results before color application", () => {
  const token = createStaticBakeJobToken();
  assert.equal(token.isActive(), true);
  token.cancel();
  assert.equal(token.isActive(), false);
});

test("static bake SH gate uses the loaded degree when a higher unavailable level was requested", () => {
  assert.equal(getStaticBakeActiveShDegree({ loadedShDegree: 0, requestedShLevel: 3 }), 0);
  assert.equal(getStaticBakeActiveShDegree({ loadedShDegree: 3, requestedShLevel: 0 }), 0);
  assert.equal(getStaticBakeActiveShDegree({ loadedShDegree: 3, requestedShLevel: 2 }), 2);
});

test("color transaction rolls back a partially failing setter and preserves a retryable error", () => {
  const writes = [];
  const rolledBack = [];
  const transaction = runStaticBakeColorTransaction({
    applyBaked() {
      writes.push("first");
      throw new Error("second setter failed");
    },
    restoreOriginal() {
      rolledBack.push("first");
    },
  });
  assert.equal(transaction.rolledBack, true);
  assert.equal(transaction.error.message, "second setter failed");
  assert.deepEqual(writes, ["first"]);
  assert.deepEqual(rolledBack, ["first"]);

  const rollbackFailure = runStaticBakeColorTransaction({
    applyBaked() { throw new Error("write failed"); },
    restoreOriginal() { throw new Error("restore failed"); },
  });
  assert.equal(rollbackFailure.rolledBack, false);
  assert.equal(rollbackFailure.rollbackError.message, "restore failed");
});

test("static bake UI labels all-splat production and keeps legacy proxy modes opt-in", () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const source = readFileSync(new URL("../viewer.js", import.meta.url), "utf8");
  assert.match(markup, /Bake direct light into SH0\. One visible point light required\./);
  assert.match(markup, /id="static-bake-mode"/);
  assert.match(markup, /All-splat direct \(default\)/);
  assert.match(markup, /Direct \+ authored one bounce \(experimental; 96-source cap\)/);
  assert.match(markup, /Legacy sampled shadow \(32 proxies\)/);
  assert.match(markup, /Legacy 6-VPL bounce preview/);
  assert.doesNotMatch(markup, /id="legacy-sampled-shadow-checkbox"[^>]*checked/);
  assert.doesNotMatch(markup, /id="one-bounce-preview-checkbox"[^>]*checked/);
  assert.match(markup, /Experimental visibility modulation/);
  assert.match(source, /if \(this\.activeLightCount > 0 && !this\.staticBakeApplied\)/);
  assert.match(source, /Indexing exact packed BVH/);
  assert.match(source, /STATIC_BAKE_MODE\.AUTHORED_ONE_BOUNCE/);
  assert.ok(/disableLegacyLightingForAuthoredBounce\(\)[\s\S]*?refreshLightingModel\(\{ forceModifierRebuild: true, occlusionChanged: false \}\)[\s\S]*?syncLightingRuntimeState\(\)[\s\S]*?renderPickedColors\(\)[\s\S]*?invalidateRender\(\)[\s\S]*?queueSparkSceneUpdate\(\)/.test(source), "legacy mode changes preserve the visibility cache and refresh lighting");
  assert.match(source, /unsupportedStaticBakeTransformCount/);
  assert.match(source, /if \(request !== this\.staticBakeRequest\) return;/);
  assert.match(source, /catch \(error\) \{\s*if \(request !== this\.staticBakeRequest\) return;/);
  assert.match(source, /coherent source clusters .*experimental approximation/);
  assert.match(source, /generic splats remained occluders only/);
  assert.match(source, /markStaticBakeStale\("Light, opacity, transform, or visibility changed"\)/);
  assert.ok(/refreshLightingModel\(\{ forceModifierRebuild = false, occlusionChanged = true, geometryChanged = true \} = \{\}\)[\s\S]*?syncLightingRuntimeState\(\);\s*this\.syncStaticBakeUi\(\);/.test(source), "lighting changes synchronize runtime state and bake eligibility");
  assert.match(source, /applyTransformFromGizmo\(\)[\s\S]*?markStaticBakeStale\("Splat transform changed"\)/);
  assert.match(source, /resetTransform\(\)[\s\S]*?markStaticBakeStale\("Splat transform reset"\)/);
  assert.match(source, /Clear the active animation modifier before baking; animation is not captured/);
  assert.match(source, /applyAnimationScript\(announce = true\)[\s\S]*?markStaticBakeStale\("Animation modifier applied"\)/);
  assert.match(source, /playAnimation\(\)[\s\S]*?markStaticBakeStale\("Animation playback started"\)/);
  assert.match(source, /setAnimationTimeFromUi\(commit = false\)[\s\S]*?markStaticBakeStale\("Animation time changed"\)/);
  assert.match(source, /center: sourceCenter\.clone\(\)/);
  assert.match(source, /scales: sourceScales\.clone\(\)/);
  assert.doesNotMatch(source, /records\.push\(\{ item, outputIndex, sourceIndex, splat, splats \}\)/);
});
