import assert from "node:assert/strict";
import test from "node:test";
import { bakeAllSplatsDirectLightAsync, evaluateBvhTransmission, STATIC_BAKE_MODE } from "../viewer-static-lighting.mjs";
import { WebGpuStaticLightingBakeController } from "../viewer-webgpu-static-lighting.mjs";
import { WebGpuUnavailableError } from "../viewer-webgpu-occlusion.mjs";

const snapshot = () => ({ count: 3, center: new Float32Array([0, 0, 0, 5, 0, 0, 10, 0, 0]),
  scale: new Float32Array(9).fill(0.2), opacity: new Float32Array([0, 0.8, 0]),
  itemIndex: new Uint32Array([0, 1, 2]), sourceIndex: new Uint32Array(3),
  linearRgb: new Float32Array([0.1, 0.2, 0.3, 0.2, 0.4, 0.8, 0.4, 0.5, 0.6]),
  normal: new Float32Array([-1, 0, 0, 1, 0, 0, -1, 0, 0]), hasAuthoredNormal: new Uint8Array([1, 0, 1]) });
const light = { position: [-1, 0, 0], color: [0.1, 0.5, 1], intensity: 12 };
class ReferenceRunner {
  async initialize() {}
  async prepare(bvh) { this.bvh = bvh; }
  yieldToEventLoop = () => Promise.resolve();
  async trace(position, { opticalDepth, shouldCancel }) {
    await this.pause?.();
    if (shouldCancel()) return null;
    return Float32Array.from({ length: this.bvh.count }, (_, index) => {
      const value = evaluateBvhTransmission({ bvh: this.bvh, snapshot: { center: this.bvh.center }, receiverIndex: index, lightPosition: position });
      opticalDepth[index] = value.opticalDepth;
      return value.transmission;
    });
  }
  releaseGeometry() { this.bvh = null; }
  dispose() { this.disposed = true; }
}
const fallback = { cancel() {}, start() { throw new Error("Unexpected fallback"); } };

test("GPU Bake orchestration preserves input RGB and direct reference color semantics", async () => {
  const input = snapshot(), original = input.linearRgb.slice();
  const runner = new ReferenceRunner();
  const controller = new WebGpuStaticLightingBakeController({ runner, fallback });
  const gpu = await controller.start({ snapshot: input, light });
  const cpu = await bakeAllSplatsDirectLightAsync({ snapshot: input, light, yieldToEventLoop: () => Promise.resolve() });
  assert.equal(gpu.execution, "webgpu");
  assert.deepEqual(input.linearRgb, original);
  assert.deepEqual(gpu.transmission, cpu.transmission);
  assert.deepEqual(gpu.opticalDepth, cpu.opticalDepth);
  for (let i = 0; i < original.length; i++) assert.ok(Math.abs(gpu.bakedLinearRgb[i] - cpu.bakedLinearRgb[i]) < 1e-6);
  assert.equal(gpu.diagnostics.authoredReceiverCount, cpu.diagnostics.authoredReceiverCount);
  assert.equal(gpu.diagnostics.testedCandidates, null, "GPU does not invent CPU candidate statistics");
  assert.equal(runner.bvh, null, "Bake does not retain geometry after completion");
  await controller.dispose();
  assert.equal(runner.disposed, true);
});

test("canceled Bake releases geometry and exposes no partial RGB", async () => {
  let entered, resume;
  const ready = new Promise((resolve) => { entered = resolve; });
  const runner = new ReferenceRunner();
  runner.pause = () => { entered(); return new Promise((resolve) => { resume = resolve; }); };
  const controller = new WebGpuStaticLightingBakeController({ runner, fallback });
  const pending = controller.start({ snapshot: snapshot(), light });
  await ready; controller.cancel(); resume();
  const result = await pending;
  assert.equal(result.canceled, true);
  assert.equal(result.bakedLinearRgb, undefined);
  assert.equal(runner.bvh, null);
});

test("missing WebGPU reports a reason while authored bounce retains its Worker route", async () => {
  let calls = 0;
  const runner = new ReferenceRunner();
  runner.initialize = async () => { throw new WebGpuUnavailableError("No adapter"); };
  const controller = new WebGpuStaticLightingBakeController({ runner, fallback: { cancel() {}, async start(options) { calls++; return { canceled: false, execution: "worker", mode: options.mode }; } } });
  const result = await controller.start({ snapshot: snapshot(), light });
  assert.equal(result.fallbackReason, "No adapter");
  const bounce = await controller.start({ snapshot: snapshot(), light, mode: STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE });
  assert.equal(bounce.mode, STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE);
  assert.equal(calls, 2);
});

test("precomputed visibility cannot be attached to another snapshot or carry invalid transmission", async () => {
  const input = snapshot();
  const data = { snapshot: input, bvh: { count: input.count }, transmission: new Float32Array(3).fill(1), opticalDepth: new Float32Array(3) };
  await assert.rejects(bakeAllSplatsDirectLightAsync({ snapshot: snapshot(), light, precomputedVisibility: data }), /immutable bake snapshot/);
  data.transmission[0] = NaN;
  await assert.rejects(bakeAllSplatsDirectLightAsync({ snapshot: input, light, precomputedVisibility: data }), /immutable bake snapshot/);
});
