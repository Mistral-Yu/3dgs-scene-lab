import {
  bakeAllSplatsDirectLightAsync, createDeterministicSplatBvhAsync,
  STATIC_BAKE_MODE, validateStaticBakeSnapshot,
} from "./viewer-static-lighting.mjs";
import { StaticLightingBakeController } from "./viewer-static-lighting-client.mjs";
import { WebGpuOcclusionRunner, WebGpuUnavailableError } from "./viewer-webgpu-occlusion.mjs";

/** GPU visibility with the established reversible, linear-light CPU color assembly.
 * Bake owns its snapshot; neither the geometry nor source RGB is mutated here.
 * Authored bounce keeps the existing Worker until both path legs are migrated.
 */
export class WebGpuStaticLightingBakeController {
  constructor({ runner = new WebGpuOcclusionRunner(), fallback = new StaticLightingBakeController() } = {}) {
    this.runner = runner;
    this.fallback = fallback;
    this.epoch = 0;
    this.tail = Promise.resolve();
  }

  cancel() { this.epoch++; this.fallback.cancel(); }

  start(options = {}) {
    this.cancel();
    const epoch = this.epoch;
    const shouldCancel = () => epoch !== this.epoch;
    const task = this.tail.then(() => this.run(options, shouldCancel));
    this.tail = task.catch(() => {});
    return task;
  }

  async run({ light, mode = STATIC_BAKE_MODE.DIRECT, snapshot, onProgress }, shouldCancel) {
    const canceled = () => ({ canceled: true, phase: "baking", processed: 0, total: snapshot?.count ?? 0 });
    if (shouldCancel()) return canceled();
    const count = validateStaticBakeSnapshot(snapshot);
    if (mode !== STATIC_BAKE_MODE.DIRECT) {
      const result = await this.fallback.start({ light, mode, snapshot, onProgress });
      return shouldCancel() ? canceled() : result;
    }
    try {
      await this.runner.initialize();
      if (shouldCancel()) return canceled();
      const bvh = await createDeterministicSplatBvhAsync(snapshot, {
        onProgress, shouldCancel, yieldToEventLoop: this.runner.yieldToEventLoop,
      });
      if (bvh.canceled || shouldCancel()) return canceled();
      await this.runner.prepare(bvh);
      if (shouldCancel()) return canceled();
      const opticalDepth = new Float32Array(count);
      const position = [0, 1, 2].map(axis => Number.isFinite(Number(light?.position?.[axis])) ? Number(light.position[axis]) : 0);
      const transmission = await this.runner.trace(position, { onProgress, shouldCancel, opticalDepth });
      if (!transmission || shouldCancel()) return canceled();
      const result = await bakeAllSplatsDirectLightAsync({
        light, mode, snapshot, onProgress, shouldCancel,
        yieldToEventLoop: this.runner.yieldToEventLoop,
        precomputedVisibility: { snapshot, bvh, transmission, opticalDepth },
      });
      if (result.canceled || shouldCancel()) return canceled();
      return { ...result, execution: "webgpu", diagnostics: { ...result.diagnostics,
        testedCandidates: null, visibilityBackend: "WebGPU", colorAssembly: "CPU linear RGB",
        precisionFallbackReceivers: this.runner.lastPrecisionFallbackCount,
      } };
    } catch (error) {
      if (shouldCancel()) return canceled();
      if (!(error instanceof WebGpuUnavailableError)) throw error;
      const result = await this.fallback.start({ light, mode, snapshot, onProgress });
      return shouldCancel() ? canceled() : { ...result, fallbackReason: error.message };
    } finally {
      // Completed Bake stores RGB in the viewer, not a persistent shadow atlas.
      // Retain only the compiled pipeline/device for the next Bake.
      this.runner.releaseGeometry();
    }
  }

  dispose() {
    this.cancel();
    this.tail = this.tail.then(() => this.runner.dispose());
    return this.tail;
  }
}
