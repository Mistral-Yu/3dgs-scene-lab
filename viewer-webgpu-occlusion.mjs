import { createDeterministicSplatBvhAsync, evaluateBvhTransmission, validateStaticBakeSnapshot } from "./viewer-static-lighting.mjs";
import { LIGHT_OCCLUSION_MAX_SCALAR_SLOTS, validateLights } from "./viewer-light-occlusion.mjs";
import { StaticLightingBakeController, createMainThreadTaskYield } from "./viewer-static-lighting-client.mjs";
import { directionalRayLength } from './viewer-light-types.mjs';

// Scalars are transmission (NoColorSpace). No color conversion takes place here.
// Threaded BVH traversal has no fixed stack or candidate-count truncation.
export const OCCLUSION_WGSL = /* wgsl */ `
struct Splat { center: vec3f, sigma: f32, item: u32, source: u32, weight: f32, pad: u32 };
struct Node { lower: vec3f, start: u32, upper: vec3f, count: u32, child: u32, escape: u32, pad: vec2u };
struct Params { light: vec3f, start: u32, count: u32, root: u32, stride: u32, rayLength: f32 };
@group(0) @binding(0) var<storage, read> splats: array<Splat>;
@group(0) @binding(1) var<storage, read> nodes: array<Node>;
@group(0) @binding(2) var<storage, read> order: array<u32>;
@group(0) @binding(3) var<storage, read_write> result: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;
fn intersects(node: Node, origin: vec3f, direction: vec3f) -> bool {
  var near = 0.0;
  var far = 1.0;
  for (var axis = 0u; axis < 3u; axis++) {
    let slack = 0.000002 * max(0.000001, max(abs(origin[axis]), max(abs(node.lower[axis]), abs(node.upper[axis]))));
    let lower = node.lower[axis] - slack;
    let upper = node.upper[axis] + slack;
    if (abs(direction[axis]) < 2.220446049250313e-16) {
      if (origin[axis] < lower || origin[axis] > upper) { return false; }
    } else {
      let a = (lower - origin[axis]) / direction[axis];
      let b = (upper - origin[axis]) / direction[axis];
      near = max(near, min(a, b));
      far = min(far, max(a, b));
      if (near > far) { return false; }
    }
  }
  return true;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let local = invocation.x;
  if (local >= params.count) { return; }
  let receiver = splats[params.start + local];
  var origin = params.light;
  if (params.rayLength > 0.0) { origin = receiver.center - params.light * params.rayLength; }
  let direction = receiver.center - origin;
  let lengthSq = dot(direction, direction);
  if (lengthSq <= 2.220446049250313e-16) {
    result[local * params.stride] = 1.0;
    if (params.stride == 2u) { result[local * 2u + 1u] = 0.0; }
    return;
  }
  let distance = sqrt(lengthSq);
  var depth = 0.0;
  var uncertain = false;
  var index = params.root;
  loop {
    if (index == 0xffffffffu) { break; }
    let node = nodes[index];
    if (!intersects(node, origin, direction)) { index = node.escape; continue; }
    if (node.count == 0u) { index = node.child; continue; }
    for (var p = node.start; p < node.start + node.count; p++) {
      let splat = splats[order[p]];
      if (splat.item == receiver.item && splat.source == receiver.source) { continue; }
      if (splat.sigma <= 0.0 || splat.weight <= 0.0) { continue; }
      let t = dot(splat.center - origin, direction) / lengthSq;
      var bias = 0.0;
      if (splat.item == receiver.item) { bias = max(receiver.sigma, splat.sigma); }
      let endpoint = select(0.0001, 0.0, params.rayLength > 0.0);
      let end = min(max(bias / distance, endpoint), 0.49);
      let delta = splat.center - (origin + direction * t);
      let distanceSq = dot(delta, delta);
      let sigmaSq = splat.sigma * splat.sigma;
      // Hard endpoint/support cuts are discontinuous. Mark numerically ambiguous
      // receivers for sparse float64 reference repair instead of changing a cut.
      let supportSq = 9.0 * sigmaSq;
      let tolerance = 0.000002 * max(sigmaSq, sqrt(distanceSq) * distance);
      let nearEndpoint = abs(t - endpoint) <= 0.000002 || abs(t - (1.0 - end)) <= 0.000002;
      if (nearEndpoint && distanceSq <= supportSq + tolerance) { uncertain = true; }
      if (t <= endpoint || t >= 1.0 - end) { continue; }
      if (abs(distanceSq - supportSq) <= tolerance) { uncertain = true; }
      if (distanceSq <= 9.0 * sigmaSq) {
        depth += splat.weight * exp(-0.5 * distanceSq / sigmaSq);
      }
    }
    index = node.escape;
  }
  result[local * params.stride] = select(exp(-min(depth, 104.0)), -1.0, uncertain);
  if (params.stride == 2u) { result[local * 2u + 1u] = depth; }
}`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const canceled = () => ({ canceled: true, transmission: null });
export class WebGpuUnavailableError extends Error {}

// Round bounds outwards, not toward zero: float64 CPU bounds must not cull
// intersections just because their GPU representation is narrower.
const scratch = new DataView(new ArrayBuffer(4));
function outwardFloat(value, upper) {
  scratch.setFloat32(0, value, true);
  const rounded = scratch.getFloat32(0, true);
  if (!Number.isFinite(rounded)) throw new WebGpuUnavailableError("Geometry exceeds float32 range");
  if ((upper && rounded >= value) || (!upper && rounded <= value)) return rounded;
  if (rounded === 0) return upper ? 2 ** -149 : -(2 ** -149);
  const bits = scratch.getUint32(0, true);
  scratch.setUint32(0, bits + ((upper === (rounded > 0)) ? 1 : -1), true);
  return scratch.getFloat32(0, true);
}

/** GPU ABI packing; geometry has already been sanitized by the CPU BVH builder. */
export function packOcclusionBvh(bvh) {
  const splats = new ArrayBuffer(Math.max(32, bvh.count * 32));
  const sf = new Float32Array(splats);
  const su = new Uint32Array(splats);
  for (let i = 0; i < bvh.count; i++) {
    const at = i * 8;
    sf[at] = bvh.center[i * 3];
    sf[at + 1] = bvh.center[i * 3 + 1];
    sf[at + 2] = bvh.center[i * 3 + 2];
    sf[at + 3] = bvh.supportRadius[i] / 3;
    // Absolute coordinates can be representable while local detail is not.
    // Reject sub-ULP geometry instead of turning a blocked ray into length zero.
    if (sf[at + 3] > 0 && [0, 1, 2].some(axis =>
      Math.abs(bvh.center[i * 3 + axis]) * 2 ** -23 > sf[at + 3] * 0.001)) {
      throw new WebGpuUnavailableError("Geometry requires more relative coordinate precision than float32");
    }
    if (!(Math.abs(sf[at]) <= 1e18 && Math.abs(sf[at + 1]) <= 1e18 && Math.abs(sf[at + 2]) <= 1e18 && sf[at + 3] <= 1e18)
      || (bvh.supportRadius[i] > 0 && sf[at + 3] < 1e-18)) {
      throw new WebGpuUnavailableError("Geometry exceeds WebGPU float32 working range");
    }
    su[at + 4] = bvh.itemKey[i];
    su[at + 5] = bvh.sourceKey[i];
    // log1p on CPU avoids loss of tiny opacities in float32 (1 - alpha).
    sf[at + 6] = -Math.log1p(-Math.min(Math.max(bvh.opacity[i], 0), 1 - 1e-6));
  }
  const nodes = new ArrayBuffer(Math.max(48, bvh.nodeCount * 48));
  const nf = new Float32Array(nodes);
  const nu = new Uint32Array(nodes);
  const visit = (index, escape) => {
    if (index < 0) return;
    const at = index * 12;
    for (let axis = 0; axis < 3; axis++) {
      nf[at + axis] = outwardFloat(bvh.bounds[index * 6 + axis], false);
      nf[at + 4 + axis] = outwardFloat(bvh.bounds[index * 6 + 3 + axis], true);
    }
    nu[at + 3] = bvh.leafStart[index];
    nu[at + 7] = bvh.leafLength[index];
    nu[at + 8] = bvh.childLeft[index] < 0 ? 0xffffffff : bvh.childLeft[index];
    nu[at + 9] = escape;
    if (!bvh.leafLength[index]) {
      visit(bvh.childLeft[index], bvh.childRight[index]);
      visit(bvh.childRight[index], escape);
    }
  };
  visit(bvh.root, 0xffffffff);
  return { splats, nodes, order: bvh.order, root: bvh.root < 0 ? 0xffffffff : bvh.root };
}

/** Owns a persistent device and immutable geometry buffers. Calls are serialized. */
export class WebGpuOcclusionRunner {
  constructor({ gpu = globalThis.navigator?.gpu, batchSize = 2048 } = {}) {
    this.gpu = gpu;
    this.batchSize = Math.max(64, Math.min(8192, Math.floor(batchSize) || 2048));
    this.buffers = [];
    this.device = null;
    this.bvh = null;
  }

  async initialize() {
    if (this.device) return;
    if (!this.gpu) throw new WebGpuUnavailableError("WebGPU is unavailable (use HTTPS or localhost)");
    const adapter = await this.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new WebGpuUnavailableError("No WebGPU adapter");
    let device;
    try { device = await adapter.requestDevice(); }
    catch (error) { throw new WebGpuUnavailableError(`WebGPU device unavailable: ${error.message}`); }
    try {
      const module = device.createShaderModule({ label: "All-splat occlusion", code: OCCLUSION_WGSL });
      const compilation = await module.getCompilationInfo();
      const errors = compilation.messages.filter((message) => message.type === "error");
      if (errors.length) throw new Error(errors.map((message) => message.message).join("; "));
      this.pipeline = await device.createComputePipelineAsync({
        label: "Gaussian visibility BVH", layout: "auto", compute: { module, entryPoint: "main" },
      });
      this.device = device;
      this.yieldToEventLoop ??= createMainThreadTaskYield();
      this.lost = false;
      device.lost.then(() => {
        if (this.device === device) { this.lost = true; this.releaseGeometry(); this.device = null; }
      });
    } catch (error) { device.destroy(); throw error; }
  }

  releaseGeometry() {
    this.buffers.forEach((buffer) => buffer.destroy());
    this.buffers = [];
    this.bvh = null;
    this.bindGroup = null;
  }

  dispose() {
    this.releaseGeometry();
    this.device?.destroy();
    this.device = null;
    this.yieldToEventLoop?.dispose();
    this.yieldToEventLoop = null;
  }

  async prepare(bvh) {
    await this.initialize();
    if (this.bvh === bvh) return;
    this.releaseGeometry();
    const device = this.device;
    if (!device) throw new WebGpuUnavailableError("WebGPU device lost before geometry upload");
    const sizes = [Math.max(32, bvh.count * 32), Math.max(48, bvh.nodeCount * 48), Math.max(4, bvh.order.byteLength)];
    if (sizes.some((size) => size > device.limits.maxStorageBufferBindingSize || size > device.limits.maxBufferSize)) {
      throw new WebGpuUnavailableError("Scene exceeds WebGPU storage-buffer limits; no partial shadows");
    }
    const packed = packOcclusionBvh(bvh);
    device.pushErrorScope("validation");
    device.pushErrorScope("out-of-memory");
    let thrown;
    try {
      const upload = (data) => {
        const buffer = device.createBuffer({ size: Math.max(4, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.buffers.push(buffer);
        if (data.byteLength) device.queue.writeBuffer(buffer, 0, data);
        return buffer;
      };
      const geometry = [upload(packed.splats), upload(packed.nodes), upload(packed.order)];
      this.output = device.createBuffer({ size: this.batchSize * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      this.readback = device.createBuffer({ size: this.batchSize * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      this.uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.buffers.push(this.output, this.readback, this.uniform);
      this.bindGroup = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries:
        [...geometry, this.output, this.uniform].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      this.root = packed.root;
    } catch (error) { thrown = error; }
    const memoryError = await device.popErrorScope();
    const validationError = await device.popErrorScope();
    if (this.device !== device) throw new WebGpuUnavailableError("WebGPU device lost during geometry upload");
    if (thrown || memoryError || validationError) {
      this.releaseGeometry();
      throw thrown ?? new Error((memoryError ?? validationError).message);
    }
    this.bvh = bvh;
  }

  async trace(position, { shouldCancel, onProgress, opticalDepth = null, lightDirection = null } = {}) {
    const bvh = this.bvh;
    if (!bvh || !this.device) throw new WebGpuUnavailableError("WebGPU device lost before visibility tracing");
    const count = bvh.count;
    if (opticalDepth && (!(opticalDepth instanceof Float32Array) || opticalDepth.length !== count)) {
      throw new Error("Optical-depth output must match the receiver count");
    }
    const stride = opticalDepth ? 2 : 1;
    this.lastPrecisionFallbackCount = 0;
    const values = new Float32Array(count);
    const params = new ArrayBuffer(32);
    const pf = new Float32Array(params);
    const pu = new Uint32Array(params);
    pf.set(lightDirection ?? position, 0);
    pf[7] = lightDirection ? directionalRayLength(bvh) : 0;
    if (![pf[0], pf[1], pf[2]].every((value) => Number.isFinite(value) && Math.abs(value) <= 1e18)) {
      throw new WebGpuUnavailableError("Light exceeds WebGPU float32 working range");
    }
    pu[5] = this.root;
    pu[6] = stride;
    for (let start = 0; start < count; start += this.batchSize) {
      if (shouldCancel?.()) return null;
      if (this.lost || !this.device) throw new Error("WebGPU device lost; retry Update Shadows");
      const size = Math.min(this.batchSize, count - start);
      pu[3] = start;
      pu[4] = size;
      const device = this.device;
      device.pushErrorScope("validation");
      let thrown;
      try {
        device.queue.writeBuffer(this.uniform, 0, params);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.dispatchWorkgroups(Math.ceil(size / 64));
        pass.end();
        encoder.copyBufferToBuffer(this.output, 0, this.readback, 0, size * stride * 4);
        device.queue.submit([encoder.finish()]);
        await this.readback.mapAsync(GPUMapMode.READ, 0, size * stride * 4);
        const mapped = new Float32Array(this.readback.getMappedRange(0, size * stride * 4));
        if (!opticalDepth) values.set(mapped, start);
        else for (let i = 0; i < size; i++) {
          values[start + i] = mapped[i * 2]; opticalDepth[start + i] = mapped[i * 2 + 1];
        }
      } catch (error) { thrown = error; }
      finally { this.readback?.unmap(); }
      const validationError = await device.popErrorScope();
      if (thrown || validationError) throw thrown ?? new Error(validationError.message);
      for (let index = start; index < start + size; index++) {
        if (values[index] !== -1) continue;
        if (shouldCancel?.()) return null;
        const reference = evaluateBvhTransmission({ bvh, snapshot: { center: bvh.center }, receiverIndex: index, lightPosition: position, lightDirection });
        values[index] = reference.transmission;
        if (opticalDepth) opticalDepth[index] = reference.opticalDepth;
        this.lastPrecisionFallbackCount++;
        if (this.lastPrecisionFallbackCount % 128 === 0) await this.yieldToEventLoop();
      }
      onProgress?.({ phase: "occlusion", processed: start + size, total: count });
      // Allow cancel/input events between bounded submissions (no busy polling).
      await this.yieldToEventLoop();
    }
    if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error("Invalid GPU transmission; result discarded");
    if (opticalDepth?.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Invalid GPU optical depth; result discarded");
    return shouldCancel?.() ? null : values;
  }
}

/** Immutable snapshot identity is the geometry cache key. Never mutate snapshots. */
export class WebGpuLightOcclusionController {
  constructor({ runner = new WebGpuOcclusionRunner(), fallback = new StaticLightingBakeController() } = {}) {
    this.runner = runner;
    this.fallback = fallback;
    this.epoch = 0;
    this.tail = Promise.resolve();
    this.snapshot = null;
    this.lightCache = new Map();
  }

  cancel() { this.epoch++; this.fallback.cancel(); }

  invalidateGeometry() {
    this.cancel();
    this.tail = this.tail.then(() => {
      this.runner.releaseGeometry(); this.snapshot = null; this.bvh = null; this.lightCache.clear();
    });
    return this.tail;
  }

  dispose() {
    this.cancel();
    // Do not destroy a mapped buffer underneath an in-flight trace.
    this.tail = this.tail.then(() => {
      this.runner.dispose(); this.snapshot = null; this.bvh = null; this.lightCache.clear();
    });
    return this.tail;
  }

  startOcclusion(options = {}) {
    this.cancel();
    const epoch = this.epoch;
    const shouldCancel = () => epoch !== this.epoch;
    const task = this.tail.then(() => this.run(options, shouldCancel));
    this.tail = task.catch(() => {});
    return task;
  }

  async run({ snapshot, lights, onProgress }, shouldCancel) {
    const timings = { initializeMs: 0, bvhMs: 0, uploadMs: 0, traceAndReadbackMs: 0, assemblyMs: 0 };
    const startedAt = performance.now();
    if (shouldCancel()) return canceled();
    const total = validateStaticBakeSnapshot(snapshot, { requireRgb: false });
    const { lightIds, positions, directions } = validateLights(lights);
    const lightCount = lightIds.length;
    if (total * lightCount > LIGHT_OCCLUSION_MAX_SCALAR_SLOTS) throw new Error("Light occlusion scalar budget exceeded; no partial shadows");
    try {
      await this.runner.initialize();
      timings.initializeMs = performance.now() - startedAt;
      if (shouldCancel()) return canceled();
      if (this.snapshot !== snapshot) {
        this.snapshot = null; this.bvh = null; this.lightCache.clear();
        const indexingAt = performance.now();
        const bvh = await createDeterministicSplatBvhAsync(snapshot, {
          shouldCancel, onProgress, yieldToEventLoop: this.runner.yieldToEventLoop ?? tick,
        });
        if (bvh.canceled || shouldCancel()) return canceled();
        timings.bvhMs = performance.now() - indexingAt;
        const uploadAt = performance.now();
        await this.runner.prepare(bvh);
        timings.uploadMs = performance.now() - uploadAt;
        if (shouldCancel()) return canceled();
        this.bvh = bvh; this.snapshot = snapshot;
      } else {
        const uploadAt = performance.now();
        await this.runner.prepare(this.bvh);
        timings.uploadMs = performance.now() - uploadAt;
      }
      for (const id of this.lightCache.keys()) if (!lightIds.includes(id)) this.lightCache.delete(id);
      const transmission = new Float32Array(total * lightCount);
      let reusedLights = 0;
      let precisionFallbackReceivers = 0;
      for (let light = 0; light < lightCount; light++) {
        if (shouldCancel()) return canceled();
        const id = lightIds[light];
        const key = JSON.stringify(directions[light] ? ['directional', directions[light]] : positions[light]);
        let entry = this.lightCache.get(id);
        if (entry?.key === key) reusedLights++;
        else {
          const traceAt = performance.now();
          const values = await this.runner.trace(positions[light], { shouldCancel, onProgress, lightDirection: directions[light] });
          timings.traceAndReadbackMs += performance.now() - traceAt;
          if (!values || shouldCancel()) return canceled();
          precisionFallbackReceivers += this.runner.lastPrecisionFallbackCount ?? 0;
          entry = { key, values };
          this.lightCache.set(id, entry);
        }
        const assemblyAt = performance.now();
        for (let index = 0; index < total; index++) transmission[index * lightCount + light] = entry.values[index];
        timings.assemblyMs += performance.now() - assemblyAt;
      }
      return { canceled: false, total, processed: total, lightCount, lightIds, transmission,
        diagnostics: { execution: "WebGPU", reusedLights, precisionFallbackReceivers, bvhNodeCount: this.bvh.nodeCount,
          scalarSlots: total * lightCount, timings, totalMs: performance.now() - startedAt,
          readbackBytes: total * (lightCount - reusedLights) * 4 } };
    } catch (error) {
      if (shouldCancel()) return canceled();
      // Shader/validation errors are bugs, not permission to hide a broken GPU path.
      if (!(error instanceof WebGpuUnavailableError)) throw error;
      const result = await this.fallback.startOcclusion({ snapshot, lights, onProgress });
      if (shouldCancel()) return canceled();
      return { ...result, diagnostics: { ...result.diagnostics, execution: "CPU fallback", fallbackReason: error.message } };
    }
  }
}
