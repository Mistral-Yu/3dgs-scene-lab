import assert from "node:assert/strict";
import test from "node:test";
import { createDeterministicSplatBvhAsync, evaluateBvhTransmission } from "../viewer-static-lighting.mjs";
import { packOcclusionBvh, WebGpuLightOcclusionController, WebGpuOcclusionRunner, WebGpuUnavailableError } from "../viewer-webgpu-occlusion.mjs";

const snapshot = () => ({ count: 3, center: new Float32Array([0, 0, 0, 5, 0, 0, 10, 0, 0]),
  scale: new Float32Array(9).fill(0.5), opacity: new Float32Array([0, 0.75, 0]),
  itemIndex: new Uint32Array([0, 1, 2]), sourceIndex: new Uint32Array([0, 0, 0]) });
const lights = [{ id: "a", position: [-1, 0, 0] }, { id: "b", position: [12, 0, 0] }];

// This CPU-backed double tests ownership/scheduling only, not GPU correctness.
class ReferenceRunner {
  constructor() { this.traces = 0; this.preparations = 0; }
  async initialize() {}
  async prepare(bvh) { if (this.bvh !== bvh) this.preparations++; this.bvh = bvh; }
  async trace(position, { shouldCancel } = {}) {
    this.traces++;
    await this.pause?.();
    if (shouldCancel?.()) return null;
    return Float32Array.from({ length: this.bvh.count }, (_, receiverIndex) => evaluateBvhTransmission({
      bvh: this.bvh, snapshot: { center: this.bvh.center }, receiverIndex, lightPosition: position,
    }).transmission);
  }
  releaseGeometry() { this.bvh = null; }
  dispose() { this.disposed = true; this.releaseGeometry(); }
}
const fallback = { cancel() {}, startOcclusion() { throw new Error("Unexpected CPU fallback"); } };

test('lost device rejects explicitly before dereferencing geometry or device limits', async () => {
  const runner = new WebGpuOcclusionRunner();
  await assert.rejects(runner.trace([0,0,0]), WebGpuUnavailableError);
  runner.initialize = async () => {};
  await assert.rejects(runner.prepare({}), WebGpuUnavailableError);
  runner.dispose();
});

test('float32 relative precision never silently collapses a locally blocked ray', async () => {
  const input = snapshot();
  input.center = new Float64Array([1e15-10,0,0, 1e15,0,0, 1e15+10,0,0]);
  const bvh = await createDeterministicSplatBvhAsync(input);
  assert.throws(()=>packOcclusionBvh(bvh), /relative coordinate precision/);
});

test("GPU packing preserves identity, optical weight and conservatively rounded bounds", async () => {
  const input = snapshot();
  const bvh = await createDeterministicSplatBvhAsync(input);
  const packed = packOcclusionBvh(bvh);
  const sf = new Float32Array(packed.splats), su = new Uint32Array(packed.splats);
  assert.equal(su[12], 1);
  assert.ok(Math.abs(sf[14] - -Math.log1p(-0.75)) < 1e-7);
  for (let node = 0; node < bvh.nodeCount; node++) {
    const nf = new Float32Array(packed.nodes);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(nf[node * 12 + axis] <= bvh.bounds[node * 6 + axis]);
      assert.ok(nf[node * 12 + 4 + axis] >= bvh.bounds[node * 6 + 3 + axis]);
    }
  }
});

test("threaded traversal visits every leaf once in original deterministic order", async () => {
  const count = 513;
  const input = { count, center: Float32Array.from({ length: count * 3 }, (_, i) => Math.sin(i) * 12),
    scale: new Float32Array(count * 3).fill(0.1234567), opacity: new Float32Array(count).fill(0.2),
    itemIndex: new Uint32Array(count), sourceIndex: Uint32Array.from({ length: count }, (_, i) => i) };
  const bvh = await createDeterministicSplatBvhAsync(input);
  const packed = packOcclusionBvh(bvh), nodes = new Uint32Array(packed.nodes);
  const visited = [], expected = [], nodeSet = new Set();
  const visit = (node) => {
    if (bvh.leafLength[node]) expected.push(...bvh.order.subarray(bvh.leafStart[node], bvh.leafStart[node] + bvh.leafLength[node]));
    else { visit(bvh.childLeft[node]); visit(bvh.childRight[node]); }
  };
  visit(bvh.root);
  for (let node = packed.root; node !== 0xffffffff;) {
    assert.ok(!nodeSet.has(node), "escape graph must not cycle"); nodeSet.add(node);
    const start = nodes[node * 12 + 3], length = nodes[node * 12 + 7];
    if (length) visited.push(...packed.order.subarray(start, start + length));
    node = nodes[node * 12 + (length ? 9 : 8)];
  }
  assert.deepEqual(visited, expected);
  assert.equal(new Set(visited).size, count);
});

test("GPU packing rejects float32 underflow and overflow instead of losing blockers", async () => {
  for (const scale of [1e-40, 1e20]) {
    const input = snapshot();
    input.scale = new Float64Array(9).fill(scale);
    const bvh = await createDeterministicSplatBvhAsync(input);
    assert.throws(() => packOcclusionBvh(bvh), WebGpuUnavailableError);
  }
});

test("unchanged lights and geometry reuse work; light reorder preserves scalar mapping", async () => {
  const runner = new ReferenceRunner();
  const controller = new WebGpuLightOcclusionController({ runner, fallback });
  const input = snapshot();
  const first = await controller.startOcclusion({ snapshot: input, lights });
  assert.equal(runner.traces, 2);
  const reordered = await controller.startOcclusion({ snapshot: input, lights: [...lights].reverse() });
  assert.equal(reordered.diagnostics.reusedLights, 2);
  assert.equal(runner.traces, 2);
  assert.equal(runner.preparations, 1);
  for (let index = 0; index < input.count; index++) {
    assert.equal(reordered.transmission[index * 2], first.transmission[index * 2 + 1]);
    assert.equal(reordered.transmission[index * 2 + 1], first.transmission[index * 2]);
  }
  await controller.startOcclusion({ snapshot: input, lights: [lights[0], { ...lights[1], position: [4, 5, 6] }] });
  assert.equal(runner.traces, 3);
  await controller.startOcclusion({ snapshot: snapshot(), lights });
  assert.equal(runner.traces, 5);
  assert.equal(runner.preparations, 2);
  await controller.dispose();
  assert.equal(runner.disposed, true);
});

test("canceled work publishes no partial buffer and subsequent job can reuse valid work", async () => {
  const runner = new ReferenceRunner();
  const controller = new WebGpuLightOcclusionController({ runner, fallback });
  let entered, resume;
  const waiting = new Promise((resolve) => { entered = resolve; });
  runner.pause = () => { entered(); return new Promise((resolve) => { resume = resolve; }); };
  const input = snapshot();
  const first = controller.startOcclusion({ snapshot: input, lights });
  await waiting;
  controller.cancel();
  resume(); runner.pause = null;
  assert.deepEqual(await first, { canceled: true, transmission: null });
  const next = await controller.startOcclusion({ snapshot: input, lights });
  assert.equal(next.canceled, false);
  assert.equal(next.transmission.length, 6);
  await controller.invalidateGeometry();
  assert.equal(runner.bvh, null);
  assert.equal(controller.lightCache.size, 0);
});

test("unavailable GPU reports explicit fallback, but shader bugs remain errors", async () => {
  let calls = 0;
  const runner = new ReferenceRunner();
  runner.initialize = async () => { throw new WebGpuUnavailableError("No adapter"); };
  const controller = new WebGpuLightOcclusionController({ runner, fallback: { cancel() {}, async startOcclusion() { calls++; return { canceled: false }; } } });
  const result = await controller.startOcclusion({ snapshot: snapshot(), lights });
  assert.equal(result.diagnostics.execution, "CPU fallback");
  assert.equal(result.diagnostics.fallbackReason, "No adapter");
  runner.initialize = async () => { throw new Error("shader compile failure"); };
  await assert.rejects(controller.startOcclusion({ snapshot: snapshot(), lights }), /shader compile failure/);
  assert.equal(calls, 1);
});

test("invalid requests fail before GPU allocation", async () => {
  const runner = new ReferenceRunner();
  runner.initialize = async () => { throw new Error("Should not allocate"); };
  const controller = new WebGpuLightOcclusionController({ runner, fallback });
  await assert.rejects(controller.startOcclusion({ snapshot: snapshot(), lights: [lights[0], lights[0]] }), /unique/);
  await assert.rejects(controller.startOcclusion({ snapshot: snapshot(), lights: [{ id: "a", position: [NaN, 0, 0] }] }), /finite/);
});
