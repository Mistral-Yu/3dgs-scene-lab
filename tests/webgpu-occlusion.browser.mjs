import { computeAllSplatLightTransmissionAsync } from "../viewer-light-occlusion.mjs";
import { testGpuAppearance } from './gpu-appearance.browser.mjs';
import { expandLightSamples } from '../viewer-light-types.mjs';
import { WebGpuLightOcclusionController } from "../viewer-webgpu-occlusion.mjs";
import { createMainThreadTaskYield } from "../viewer-static-lighting-client.mjs";
import { WebGpuStaticLightingBakeController } from "../viewer-webgpu-static-lighting.mjs";
import { bakeAllSplatsDirectLightAsync, STATIC_BAKE_GENERIC_POLICY } from "../viewer-static-lighting.mjs";

const make = (centers, opacity, sameItem = false) => ({ count: centers.length,
  center: Float32Array.from(centers.flat()), scale: new Float32Array(centers.length * 3).fill(0.2),
  opacity: Float32Array.from(opacity), itemIndex: Uint32Array.from(centers, (_, i) => sameItem ? 0 : i % 3),
  sourceIndex: Uint32Array.from(centers, (_, i) => i) });
const lights = [{ id: "left", position: [-2, 0, 0] }, { id: "right", position: [12, 0, 0] },
  { id: "top", position: [4, 5, 0] }, { id: "oblique", position: [3, -3, 2] }];
const assert = (value, message) => { if (!value) throw new Error(message); };

document.querySelector("#run").addEventListener("click", async () => {
  const output = document.querySelector("#result"), button = document.querySelector("#run");
  button.disabled = true; output.textContent = "Running…";
  const records = [];
  const yieldToEventLoop = createMainThreadTaskYield();
  const controller = new WebGpuLightOcclusionController({ fallback: { cancel() {}, startOcclusion() { throw new Error("GPU required: CPU fallback is not a passing GPU test"); } } });
  const baker = new WebGpuStaticLightingBakeController({ fallback: { cancel() {}, start() { throw new Error("GPU Bake required"); } } });
  try {
    let seed = 17;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const centers = Array.from({ length: 2051 }, () => [random() * 10, random() * 2 - 1, random() * 2 - 1]);
    const fixtures = [
      ["empty", make([], [])],
      ["single receiver", make([[0, 0, 0]], [0.8])],
      ["opaque blocker", make([[0, 0, 0], [5, 0, 0], [10, 0, 0]], [0, 1, 0])],
      ["thin transparency", make([[0, 0, 0], [5, 0, 0], [10, 0, 0]], [0, 1e-7, 0])],
      ["same-item endpoint bias", make([[0, 0, 0], [0.01, 0, 0], [5, 0, 0], [10, 0, 0]], [0.8, 0.8, 0.5, 0.8], true)],
      ["endpoint rounding regression", make([centers[706], centers[1303]], [0.7034285664558411, 0], true)],
      ["more than 32 blockers", make(Array.from({ length: 65 }, (_, i) => [i / 8, 0, 0]), Array(65).fill(0.12))],
      ["randomized 2051 receivers / 4 lights / multiple batches", make(centers, centers.map(() => random() * 0.9))],
    ];
    let maximumError = 0;
    for (const [name, snapshot] of fixtures) {
      const cpuStarted = performance.now();
      const cpu = await computeAllSplatLightTransmissionAsync({ snapshot, lights, chunkSize: 2048, yieldToEventLoop });
      const cpuMs = performance.now() - cpuStarted;
      const gpuStarted = performance.now();
      const gpu = await controller.startOcclusion({ snapshot, lights });
      const gpuMs = performance.now() - gpuStarted;
      assert(gpu.diagnostics.execution === "WebGPU", "Not a GPU result");
      let maxError = 0, worstIndex = -1;
      for (let i = 0; i < cpu.transmission.length; i++) {
        assert(Number.isFinite(gpu.transmission[i]), `${name}: invalid value ${i}`);
        const error = Math.abs(cpu.transmission[i] - gpu.transmission[i]);
        if (error > maxError) { maxError = error; worstIndex = i; }
      }
      assert(maxError <= 1e-4, `${name}: error ${maxError} at scalar ${worstIndex}, CPU ${cpu.transmission[worstIndex]}, GPU ${gpu.transmission[worstIndex]} exceeds tolerance`);
      maximumError = Math.max(maximumError, maxError);
      const cacheStarted = performance.now();
      const reordered = await controller.startOcclusion({ snapshot, lights: [...lights].reverse() });
      const cachedMs = performance.now() - cacheStarted;
      assert(reordered.diagnostics.reusedLights === 4, "Cache did not reuse four lights");
      for (let i = 0; i < snapshot.count; i++) for (let l = 0; l < 4; l++) {
        assert(reordered.transmission[i * 4 + l] === gpu.transmission[i * 4 + 3 - l], "Reordered cache mapping changed");
      }
      records.push({ name, maxError, cpuMs: +cpuMs.toFixed(2), gpuMs: +gpuMs.toFixed(2), cachedMs: +cachedMs.toFixed(2), reusedLights: 4,
        precisionFallbackReceivers: gpu.diagnostics.precisionFallbackReceivers, timings: gpu.diagnostics.timings,
        readbackBytes: gpu.diagnostics.readbackBytes });
      output.textContent = JSON.stringify({ status: "running", records }, null, 2);
    }
    const input = fixtures.at(-1)[1];
    const moved = await controller.startOcclusion({ snapshot: input, lights: [{ ...lights[0], position: [-3, 0, 0] }, ...lights.slice(1)] });
    assert(moved.diagnostics.reusedLights === 3, "Moving one light must reuse three others");
    const pending = controller.startOcclusion({ snapshot: input, lights });
    controller.cancel();
    assert((await pending).canceled, "Canceled result was published");
    const duringDispatch = await controller.startOcclusion({ snapshot: input,
      lights: [{ ...lights[0], position: [-4, 0, 0] }],
      onProgress: ({ phase }) => { if (phase === "occlusion") controller.cancel(); },
    });
    assert(duringDispatch.canceled && duringDispatch.transmission === null, "In-flight cancellation published a partial buffer");
    await controller.invalidateGeometry();
    assert(controller.runner.buffers.length === 0, "Geometry buffers not released");
    const oldDevice = controller.runner.device;
    oldDevice.destroy();
    await oldDevice.lost;
    const recovered = await controller.startOcclusion({ snapshot: fixtures[2][1], lights });
    assert(!recovered.canceled && recovered.diagnostics.execution === "WebGPU", "Device recreation failed");
    assert(controller.runner.device !== oldDevice, "Lost device was reused");
    const bakeRecords = [];
    const typedSnapshot = make([[0,0,0],[0,0,1],[1,0,0],[-1,0,0],[0.001,0,1]], [0,1,0,0,0.5]);
    const sun = {id:'sun',type:'directional',position:[0,0,3],direction:[0,0,-1]};
    const panel = {id:'panel',type:'area',position:[0,0,3],direction:[0,0,-1],right:[1,0,0],up:[0,1,0],width:3,height:2,intensity:4,color:[1,1,1]};
    for (const [name, typedLights] of [
      ['parallel + four area rays', [sun,...expandLightSamples([panel])]],
      ['reversed parallel ray', [{...sun,direction:[0,0,1]}]],
      ['oblique parallel ray', [{...sun,direction:[0.2,-0.4,-1]}]],
    ]) {
      const cpu=await computeAllSplatLightTransmissionAsync({snapshot:typedSnapshot,lights:typedLights,yieldToEventLoop});
      const gpu=await controller.startOcclusion({snapshot:typedSnapshot,lights:typedLights});
      const maxError=Math.max(...cpu.transmission.map((v,i)=>Math.abs(v-gpu.transmission[i])));
      assert(maxError<1e-4,`${name}: ${maxError}`);
      assert(gpu.diagnostics.execution==='WebGPU',`${name}: not GPU`);
      records.push({name,maxError});
    }
    const firstSun=await controller.startOcclusion({snapshot:typedSnapshot,lights:[sun]});
    const movedSun=await controller.startOcclusion({snapshot:typedSnapshot,lights:[{...sun,position:[100,200,-100]}]});
    assert(movedSun.diagnostics.reusedLights===1,'Directional helper position changed shadow rays');
    assert(firstSun.transmission.every((v,i)=>v===movedSun.transmission[i]),'Directional position changed transmission');
    for (const policy of [STATIC_BAKE_GENERIC_POLICY.PRESERVE, STATIC_BAKE_GENERIC_POLICY.VISIBILITY_MODULATION]) {
      const snapshot = make([[0, 0, 0], [5, 0, 0], [10, 0, 0]], [0, 0.8, 0]);
      snapshot.linearRgb = new Float32Array([0.1, 0.3, 0.8, 0.2, 0.4, 0.6, 0.6, 0.5, 0.1]);
      snapshot.normal = new Float32Array([-1, 0, 0, 1, 0, 0, -1, 0, 0]);
      snapshot.hasAuthoredNormal = new Uint8Array([1, 0, 1]);
      const original = snapshot.linearRgb.slice();
      const light = { position: [-1, 0, 0], color: [1, 0.2, 0.6], intensity: 12, genericPolicy: policy };
      const cpu = await bakeAllSplatsDirectLightAsync({ snapshot, light, yieldToEventLoop });
      const gpu = await baker.start({ snapshot, light });
      assert(gpu.execution === "webgpu", "Bake did not execute on WebGPU");
      let maxRgbError = 0, maxDepthError = 0;
      for (let i = 0; i < original.length; i++) {
        assert(snapshot.linearRgb[i] === original[i], "Bake mutated source RGB before transaction");
        maxRgbError = Math.max(maxRgbError, Math.abs(cpu.bakedLinearRgb[i] - gpu.bakedLinearRgb[i]));
      }
      for (let i = 0; i < snapshot.count; i++) maxDepthError = Math.max(maxDepthError, Math.abs(cpu.opticalDepth[i] - gpu.opticalDepth[i]));
      assert(maxRgbError < 1e-5 && maxDepthError < 1e-4, "GPU Bake exceeded reference tolerance");
      bakeRecords.push({ policy, maxRgbError, maxDepthError });
    }
    const appearance = await testGpuAppearance();
    output.textContent = JSON.stringify({ status: "PASS", maximumError, records, appearance, movedLightReused: 3,
      cancellation: "PASS (queued and in-flight)", geometryRelease: "PASS", deviceRecovery: "PASS", bakeRecords }, null, 2);
  } catch (error) {
    output.textContent = JSON.stringify({ status: "FAIL", error: error.stack ?? String(error), records }, null, 2);
  } finally { await controller.dispose(); await baker.dispose(); yieldToEventLoop.dispose(); button.disabled = false; }
});
