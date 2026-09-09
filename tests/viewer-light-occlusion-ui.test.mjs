import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getLightOcclusionTextureLayout } from "../viewer-light-occlusion.mjs";
import { createLightOcclusionWorkerSnapshot } from "../viewer-static-lighting-client.mjs";
import { expandLightSamples, lightVector } from '../viewer-light-types.mjs';

const source = readFileSync(new URL("../viewer.js", import.meta.url), "utf8");
const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const method = (name, bindings = {}) => {
  const start = new RegExp(`^      (?:async )?${name}\\(`, "m").exec(source)?.index;
  assert.ok(start >= 0, name);
  const next = /\n      (?:async )?\w+\(/.exec(source.slice(start));
  return new Function(...Object.keys(bindings), `return ({${source.slice(start, next ? start + next.index : undefined)}}).${name};`)(...Object.values(bindings));
};
const applyResult = method("applyLightOcclusionResult", {
  getLightOcclusionTextureLayout,
  createLightOcclusionTexture: (data, width, height) => ({ data, width, height, dispose() { this.disposed = true; } }),
});
const makeViewer = () => {
  const items = [{ id: "a", count: 2 }, { id: "b", count: 1 }].map((item) => ({
    ...item, visible: true, mesh: {},
    lightOcclusion: { enabled: { value: false }, sampler: {}, count: {}, width: {}, texture: null },
  }));
  return {
    sceneItems: items, sceneLights: [{ id: "left", visible: true }, { id: "right", visible: true }],
    getLightSamples() { return expandLightSamples(this.sceneLights); },
    renderer: { capabilities: { maxTextureSize: 1024 } },
    getSceneItemById(id) { return items.find((item) => item.id === id); },
    getPackedSplatCount(item) { return item.count; },
    getLightOcclusionHandles(item) { return item.lightOcclusion; },
  };
};
const snapshot = { count: 3, itemIds: ["a", "b"], itemIndex: new Uint32Array([1, 0, 0]), sourceIndex: new Uint32Array([0, 1, 0]) };
const result = { lightCount: 2, lightIds: ["left", "right"], total: 3, transmission: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) };

test("visibility atlases scatter by item and stable source index, not scene-wide order", () => {
  const viewer = makeViewer();
  applyResult.call(viewer, snapshot, result, result.lightIds);
  assert.deepEqual([...viewer.sceneItems[0].lightOcclusion.data], [...Float32Array.from([0.5, 0.6, 0.3, 0.4])]);
  assert.deepEqual([...viewer.sceneItems[1].lightOcclusion.data], [...Float32Array.from([0.1, 0.2])]);
  const transmission = method("getCachedLightTransmission");
  assert.equal(transmission(viewer.sceneItems[0], { splatIndex: 1 }, "right"), result.transmission[3]);
  assert.equal(transmission(viewer.sceneItems[0], { splatIndex: 8 }, "right"), null);
  assert.equal(transmission(viewer.sceneItems[0], { splatIndex: 1 }, "missing"), null);
});

test("invalid, duplicated, incomplete, or stale mappings never activate a partial atlas", () => {
  for (const [badSnapshot, badResult] of [
    [{ ...snapshot, sourceIndex: new Uint32Array([0, 1, 1]) }, result],
    [{ ...snapshot, sourceIndex: new Uint32Array([0, 2, 0]) }, result],
    [snapshot, { ...result, lightIds: ["right", "left"] }],
    [snapshot, { ...result, transmission: new Float32Array([0.1, 0.2, NaN, 0.4, 0.5, 0.6]) }],
  ]) {
    const viewer = makeViewer();
    assert.throws(() => applyResult.call(viewer, badSnapshot, badResult, result.lightIds));
    assert.equal(viewer.sceneItems.some((item) => item.lightOcclusion.enabled.value), false);
  }
});

test("invalidation releases textures immediately and debounces replacement work", () => {
  let scheduled = 0, clears = 0, canceled = 0, refreshed = 0;
  const window = { clearTimeout() { clears += 1; }, setTimeout() { scheduled += 1; return scheduled; } };
  const invalidate = method("invalidateLightOcclusion", { window });
  const release = method("releaseLightOcclusion");
  const viewer = makeViewer();
  Object.assign(viewer, {
    lightOcclusionRevision: 0, lightOcclusionTimer: 0, state: { lightOcclusionEnabled: true },
    lightOcclusionController: { cancel() { canceled += 1; } }, lightOcclusionEmptyTexture: {},
    getLightOcclusionAvailability() { return { enabled: true }; }, syncLightOcclusionUi() {},
    renderPickedColors() {}, refreshActiveBackendSnapshot() {},
    releaseLightOcclusion(item) { release.call(this, item); }, forceVisualRefresh() { refreshed += 1; }, queueSparkSceneUpdate() {},
  });
  applyResult.call(viewer, snapshot, result, result.lightIds);
  const oldTexture = viewer.sceneItems[0].lightOcclusion.texture;
  invalidate.call(viewer, "Moved");
  assert.equal(oldTexture.disposed, true);
  assert.equal(viewer.sceneItems[0].lightOcclusion.enabled.value, false);
  assert.equal(viewer.sceneItems[0].lightOcclusion.data, null);
  assert.equal(viewer.lightOcclusionRevision, 1);
  assert.equal(scheduled, 1);
  assert.equal(refreshed, 1);
  invalidate.call(viewer, "Moved again");
  assert.equal(canceled, 2);
  assert.equal(clears, 2);
  assert.equal(viewer.lightOcclusionRevision, 2);
  const immutableSnapshot = {};
  viewer.lightOcclusionSnapshot = immutableSnapshot;
  invalidate.call(viewer, "Light moved", { geometryChanged: false });
  assert.equal(viewer.lightOcclusionSnapshot, immutableSnapshot);
  viewer.state.lightOcclusionEnabled = false;
  invalidate.call(viewer, "Off");
  assert.equal(viewer.lightOcclusionSnapshot, null);
  assert.equal(scheduled, 3);
});

test("a late worker completion cannot apply visibility from an old scene revision", async () => {
  let finish, applied = 0;
  const start = method("startLightOcclusion", { lightVector, createLightOcclusionWorkerSnapshot, performance: { now: () => 0 }, THREE: { Vector3: class {} } });
  const viewer = {
    lightOcclusionRevision: 1, state: { lightOcclusionEnabled: true }, transformControls: {}, sceneItems: [],
    getLightOcclusionAvailability: () => ({ enabled: true, splatCount: 1, lights: [{ id: "left", root: { updateWorldMatrix() {}, getWorldPosition: () => ({ toArray: () => [0, 0, 0] }) } }] }),
    createStaticBakeSnapshot: () => ({ count: 1 }),
    lightOcclusionController: { startOcclusion: () => new Promise((resolve) => { finish = resolve; }) },
    syncLightOcclusionUi() {}, applyLightOcclusionResult() { applied += 1; }, releaseLightOcclusion() {},
  };
  const pending = start.call(viewer);
  viewer.lightOcclusionRevision += 1;
  viewer.lightOcclusionRunning = false;
  finish({ canceled: false });
  await pending;
  assert.equal(applied, 0);
  assert.equal(viewer.lightOcclusionRunning, false);
});

test("occlusion is explicit, scalar-only, and never scheduled from the per-frame lighting sync", () => {
  assert.match(markup, /id="light-occlusion-checkbox" type="checkbox">/);
  assert.match(markup, /id="light-occlusion-update-button"/);
  assert.match(markup, /id="light-occlusion-cancel-button"/);
  assert.match(source, /lightOcclusionEnabled: false/);
  assert.match(source, /texture\.colorSpace = THREE\.NoColorSpace/);
  assert.match(source, /readLightOcclusion\(outputs\.index, lightOcclusionHandles, lightIndex, lightCount\)/);
  assert.doesNotMatch(method("syncLightingRuntimeState").toString(), /startLightOcclusion|invalidateLightOcclusion/);
  assert.match(method("applySelectedLightIntensity").toString(), /occlusionChanged: false/);
  assert.match(method("applySelectedLightColor").toString(), /occlusionChanged: false/);
  assert.doesNotMatch(method("applyLightOcclusionResult").toString(), /setSplat|bakedLinearRgb|linearRgb/);
});
