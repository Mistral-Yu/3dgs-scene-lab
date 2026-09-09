import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "../vendor/three/three.module.js";
import * as ThreeR186 from "three-r186/webgpu";
import { GSplatParams } from "../node_modules/playcanvas/build/playcanvas/src/scene/gsplat-unified/gsplat-params.js";
import { RENDERER_SETTINGS, createRendererSettings, parseRendererSetting, applyThreeRendererSettings, renderRendererSettings, rendererSettingGroup } from "../viewer-renderer-settings.mjs";
import { LookDevBackendManager } from "../viewer-backends.mjs";

test("PlayCanvas controls match the installed engine defaults and invoke real setters", () => {
  const params = new GSplatParams({ isWebGPU: false, getRenderableHdrFormat: () => null });
  const manager = new LookDevBackendManager({ inputCanvas: { classList: { toggle() {} } } });
  const backend = manager.backends.get("playcanvas");
  backend.app = { scene: { gsplat: params } };
  for (const field of RENDERER_SETTINGS.playcanvas.fields) assert.equal(params[field.key], field.value, field.key);
  backend.settings.antiAlias = true;
  backend.settings.minPixelSize = 5;
  backend.settings.alphaClipForward = 0.1;
  backend.settings.dataFormat = "large";
  backend.applySettings();
  assert.equal(params.antiAlias, true);
  assert.equal(params.minPixelSize, 5);
  assert.equal(params.material.getParameter("alphaClipForward").data, 0.1);
  assert.equal(params.dataFormat, "large");
});

test("invalid numeric and checkbox settings are rejected, including empty fields", () => {
  const alpha = RENDERER_SETTINGS.spark.fields.find((f) => f.key === "minAlpha");
  for (const value of ["", " ", "NaN", "Infinity", "-0.1", "1.1"]) assert.equal(parseRendererSetting(alpha, value), null);
  assert.equal(parseRendererSetting(alpha, "0"), 0);
  const threeFields = RENDERER_SETTINGS["three-r186"].fields;
  assert.deepEqual(threeFields.map((field) => field.key), ["sortObjects", "depthTest", "wireframe"]);
  assert.equal(parseRendererSetting(threeFields[0], true), true);
  assert.equal(parseRendererSetting(threeFields[0], false), false);
  assert.equal(parseRendererSetting(threeFields[0], "true"), null);
});

test("LoD budget accepts automatic and integer counts without inventing a platform default", () => {
  const field = RENDERER_SETTINGS.spark.fields.find((f) => f.key === "lodSplatCount");
  assert.equal(createRendererSettings("spark").lodSplatCount, undefined);
  assert.equal(parseRendererSetting(field, ""), undefined);
  assert.equal(parseRendererSetting(field, "2500000"), 2500000);
  assert.equal(parseRendererSetting(field, "0"), null);
  assert.equal(parseRendererSetting(field, "1.5"), null);
});

test("all panels render Quality, Effects, Other in order and reject inverted LoD cones", () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    add(option) { this.children.push(option); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute() {}
    setCustomValidity(message) { this.validationMessage = message; }
    reportValidity() {}
  }
  const doc = globalThis.document, option = globalThis.Option;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  globalThis.Option = class { constructor(label, value) { this.textContent = label; this.value = value; } };
  const descend = (element) => [element, ...(element.children || []).flatMap(descend)];
  try {
    for (const id of Object.keys(RENDERER_SETTINGS)) {
      const container = new Element("div");
      let changes = 0;
      renderRendererSettings(container, id, createRendererSettings(id), () => changes++, () => {});
      const groups = container.children.filter((child) => child.tag === "fieldset");
      assert.deepEqual(groups.map((g) => g.dataset.settingsGroup), ["quality", "effects", "other"]);
      for (const field of RENDERER_SETTINGS[id].fields) {
        const group = groups.find((g) => g.dataset.settingsGroup === rendererSettingGroup(field));
        assert.equal(descend(group).filter((el) => el.dataset?.rendererSetting === field.key).length, 1, field.key);
      }
      if (id === "spark") {
        const cone = descend(container).find((el) => el.dataset?.rendererSetting === "coneFov0");
        cone.value = "130";
        cone.listeners.change();
        assert.match(cone.validationMessage, /greater than/);
        assert.equal(cone.value, "90");
        assert.equal(changes, 0);
      }
    }
  } finally {
    if (doc === undefined) delete globalThis.document; else globalThis.document = doc;
    if (option === undefined) delete globalThis.Option; else globalThis.Option = option;
  }
});

test("a stationary PlayCanvas view is rebuilt when its sorting metric changes", () => {
  const manager = new LookDevBackendManager({ inputCanvas: { classList: { toggle() {} } } });
  const backend = manager.backends.get("playcanvas");
  const stage = {};
  const snapshot = { items: [] };
  backend.app = { scene: { gsplat: { radialSorting: false } } };
  backend.canvas = { parentElement: stage, classList: { add() {} } };
  backend.hasSnapshot = true;
  backend.settingsSnapshot = snapshot;
  backend.settings.radialSorting = true;
  const calls = [];
  backend.dispose = () => { calls.push("dispose"); backend.app = null; backend.hasSnapshot = false; };
  backend.createApplication = (target) => { assert.equal(target, stage); calls.push("ensure"); backend.app = { scene: { gsplat: {} } }; };
  backend.syncSnapshot = (value) => { assert.equal(value, snapshot); calls.push("snapshot"); };
  backend.applySettings();
  assert.deepEqual(calls, ["dispose", "ensure", "snapshot"]);
  assert.equal(backend.app.scene.gsplat.radialSorting, true);
});

test("renderer values survive disposal and default reset does not leak across engines", () => {
  const manager = new LookDevBackendManager({ inputCanvas: { classList: { toggle() {} } } });
  const backend = manager.backends.get("three-r186");
  backend.settings.sortObjects = false;
  backend.dispose();
  assert.equal(backend.settings.sortObjects, false);
  Object.assign(backend.settings, createRendererSettings("three-r186"));
  assert.equal(backend.settings.sortObjects, true);
  assert.equal(manager.backends.get("playcanvas").settings.minPixelSize, 2);
});

test("Three controls preserve official encoded compositing and material flags", () => {
  const backend = { renderer: {}, material: { depthTest: true, wireframe: false }, settings: createRendererSettings("three-r186") };
  backend.settings.sortObjects = false;
  backend.settings.depthTest = false;
  backend.settings.wireframe = true;
  applyThreeRendererSettings(backend, ThreeR186);
  assert.equal(backend.renderer.toneMapping, ThreeR186.NoToneMapping);
  assert.equal(backend.renderer.toneMappingExposure, 1);
  assert.equal(backend.renderer.sortObjects, false);
  assert.equal(backend.material.depthTest, false);
  assert.equal(backend.material.wireframe, true);
  for (const key of ["toneMapping", "toneMappingExposure", "gaussianCutoff", "alphaCutoff", "preBlurVariance"]) {
    assert.equal(key in backend.settings, false, key);
  }
});

const source = readFileSync(new URL("../viewer.js", import.meta.url), "utf8");
function method(name, next, bindings = {}) {
  const start = source.indexOf(`      ${name}(`);
  const end = source.indexOf(`\n      ${next}(`, start);
  assert.ok(start >= 0 && end > start);
  return new Function(...Object.keys(bindings), `return ({ ${source.slice(start, end)} }).${name};`)(...Object.values(bindings));
}

test("explicit pixel ratio overrides device/preset while Auto preserves the existing cap", () => {
  const sync = method("syncRendererPixelRatio", "watchDevicePixelRatio", {
    QUALITY: { balanced: { maxPixelRatio: 1.4 } }, window: { devicePixelRatio: 2 },
  });
  const applied = [];
  const app = { state: { quality: "balanced", renderPixelRatio: 0 }, renderer: { setPixelRatio: (ratio) => applied.push(ratio) } };
  sync.call(app);
  app.state.renderPixelRatio = 0.5;
  sync.call(app);
  app.state.renderPixelRatio = 2;
  sync.call(app);
  app.state.renderPixelRatio = 0;
  sync.call(app);
  assert.deepEqual(applied, [1.4, 0.5, 2, 1.4]);
});

test("Move, Rotate and Scale buttons enable a previously hidden gizmo", () => {
  const select = method("setTransformGizmoMode", "updateTransformGizmoButtons");
  for (const mode of ["translate", "rotate", "scale"]) {
    const app = { state: { showGizmo: false }, getSelectedItem: () => ({}), syncTransformGizmo() {}, updateTransformGizmoButtons() {} };
    select.call(app, mode);
    assert.equal(app.state.showGizmo, true);
    assert.equal(app.state.transformGizmoMode, mode);
  }
});

test("Y and Z scale drags preserve the uniform scale contract and numeric fields", () => {
  const apply = method("applyTransformFromGizmo", "scheduleSelectedTransformRefresh", {
    THREE, SCALE_LIMITS: { min: 0.001, max: 1000 }, clampNumber: (v, { min, max }) => Math.min(max, Math.max(min, v)),
  });
  for (const axis of ["X", "Y", "Z", "XY", "YZ", "XYZ"]) {
    const item = { modelRoot: new THREE.Group(), rotationPivot: new THREE.Group(), transform: {} };
    item.modelRoot.add(item.rotationPivot);
    const component = axis.includes("X") ? "x" : axis.includes("Y") ? "y" : "z";
    item.rotationPivot.scale[component] = 2;
    let syncs = 0;
    const app = {
      state: { transformGizmoMode: "scale" }, transformControls: { axis },
      getSelectedLight: () => null, getSelectedItem: () => item,
      markStaticBakeStale() {}, invalidateLightOcclusion() {}, syncTransformInputs() { syncs++; }, syncAlignUi() {},
      syncActiveBackendItemTransforms() {}, scheduleSelectedTransformRefresh() {}, forceVisualRefresh() {},
    };
    apply.call(app);
    assert.deepEqual(item.rotationPivot.scale.toArray(), [2, 2, 2], axis);
    assert.equal(item.transform.scale, 2);
    assert.equal(app.state.scale, 2);
    assert.equal(syncs, 1);
  }
});

test("overlay clears only the input canvas and restores rendering state on failure", () => {
  const render = method("renderTransformOverlay", "ensureDynoHandleArray");
  const calls = [];
  const renderer = {
    autoClear: true, alpha: 1,
    getClearAlpha() { return this.alpha; }, setClearAlpha(v) { this.alpha = v; },
    setRenderTarget() {}, clear() { calls.push(["clear", this.alpha]); }, clearDepth() {},
    render(scene) { calls.push(scene); throw new Error("draw failed"); },
  };
  const gizmoScene = {};
  assert.throws(() => render.call({ renderer, gizmoScene, transformControlsHelper: { visible: true }, transformControls: {} }, true), /draw failed/);
  assert.deepEqual(calls, [["clear", 0], gizmoScene]);
  assert.equal(renderer.alpha, 1);
  assert.equal(renderer.autoClear, true);
});

test("hiding a dragged gizmo ends the real TransformControls drag before detach", async () => {
  const controlsSource = readFileSync(new URL("../vendor/three/examples/jsm/controls/TransformControls.js", import.meta.url), "utf8")
    .replace("from 'three';", `from '${new URL("../vendor/three/three.module.js", import.meta.url)}';`);
  const { TransformControls } = await import(`data:text/javascript,${encodeURIComponent(controlsSource)}`);
  const controls = new TransformControls(new THREE.PerspectiveCamera());
  controls.attach(new THREE.Group());
  controls.axis = "X";
  controls.dragging = true;
  let cameraEnabled = false;
  controls.addEventListener("dragging-changed", ({ value }) => { cameraEnabled = !value; });
  const sync = method("syncTransformGizmo", "applyTransformFromGizmo");
  sync.call({
    state: { showGizmo: false }, getSelectedItem: () => null, getSelectedLight: () => null,
    transformControls: controls, transformControlsHelper: controls.getHelper(), invalidateRender() {},
  });
  assert.equal(controls.dragging, false);
  assert.equal(controls.object, undefined);
  assert.equal(cameraEnabled, true);
});
