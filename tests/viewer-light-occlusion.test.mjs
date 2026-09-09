import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  computeAllSplatLightTransmissionAsync,
  getLightOcclusionTextureLayout,
} from "../viewer-light-occlusion.mjs";
import { StaticLightingBakeController, createLightOcclusionWorkerSnapshot } from "../viewer-static-lighting-client.mjs";

const makeSnapshot = ({ centers, opacity = [], scale = 0.5 }) => {
  const count = centers.length;
  return {
    center: Float32Array.from(centers.flat()),
    count,
    itemIndex: Uint32Array.from({ length: count }, (_, index) => index),
    linearRgb: Float32Array.from({ length: count * 3 }, (_, index) => (index + 1) / 10),
    opacity: Float32Array.from(opacity.length ? opacity : Array.from({ length: count }, () => 0)),
    scale: Float32Array.from({ length: count * 3 }, () => scale),
    sourceIndex: Uint32Array.from({ length: count }, (_, index) => index),
  };
};

const compute = (snapshot, lights, options = {}) => computeAllSplatLightTransmissionAsync({
  chunkSize: 2,
  indexingChunkSize: 2,
  lights,
  snapshot,
  yieldToEventLoop: () => Promise.resolve(),
  ...options,
});

const leftLight = { id: "left", position: [0, 0, 0] };
const rightLight = { id: "right", position: [20, 0, 0] };

test("all visible snapshot splats produce blocked and unblocked visibility-only transmissions", async () => {
  const blockedSnapshot = makeSnapshot({
    centers: [[5, 0, 0], [10, 0, 0]],
    opacity: [0.95, 0],
  });
  const blocked = await compute(blockedSnapshot, [leftLight]);
  const unblocked = await compute(makeSnapshot({ centers: [[10, 0, 0]], opacity: [0] }), [leftLight]);

  assert.equal(blocked.canceled, false);
  assert.ok(blocked.transmission instanceof Float32Array);
  assert.equal(blocked.transmission.length, 2);
  assert.ok(blocked.transmission[1] < 0.1);
  assert.equal(unblocked.transmission[0], 1);
  assert.equal("bakedLinearRgb" in blocked, false);
});

test("multiple lights use stable interleaved receiver-major mapping", async () => {
  const snapshot = makeSnapshot({
    centers: [[5, 0, 0], [10, 0, 0]],
    opacity: [0.95, 0],
  });
  const first = await compute(snapshot, [leftLight, rightLight]);
  const repeated = await compute(snapshot, [leftLight, rightLight]);
  const reordered = await compute(snapshot, [rightLight, leftLight]);
  const receiverOffset = 1 * first.lightCount;

  assert.deepEqual(first.lightIds, ["left", "right"]);
  assert.equal(first.lightCount, 2);
  assert.ok(first.transmission[receiverOffset] < 0.1);
  assert.equal(first.transmission[receiverOffset + 1], 1);
  assert.deepEqual([...first.transmission], [...repeated.transmission]);
  assert.deepEqual(reordered.lightIds, ["right", "left"]);
  assert.equal(reordered.transmission[receiverOffset], first.transmission[receiverOffset + 1]);
  assert.equal(reordered.transmission[receiverOffset + 1], first.transmission[receiverOffset]);
});

test("removed and hidden blockers are represented by their own visible snapshots", async () => {
  const visible = makeSnapshot({
    centers: [[5, 0, 0], [10, 0, 0]],
    opacity: [0.95, 0],
  });
  const hidden = makeSnapshot({
    centers: [[5, 0, 0], [10, 0, 0]],
    opacity: [0, 0],
  });
  const removed = makeSnapshot({ centers: [[10, 0, 0]], opacity: [0] });

  const [visibleResult, hiddenResult, removedResult] = await Promise.all([
    compute(visible, [leftLight]),
    compute(hidden, [leftLight]),
    compute(removed, [leftLight]),
  ]);
  assert.ok(visibleResult.transmission[1] < 0.1);
  assert.equal(hiddenResult.transmission[1], 1);
  assert.equal(removedResult.transmission[0], 1);
});

test("all blockers beyond the old 32-proxy threshold participate", async () => {
  const blockerCount = 48;
  const snapshot = makeSnapshot({
    centers: [
      ...Array.from({ length: blockerCount }, (_, index) => [1 + (index * 0.2), 0, 0]),
      [12, 0, 0],
    ],
    opacity: [...Array.from({ length: blockerCount }, () => 0.1), 0],
    scale: 0.08,
  });
  const result = await compute(snapshot, [leftLight]);

  assert.ok(result.diagnostics.testedCandidates > 32);
  assert.ok(result.transmission[blockerCount] < 0.1);
});

test("visibility output does not copy or mutate captured linear RGB", async () => {
  const snapshot = makeSnapshot({
    centers: [[5, 0, 0], [10, 0, 0]],
    opacity: [0.95, 0],
  });
  const originalRgb = new Float32Array(snapshot.linearRgb);
  const result = await compute(snapshot, [leftLight, rightLight]);

  assert.deepEqual([...snapshot.linearRgb], [...originalRgb]);
  assert.equal("bakedLinearRgb" in result, false);
  assert.equal("opticalDepth" in result, false);
});

test("visibility-only worker snapshots omit RGB and material payloads entirely", async () => {
  const original = makeSnapshot({ centers: [[5, 0, 0], [10, 0, 0]], opacity: [0.95, 0] });
  const geometry = createLightOcclusionWorkerSnapshot(original);
  assert.equal("linearRgb" in geometry, false);
  assert.equal("authoredDiffuseAlbedo" in geometry, false);
  assert.ok((await compute(geometry, [leftLight])).transmission[1] < 0.1);
  assert.throws(() => getLightOcclusionTextureLayout({ splatCount: 8_000_001, lightCount: 1, maxTextureSize: 16384 }), /budget/);
  assert.throws(() => getLightOcclusionTextureLayout({ splatCount: 1, lightCount: 9, maxTextureSize: 16384 }), /1 to 8 lights/);
});

test("cancellation is cooperative during indexing and never returns a partial transmission buffer", async () => {
  const snapshot = makeSnapshot({
    centers: Array.from({ length: 8 }, (_, index) => [index + 1, 0, 0]),
    opacity: Array.from({ length: 8 }, () => 0.2),
    scale: 0.1,
  });
  let yields = 0;
  const indexingCanceled = await compute(snapshot, [leftLight], {
    indexingChunkSize: 1,
    shouldCancel: () => yields > 0,
    yieldToEventLoop: () => {
      yields += 1;
      return Promise.resolve();
    },
  });

  assert.equal(indexingCanceled.canceled, true);
  assert.equal(indexingCanceled.phase, "indexing");
  assert.ok(indexingCanceled.processed < indexingCanceled.total);
  assert.equal(indexingCanceled.transmission, null);

  let phase = "indexing";
  let occlusionYields = 0;
  const occlusionCanceled = await compute(snapshot, [leftLight], {
    chunkSize: 1,
    indexingChunkSize: 32,
    onProgress: (progress) => { phase = progress.phase; },
    shouldCancel: () => phase === "occlusion" && occlusionYields > 0,
    yieldToEventLoop: () => {
      if (phase === "occlusion") occlusionYields += 1;
      return Promise.resolve();
    },
  });
  assert.equal(occlusionCanceled.canceled, true);
  assert.equal(occlusionCanceled.phase, "occlusion");
  assert.equal(occlusionCanceled.transmission, null);
});

test("limits and input contracts reject before expensive indexing or allocation", async () => {
  const snapshot = makeSnapshot({ centers: [[1, 0, 0]], opacity: [0] });
  const tooManyLights = Array.from({ length: 9 }, (_, index) => ({ id: `light-${index}`, position: [index, 0, 0] }));
  const progress = [];
  await assert.rejects(
    compute(snapshot, tooManyLights, { onProgress: (entry) => progress.push(entry) }),
    /at most 8 light samples/,
  );
  assert.deepEqual(progress, []);

  const overBudgetCount = 1_000_001;
  const overBudgetSnapshot = {
    center: { length: overBudgetCount * 3 },
    count: overBudgetCount,
    itemIndex: { length: overBudgetCount },
    linearRgb: { length: overBudgetCount * 3 },
    opacity: { length: overBudgetCount },
    scale: { length: overBudgetCount * 3 },
    sourceIndex: { length: overBudgetCount },
  };
  await assert.rejects(
    compute(overBudgetSnapshot, tooManyLights.slice(0, 8), { onProgress: (entry) => progress.push(entry) }),
    /8,000,000 all-or-nothing budget/,
  );
  assert.deepEqual(progress, []);

  await assert.rejects(compute(snapshot, [{ id: "same", position: [0, 0, 0] }, { id: "same", position: [1, 0, 0] }]), /must be unique/);
  await assert.rejects(compute(snapshot, [{ id: "bad", position: [NaN, 0, 0] }]), /finite/);

  snapshot.unsupportedStaticBakeTransformCount = 1;
  await assert.rejects(compute(snapshot, [leftLight]), /non-uniform, sheared, or mirrored/);
});

test("texture layout is bounded by power-of-two width and device capacity", () => {
  assert.deepEqual(getLightOcclusionTextureLayout({ splatCount: 3, lightCount: 2, maxTextureSize: 4096 }), {
    height: 1,
    texelCount: 6,
    width: 8,
  });
  const layout = getLightOcclusionTextureLayout({ splatCount: 1025, lightCount: 1, maxTextureSize: 1024 });
  assert.equal(layout.width, 1024);
  assert.equal(layout.height, 2);
  assert.equal(layout.width & (layout.width - 1), 0);
  assert.throws(
    () => getLightOcclusionTextureLayout({ splatCount: 1_048_577, lightCount: 1, maxTextureSize: 1024 }),
    /device capacity/,
  );
});

test("controller dispatches an occlusion worker job and file mode uses the cooperative fallback", async () => {
  class FakeWorker {
    constructor() {
      this.listeners = new Map();
      FakeWorker.instance = this;
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    postMessage(message) {
      this.message = message;
      if (message.type !== "occlusion") return;
      queueMicrotask(() => this.listeners.get("message")?.({ data: {
        jobId: message.jobId,
        result: {
          canceled: false,
          diagnostics: { bvhNodeCount: 1, lightCount: 2, scalarSlots: 4, testedCandidates: 2 },
          lightCount: 2,
          lightIds: ["left", "right"],
          processed: 2,
          total: 2,
          transmission: new Float32Array([1, 1, 0.1, 1]),
        },
        type: "complete",
      } }));
    }
    terminate() { this.terminated = true; }
  }

  const snapshot = makeSnapshot({ centers: [[5, 0, 0], [10, 0, 0]], opacity: [0.95, 0] });
  const workerController = new StaticLightingBakeController({ WorkerClass: FakeWorker });
  const workerResult = await workerController.startOcclusion({ lights: [leftLight, rightLight], snapshot });
  assert.equal(workerResult.execution, "worker");
  assert.equal(FakeWorker.instance.message.type, "occlusion");
  assert.equal("light" in FakeWorker.instance.message, false);
  assert.ok(Math.abs(workerResult.transmission[2] - 0.1) < 1e-6);

  class ForbiddenWorker {
    constructor() { throw new Error("file mode must not create a Worker"); }
  }
  const fileController = new StaticLightingBakeController({ protocol: "file:", WorkerClass: ForbiddenWorker });
  const fileResult = await fileController.startOcclusion({ lights: [leftLight, rightLight], snapshot });
  assert.equal(fileResult.execution, "main-thread-fallback");
  assert.equal(fileResult.workerFailure, "Local file mode");
  assert.equal("bakedLinearRgb" in fileResult, false);

  const workerSource = readFileSync(new URL("../viewer-static-lighting-worker.mjs", import.meta.url), "utf8");
  assert.match(workerSource, /operation === "occlusion"\s*\? \[result\.transmission\.buffer\]/);
});
