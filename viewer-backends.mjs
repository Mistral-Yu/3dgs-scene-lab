import {
  RENDERER_MANIFEST,
  SH_C0,
  decomposeWorldMatrix,
  flattenVisibleSnapshot,
  updateFlattenedSnapshotItemTransforms,
} from "./renderer-contract.mjs";
import { linearToSrgbChannel } from "./viewer-color.mjs";
import { createRendererSettings, applyThreeRendererSettings } from "./viewer-renderer-settings.mjs";
import { APPEARANCE_WIDTH, PC_APPEARANCE_MODIFIER, appearanceSupported,
  packAppearance, packAppearanceReceivers, updateAppearanceVisibility } from "./viewer-gpu-appearance.mjs";

const EXPECTED_THREE_REVISION = "186";
const BACKEND_VENDOR_DEFINITIONS = Object.freeze({
  playcanvas: Object.freeze({
    globalName: "__SPATIAL_LOOKDEV_PLAYCANVAS__",
    source: "viewer-vendor-playcanvas.bundle.js",
  }),
  "three-r186": Object.freeze({
    globalName: "__SPATIAL_LOOKDEV_THREE_R186__",
    source: "viewer-vendor-three-r186.bundle.js",
  }),
});
const backendVendorPromises = new Map();
const appearanceIdentity = state => ({ ...state, visibility: state.visibility
  ? { data: state.visibility.data, lightIds: [...state.visibility.lightIds] } : null });
let PlayCanvas = globalThis.__SPATIAL_LOOKDEV_PLAYCANVAS__ ?? null;
let ThreeR186 = globalThis.__SPATIAL_LOOKDEV_THREE_R186__ ?? null;

const assignBackendVendor = (id, namespace) => {
  if (id === "playcanvas") PlayCanvas = namespace;
  if (id === "three-r186") ThreeR186 = namespace;
  return namespace;
};

const loadBackendVendor = (id, {
  documentRef = globalThis.document,
  globalRef = globalThis,
} = {}) => {
  const definition = BACKEND_VENDOR_DEFINITIONS[id];
  if (!definition) {
    return Promise.reject(new Error(`No lazy vendor bundle is configured for ${id}`));
  }
  const loaded = globalRef[definition.globalName];
  if (loaded) return Promise.resolve(assignBackendVendor(id, loaded));
  if (backendVendorPromises.has(id)) return backendVendorPromises.get(id);
  if (!documentRef?.createElement || !documentRef.head) {
    return Promise.reject(new Error(`Cannot load ${id} outside a browser document`));
  }
  const promise = new Promise((resolve, reject) => {
    const script = documentRef.createElement("script");
    script.async = true;
    script.dataset.lookdevVendor = id;
    script.src = new URL(definition.source, documentRef.baseURI).href;
    script.addEventListener("load", () => {
      const namespace = globalRef[definition.globalName];
      if (!namespace) {
        script.remove();
        reject(new Error(`${id} vendor bundle loaded without registering its namespace`));
        return;
      }
      resolve(assignBackendVendor(id, namespace));
    }, { once: true });
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error(`Failed to load ${id} vendor bundle`));
    }, { once: true });
    documentRef.head.append(script);
  }).catch((error) => {
    backendVendorPromises.delete(id);
    throw error;
  });
  backendVendorPromises.set(id, promise);
  return promise;
};

const colorFromHex = (value) => {
  const hex = String(value || "#061019").replace("#", "");
  const parsed = Number.parseInt(hex.length === 3
    ? hex.split("").map((channel) => `${channel}${channel}`).join("")
    : hex.slice(0, 6), 16);
  return [
    ((parsed >> 16) & 255) / 255,
    ((parsed >> 8) & 255) / 255,
    (parsed & 255) / 255,
  ];
};

const createGsplatData = (item) => {
  const count = item.opacity.length;
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const z = new Float32Array(count);
  const rot0 = new Float32Array(count);
  const rot1 = new Float32Array(count);
  const rot2 = new Float32Array(count);
  const rot3 = new Float32Array(count);
  const scale0 = new Float32Array(count);
  const scale1 = new Float32Array(count);
  const scale2 = new Float32Array(count);
  const fdc0 = new Float32Array(count);
  const fdc1 = new Float32Array(count);
  const fdc2 = new Float32Array(count);
  const opacity = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const offset3 = index * 3;
    const offset4 = index * 4;
    x[index] = item.center[offset3];
    y[index] = item.center[offset3 + 1];
    z[index] = item.center[offset3 + 2];
    rot0[index] = item.quaternion[offset4 + 3];
    rot1[index] = item.quaternion[offset4];
    rot2[index] = item.quaternion[offset4 + 1];
    rot3[index] = item.quaternion[offset4 + 2];
    scale0[index] = item.scale[offset3];
    scale1[index] = item.scale[offset3 + 1];
    scale2[index] = item.scale[offset3 + 2];
    // GSplat SH coefficients describe display-encoded RGB, not linear RGB.
    fdc0[index] = (linearToSrgbChannel(item.linearRgb[offset3]) - 0.5) / SH_C0;
    fdc1[index] = (linearToSrgbChannel(item.linearRgb[offset3 + 1]) - 0.5) / SH_C0;
    fdc2[index] = (linearToSrgbChannel(item.linearRgb[offset3 + 2]) - 0.5) / SH_C0;
    opacity[index] = Math.max(0, item.opacity[index] * item.opacityMultiplier);
  }
  const data = new PlayCanvas.GSplatData([{
    name: "vertex",
    count,
    properties: [
      { name: "x", type: "float", byteSize: 4, storage: x },
      { name: "y", type: "float", byteSize: 4, storage: y },
      { name: "z", type: "float", byteSize: 4, storage: z },
      { name: "rot_0", type: "float", byteSize: 4, storage: rot0 },
      { name: "rot_1", type: "float", byteSize: 4, storage: rot1 },
      { name: "rot_2", type: "float", byteSize: 4, storage: rot2 },
      { name: "rot_3", type: "float", byteSize: 4, storage: rot3 },
      { name: "scale_0", type: "float", byteSize: 4, storage: scale0 },
      { name: "scale_1", type: "float", byteSize: 4, storage: scale1 },
      { name: "scale_2", type: "float", byteSize: 4, storage: scale2 },
      { name: "f_dc_0", type: "float", byteSize: 4, storage: fdc0 },
      { name: "f_dc_1", type: "float", byteSize: 4, storage: fdc1 },
      { name: "f_dc_2", type: "float", byteSize: 4, storage: fdc2 },
      { name: "opacity", type: "float", byteSize: 4, storage: opacity },
    ],
  }]);
  // Activated data stores direct scale and alpha values. It is the public
  // PlayCanvas GSplatData form, not an undocumented Spark conversion.
  data.activated = true;
  return data;
};

const setEntityTransform = (entity, worldMatrix) => {
  const { position, quaternion, scale } = decomposeWorldMatrix(worldMatrix);
  entity.setLocalPosition(position[0], position[1], position[2]);
  entity.setLocalRotation(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  entity.setLocalScale(scale[0], scale[1], scale[2]);
};

class PlayCanvasBackend {
  get supportsGpuAppearance() { return true; }
  constructor({ onFrameRequest = null, onError = null } = {}) {
    this.settings = createRendererSettings("playcanvas");
    this.canvas = null;
    this.app = null;
    this.cameraEntity = null;
    this.root = null;
    this.resources = [];
    this.needsSystemUpdate = false;
    this.onFrameRequest = onFrameRequest;
    this.onError = onError;
    this.frameRequestEvent = null;
    this.sortReadyEvent = null;
    this.hasSnapshot = false;
    this.lifecycle = 0;
    this.initializing = null;
    this.rebuilding = null;
  }

  async ensure(stage) {
    if (this.app) return true;
    if (this.initializing) return this.initializing;
    const lifecycle = ++this.lifecycle;
    const canvas = document.createElement("canvas");
    const pending = (async () => {
      const device = globalThis.navigator?.gpu
        ? await PlayCanvas.createGraphicsDevice(canvas, {
          deviceTypes: [PlayCanvas.DEVICETYPE_WEBGPU], antialias: false, alpha: false,
          powerPreference: "high-performance",
        })
        : null;
      if (lifecycle !== this.lifecycle) { device?.destroy(); return false; }
      if (device?.deviceType === PlayCanvas.DEVICETYPE_NULL) {
        device.destroy(); throw new Error("No usable PlayCanvas graphics device");
      }
      this.createApplication(stage, device, canvas);
      return true;
    })();
    this.initializing = pending;
    try { return await pending; }
    finally { if (this.initializing === pending) this.initializing = null; }
  }

  createApplication(stage, graphicsDevice = null, canvas = null) {
    this.canvas = canvas ?? document.createElement("canvas");
    this.canvas.className = "lookdev-backend-canvas";
    this.canvas.dataset.backendCanvas = "playcanvas";
    stage.append(this.canvas);
    this.app = new PlayCanvas.Application(this.canvas, {
      ...(graphicsDevice ? { graphicsDevice } : {}),
      graphicsDeviceOptions: { antialias: false, alpha: false, powerPreference: "high-performance" },
    });
    this.canvas.dataset.graphicsApi = this.app.graphicsDevice.isWebGPU ? "webgpu" : "webgl2";
    this.app.graphicsDevice.wgpu?.addEventListener('uncapturederror', event => {
      console.error('PlayCanvas WebGPU:', event.error.message);
    });
    // PlayCanvas defaults to resizing its canvas against the browser window.
    // This viewer embeds the canvas in a stage, so window-sized inline CSS
    // dimensions would overflow the stage and shift the projected scene.
    this.app.setCanvasFillMode(PlayCanvas.FILLMODE_NONE);
    this.app.setCanvasResolution(PlayCanvas.RESOLUTION_FIXED, 1, 1);
    this.app.start();
    // Application.start() initializes component systems but also owns a
    // permanent RAF. Rendering is driven by the viewer's invalidation loop,
    // so cancel the PlayCanvas tick and issue explicit frames in syncFrame().
    PlayCanvas.AppBase.cancelTick(this.app);
    this.app.autoRender = false;
    this.frameRequestEvent = this.app.systems.gsplat?.on("frame:request", () => this.onFrameRequest?.()) ?? null;
    // A CPU sort can finish after the host viewer has gone idle. Unlike
    // frame:request, this scene event is emitted directly by the sort worker,
    // so it can restart the viewer's invalidation loop without a PlayCanvas RAF.
    this.sortReadyEvent = this.app.scene.on("gsplat:sorted", () => this.onFrameRequest?.());
    this.root = new PlayCanvas.Entity("Spatial LookDev snapshot");
    this.app.root.addChild(this.root);
    this.cameraEntity = new PlayCanvas.Entity("LookDev Camera");
    this.cameraEntity.addComponent("camera", { clearColor: new PlayCanvas.Color(0.024, 0.063, 0.098, 1) });
    // Preserve the encoded splat colors without a gamma-2.2 decode/encode
    // round trip or an implicit tone mapper. Matches native sRGB splat blending.
    this.cameraEntity.camera.gammaCorrection = PlayCanvas.GAMMA_SRGB;
    this.cameraEntity.camera.toneMapping = PlayCanvas.TONEMAP_NONE;
    this.cameraEntity.camera.horizontalFov = false;
    this.app.root.addChild(this.cameraEntity);
    this.applySettings();
  }

  applySettings() {
    if (this.app && !this.app.graphicsDevice?.isWebGPU && this.hasSnapshot && this.app.scene.gsplat.radialSorting !== this.settings.radialSorting) {
      // CPU sorting is otherwise triggered by camera/placement changes. Recreate
      // through public APIs so changing the metric also sorts a stationary view.
      const stage = this.canvas.parentElement;
      const snapshot = this.settingsSnapshot;
      this.dispose();
      this.createApplication(stage);
      this.syncSnapshot(snapshot);
      this.canvas.classList.add("is-active-backend");
    }
    if (this.app) Object.assign(this.app.scene.gsplat, this.settings);
    this.onFrameRequest?.();
  }

  clear() {
    this.resources.forEach(({ entity, resource, appearance }) => {
      appearance?.params.destroy(); appearance?.receivers.destroy();
      entity.destroy();
      resource.destroy?.();
    });
    this.resources = [];
  }

  syncSnapshot(snapshot) {
    if (!this.app) {
      return;
    }
    this.settingsSnapshot = snapshot;
    if (this.rebuilding) return;
    const visibleItems = snapshot.items.filter((item) => item.visible && item.opacity.length);
    const resourcesById = new Map(this.resources.map((entry) => [entry.id, entry]));
    const topologyMatches = visibleItems.length === this.resources.length
      && visibleItems.every((item) => resourcesById.get(item.id)?.resource?.numSplats === item.opacity.length);
    if (!topologyMatches && this.hasSnapshot && this.app.graphicsDevice.isWebGPU) {
      this.rebuildWebGpuSnapshot();
      return;
    }
    if (!topologyMatches && this.hasSnapshot && !this.app.graphicsDevice.isWebGPU) {
      // Unified GSplat keeps a packed world buffer whose placement topology is
      // not reliably replaced after its permanent RAF has been cancelled.
      // Topology edits are infrequent, so rebuild only this backend; appearance
      // edits with stable ids/counts continue through the fast texture path.
      const stage = this.canvas?.parentElement;
      this.dispose();
      this.createApplication(stage);
      this.canvas.classList.add("is-active-backend");
      this.syncSnapshot(snapshot);
      return;
    }
    let placementsChanged = false;
    const nextResources = visibleItems.map((item) => {
      let entry = resourcesById.get(item.id);
      if (entry?.resource?.numSplats === item.opacity.length) {
        const data = createGsplatData(item);
        entry.resource.updateColorData(data);
        entry.resource.updateTransformData(data);
        setEntityTransform(entry.entity, item.worldMatrix);
        entry.entity.gsplat.workBufferUpdate = PlayCanvas.WORKBUFFER_UPDATE_ONCE;
        this.installAppearance(entry, item);
        resourcesById.delete(item.id);
        return entry;
      }
      if (entry) {
        entry.appearance?.params.destroy(); entry.appearance?.receivers.destroy();
        entry.entity.destroy();
        entry.resource.destroy?.();
        resourcesById.delete(item.id);
      }
      const resource = new PlayCanvas.GSplatResource(this.app.graphicsDevice, createGsplatData(item));
      const entity = new PlayCanvas.Entity(item.name);
      this.root.addChild(entity);
      setEntityTransform(entity, item.worldMatrix);
      entity.addComponent("gsplat", {
        resource,
        castShadows: false,
      });
      placementsChanged = true;
      entry = { entity, id: item.id, resource };
      this.installAppearance(entry, item);
      return entry;
    });
    resourcesById.forEach(({ entity, resource, appearance }) => {
      appearance?.params.destroy(); appearance?.receivers.destroy();
      entity.destroy();
      resource.destroy?.();
      placementsChanged = true;
    });
    this.resources = nextResources;
    this.gpuAppearanceActive = this.resources.length > 0 && this.resources.every(entry => entry.appearance);
    this.canvas.dataset.appearance = this.gpuAppearanceActive ? "gpu" : "cpu-compatibility";
    // The viewer cancels PlayCanvas' permanent RAF and renders on demand.
    // Reconcile newly added unified-GSplat placements once before the next
    // manual frame; app.render() alone does not run component systems.
    this.needsSystemUpdate ||= placementsChanged;
    this.hasSnapshot = true;
  }

  rebuildWebGpuSnapshot() {
    if (this.rebuilding) return;
    const lifecycle = this.lifecycle, stage = this.canvas.parentElement;
    // Keep the old canvas until an independent replacement is ready. A fresh
    // unified work buffer is required for topology edits in the host-driven loop.
    const replacement = new PlayCanvasBackend({ onFrameRequest: this.onFrameRequest, onError: this.onError });
    replacement.settings = this.settings;
    const pending = (async () => {
      try {
        await replacement.ensure(stage);
        if (this.lifecycle !== lifecycle) { replacement.dispose(); return; }
        replacement.syncSnapshot(this.settingsSnapshot);
        const active = this.canvas.classList.contains('is-active-backend');
        this.dispose();
        Object.assign(this, replacement);
        this.lifecycle = lifecycle + 1;
        this.canvas.classList.toggle('is-active-backend', active);
        this.onFrameRequest?.();
      } catch (error) {
        replacement.dispose();
        console.error('PlayCanvas topology rebuild:', error);
        this.onError?.(`PlayCanvas topology rebuild failed: ${error.message}`);
        if (this.canvas) this.canvas.dataset.backendError = error.message;
      } finally { if (this.rebuilding === pending) this.rebuilding = null; }
    })();
    this.rebuilding = pending;
  }

  makeAppearanceTexture(source, width) {
    const height = Math.max(1, Math.ceil(source.length / (width * 4)));
    if (height > this.app.graphicsDevice.maxTextureSize) throw new Error('GPU appearance texture exceeds device capacity');
    const texture = new PlayCanvas.Texture(this.app.graphicsDevice, {
      width, height, format: PlayCanvas.PIXELFORMAT_RGBA32F, mipmaps: false,
      minFilter: PlayCanvas.FILTER_NEAREST, magFilter: PlayCanvas.FILTER_NEAREST,
      addressU: PlayCanvas.ADDRESS_CLAMP_TO_EDGE, addressV: PlayCanvas.ADDRESS_CLAMP_TO_EDGE,
    });
    texture.lock().set(source); texture.unlock();
    return texture;
  }

  installAppearance(entry, item) {
    entry.appearance?.params.destroy(); entry.appearance?.receivers.destroy();
    entry.appearance = null;
    if (!item.appearance) { entry.entity.gsplat.setWorkBufferModifier(null); return; }
    const data = packAppearanceReceivers(item, item.appearance);
    const params = this.makeAppearanceTexture(packAppearance(item.appearance), APPEARANCE_WIDTH);
    const receivers = this.makeAppearanceTexture(data, Math.min(1024, this.app.graphicsDevice.maxTextureSize));
    entry.appearance = { params, receivers, data, state: appearanceIdentity(item.appearance), count: item.opacity.length };
    this.appearanceCameraKey = null;
    entry.entity.gsplat.setWorkBufferModifier(PC_APPEARANCE_MODIFIER);
    entry.entity.gsplat.setParameter('appearanceParams', params);
    entry.entity.gsplat.setParameter('appearanceReceivers', receivers);
    entry.entity.gsplat.setParameter('appearanceCamera', [0,0,0]);
  }

  setAppearance(states) {
    const byId = new Map(states.map(state => [state.id, state]));
    if (this.rebuilding || !this.gpuAppearanceActive || this.resources.length !== states.length
      || this.resources.some(entry => !appearanceSupported(byId.get(entry.id)))) return false;
    for (const entry of this.resources) {
      const state = byId.get(entry.id), a = entry.appearance;
      a.params.lock().set(packAppearance(state)); a.params.unlock();
      // Updating texture contents alone does not dirty unified-GSplat's cached
      // work buffer. The public parameter setter invalidates the placement.
      entry.entity.gsplat.setParameter('appearanceParams', a.params);
      if (a.state.visibility?.data !== state.visibility?.data
        || a.state.lights.map(l=>l.id).join() !== state.lights.map(l=>l.id).join()) {
        updateAppearanceVisibility(a.data, state, a.count);
        a.receivers.lock().set(a.data); a.receivers.unlock();
      }
      // Copy identity fields: the viewer's mutable cache handles may be cleared.
      a.state = { ...state, visibility: state.visibility ? { data: state.visibility.data, lightIds: [...state.visibility.lightIds] } : null };
      entry.entity.gsplat.workBufferUpdate = PlayCanvas.WORKBUFFER_UPDATE_ONCE;
    }
    this.onFrameRequest?.();
    return true;
  }

  syncItemTransforms(items) {
    const byId = new Map(items.map((item) => [item.id, item]));
    this.resources.forEach(({ entity, id }) => {
      const item = byId.get(id);
      if (item) setEntityTransform(entity, item.worldMatrix);
    });
  }

  syncFrame({ camera, background, helpers, width, height, pixelRatio }) {
    if (!this.app || !this.cameraEntity) {
      return;
    }
    camera.updateMatrixWorld?.(true);
    const renderWidth = Math.max(1, Math.round(width * pixelRatio));
    const renderHeight = Math.max(1, Math.round(height * pixelRatio));
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.app.graphicsDevice.resizeCanvas(renderWidth, renderHeight);
    this.cameraEntity.setLocalPosition(camera.position.x, camera.position.y, camera.position.z);
    const cameraKey = `${camera.position.x},${camera.position.y},${camera.position.z}`;
    if (cameraKey !== this.appearanceCameraKey) {
      this.appearanceCameraKey = cameraKey;
      for (const entry of this.resources) if (entry.appearance) {
        entry.entity.gsplat.setParameter('appearanceCamera', [camera.position.x,camera.position.y,camera.position.z]);
        entry.entity.gsplat.workBufferUpdate = PlayCanvas.WORKBUFFER_UPDATE_ONCE;
      }
    }
    this.cameraEntity.setLocalRotation(camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w);
    this.cameraEntity.camera.fov = camera.fov;
    this.cameraEntity.camera.aspectRatio = width / Math.max(height, 1);
    this.cameraEntity.camera.nearClip = camera.near;
    this.cameraEntity.camera.farClip = camera.far;
    this.cameraEntity.camera.clearColor = new PlayCanvas.Color(...colorFromHex(background), 1);
    if (this.needsSystemUpdate) {
      this.app.update(0);
      this.needsSystemUpdate = false;
    }
    // Application.tick() normally emits this before render(). Because this
    // backend is host-driven, emit it explicitly to advance unified-GSplat
    // streaming and consume completed worker sorts on every requested frame.
    this.app.fire("framerender");
    if (helpers?.showAxes) {
      const length = Math.max(Number(helpers.axesLength) || 0.5, 0.5);
      const origin = new PlayCanvas.Vec3(0, 0, 0);
      this.app.drawLine(origin, new PlayCanvas.Vec3(length, 0, 0), new PlayCanvas.Color(1, 0.24, 0.24), false);
      this.app.drawLine(origin, new PlayCanvas.Vec3(0, length, 0), new PlayCanvas.Color(0.2, 0.9, 0.38), false);
      this.app.drawLine(origin, new PlayCanvas.Vec3(0, 0, length), new PlayCanvas.Color(0.2, 0.5, 1), false);
    }
    if (helpers?.showGrid) {
      const gridSize = Math.max(Number(helpers.gridSize) || 1, 0.01);
      const gridStep = Math.max(Number(helpers.gridStep) || (gridSize / 10), 0.001);
      const half = gridSize * 0.5;
      const color = new PlayCanvas.Color(0.18, 0.3, 0.4);
      for (let offset = -half; offset <= half + (gridStep * 0.5); offset += gridStep) {
        this.app.drawLine(new PlayCanvas.Vec3(-half, 0, offset), new PlayCanvas.Vec3(half, 0, offset), color, false);
        this.app.drawLine(new PlayCanvas.Vec3(offset, 0, -half), new PlayCanvas.Vec3(offset, 0, half), color, false);
      }
    }
    if (helpers?.showBounds && helpers.bounds) {
      const { min, max } = helpers.bounds;
      const corners = [
        [min[0], min[1], min[2]], [max[0], min[1], min[2]], [min[0], max[1], min[2]], [max[0], max[1], min[2]],
        [min[0], min[1], max[2]], [max[0], min[1], max[2]], [min[0], max[1], max[2]], [max[0], max[1], max[2]],
      ].map((point) => new PlayCanvas.Vec3(...point));
      const edges = [[0, 1], [0, 2], [1, 3], [2, 3], [4, 5], [4, 6], [5, 7], [6, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
      const color = new PlayCanvas.Color(0.72, 0.91, 1);
      edges.forEach(([from, to]) => this.app.drawLine(corners[from], corners[to], color, false));
    }
    this.app.render();
  }

  get telemetry() {
    const device = this.app?.graphicsDevice;
    const renderer = device?.isWebGPU ? "WebGPU" : "WebGL";
    return `PlayCanvas ${PlayCanvas.version || "2.22.0"} · ${renderer} · GSplat`;
  }

  dispose() {
    this.lifecycle++;
    this.initializing = null;
    this.rebuilding = null;
    this.clear();
    this.frameRequestEvent?.off?.();
    this.frameRequestEvent = null;
    this.sortReadyEvent?.off?.();
    this.sortReadyEvent = null;
    this.app?.destroy();
    this.canvas?.remove();
    this.app = null;
    this.canvas = null;
    this.cameraEntity = null;
    this.root = null;
    this.needsSystemUpdate = false;
    this.hasSnapshot = false;
  }
}

class ThreeR186Backend {
  get supportsGpuAppearance() { return Boolean(this.renderer?.backend?.isWebGPUBackend); }
  constructor() {
    this.settings = createRendererSettings("three-r186");
    this.canvas = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.geometry = null;
    this.material = null;
    this.mesh = null;
    this.snapshot = null;
    this.flat = null;
    this.lifecycle = 0;
    this.initializing = null;
    this.appearancePass = null;
    this.appearanceDirty = true;
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.lastPixelRatio = 0;
    this.axesHelper = null;
    this.gridHelper = null;
    this.gridDivisions = 0;
    this.boundsBox = null;
    this.boundsHelper = null;
  }

  async ensure(stage) {
    if (ThreeR186.REVISION !== EXPECTED_THREE_REVISION) {
      throw new Error(`ThreeR186Backend requires ${EXPECTED_THREE_REVISION}; received ${ThreeR186.REVISION}`);
    }
    if (this.initializing) return this.initializing;
    if (this.renderer) return true;
    const lifecycle = ++this.lifecycle;
    const canvas = document.createElement("canvas");
    canvas.className = "lookdev-backend-canvas";
    canvas.dataset.backendCanvas = "three-r186";
    const renderer = new ThreeR186.WebGPURenderer({ canvas, alpha: false, antialias: false });
    const pending = (async () => {
      try { await renderer.init(); }
      catch(error) { await renderer.dispose(); throw error; }
      if (lifecycle !== this.lifecycle) { await renderer.dispose(); return false; }
      this.renderer = renderer;
      this.canvas = canvas;
      canvas.dataset.graphicsApi = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
      stage.append(canvas);
      renderer.outputColorSpace = ThreeR186.SRGBColorSpace;
      renderer.toneMapping = ThreeR186.NoToneMapping;
      renderer.setPixelRatio(1);
      this.scene = new ThreeR186.Scene();
      this.camera = new ThreeR186.PerspectiveCamera(60, 1, 0.0005, 5000);
      this.createHelpers();
      return true;
    })();
    this.initializing = pending;
    try { return await pending; }
    finally { if(this.initializing === pending) this.initializing = null; }
  }

  createHelpers() {
    this.axesHelper = new ThreeR186.AxesHelper(1);
    this.axesHelper.visible = false;
    this.scene.add(this.axesHelper);
    this.gridHelper = new ThreeR186.GridHelper(1, 10, 0x5ce2c3, 0x20384d);
    this.gridDivisions = 10;
    this.gridHelper.visible = false;
    this.scene.add(this.gridHelper);
    this.boundsBox = new ThreeR186.Box3();
    this.boundsHelper = new ThreeR186.Box3Helper(this.boundsBox, 0xb7e7ff);
    this.boundsHelper.visible = false;
    this.scene.add(this.boundsHelper);
    this.applySettings();
  }

  applySettings() {
    applyThreeRendererSettings(this, ThreeR186);
  }

  syncSnapshot(snapshot) {
    if (!this.renderer) return;
    this.releaseSplats();
    this.snapshot = snapshot;
    // One world-space mesh gives intersecting items a single official GPU sort.
    this.flat = flattenVisibleSnapshot(snapshot, { includeQuaternion: false, includeCovariance: true });
    if (!this.flat.count) {
      this.gpuAppearanceActive = false;
      this.canvas.dataset.appearance = 'cpu-compatibility';
      return;
    }
    const covariance = new Float32Array(this.flat.count * 6);
    const color = new Uint8Array(this.flat.count * 4);
    for(let i=0;i<this.flat.count;i++) {
      const j=i*3,d=this.flat.covarianceDiagonal,o=this.flat.covarianceOffDiagonal;
      covariance.set([d[j],o[j],o[j+1],d[j+1],o[j+2],d[j+2]],i*6);
      for(let c=0;c<3;c++) color[i*4+c]=Math.round(Math.min(1,Math.max(0,linearToSrgbChannel(this.flat.linearRgb[j+c])))*255);
      color[i*4+3]=Math.round(Math.min(1,Math.max(0,this.flat.opacity[i]))*255);
    }
    const geometry = new ThreeR186.BufferGeometry();
    geometry.setAttribute('position',new ThreeR186.BufferAttribute(this.flat.center.slice(),3));
    geometry.setAttribute('covariance',new ThreeR186.BufferAttribute(covariance,6));
    geometry.setAttribute('color',new ThreeR186.BufferAttribute(color,4,true));
    this.mesh = new ThreeR186.GaussianSplat(geometry, { autoSort: false });
    this.mesh.frustumCulled = false;
    this.material = this.mesh.material;
    this.scene.add(this.mesh);
    this.installAppearance(snapshot);
    this.applySettings();
  }

  releaseSplats() {
    this.appearancePass?.compute.dispose();
    this.appearancePass = null;
    if(this.mesh) {
      this.scene?.remove(this.mesh);
      ThreeR186.disposeNativeSplat(this.mesh);
    }
    this.appearanceParams?.dispose(); this.appearanceReceivers?.dispose();
    this.appearanceParams = this.appearanceReceivers = null;
    this.appearanceSlots = null;
    this.appearanceEntries = [];
    this.gpuAppearanceActive = false;
    this.appearanceDirty = true;
    this.mesh = this.material = null;
  }

  makeAppearanceTexture(source, width) {
    const height = Math.max(1, Math.ceil(source.length / (width * 4)));
    const maxSize = this.renderer.backend.device?.limits.maxTextureDimension2D ?? 8192;
    if (width > maxSize || height > maxSize) throw new Error('GPU appearance texture exceeds device capacity');
    const data = new Float32Array(width * height * 4); data.set(source);
    const texture = new ThreeR186.DataTexture(data, width, height, ThreeR186.RGBAFormat, ThreeR186.FloatType);
    texture.colorSpace = ThreeR186.NoColorSpace; texture.needsUpdate = true;
    return texture;
  }

  installAppearance(snapshot) {
    this.appearanceParams?.dispose(); this.appearanceReceivers?.dispose();
    const items = snapshot.items.filter(item => item.visible && item.opacity.length);
    this.gpuAppearanceActive = this.supportsGpuAppearance && items.length > 0 && items.every(item => item.appearance);
    this.canvas.dataset.appearance = this.gpuAppearanceActive ? 'gpu' : 'cpu-compatibility';
    this.appearanceSlots = new Float32Array(this.flat.count * 2);
    if (!this.gpuAppearanceActive) return;
    const params = new Float32Array(Math.max(1, items.length) * APPEARANCE_WIDTH * 4);
    const data = new Float32Array(Math.max(1, this.flat.count) * 16);
    let offset = 0;
    this.appearanceEntries = items.map((item, row) => {
      params.set(packAppearance(item.appearance), row * APPEARANCE_WIDTH * 4);
      data.set(packAppearanceReceivers(item, item.appearance), offset * 16);
      const entry = { id: item.id, row, offset, count: item.opacity.length, state: appearanceIdentity(item.appearance) };
      offset += item.opacity.length;
      return entry;
    });
    const byId = new Map(this.appearanceEntries.map(entry => [entry.id, entry]));
    for (let i = 0; i < this.flat.count; i++) {
      const entry = byId.get(this.flat.itemIds[this.flat.itemIndex[i]]);
      this.appearanceSlots.set([entry.offset + this.flat.sourceIndex[i], entry.row], i * 2);
    }
    this.appearanceParams = this.makeAppearanceTexture(params, APPEARANCE_WIDTH);
    this.appearanceReceivers = this.makeAppearanceTexture(data, 1024);
    this.appearancePass = ThreeR186.createNativeAppearance(this.mesh, this.flat, this.appearanceSlots, this.appearanceParams, this.appearanceReceivers);
    this.appearanceDirty = true;
  }

  setAppearance(states) {
    const byId = new Map(states.map(state => [state.id, state]));
    if (!this.gpuAppearanceActive || this.appearanceEntries.length !== states.length
      || this.appearanceEntries.some(entry => !appearanceSupported(byId.get(entry.id)))) return false;
    for (const entry of this.appearanceEntries) {
      const state = byId.get(entry.id);
      this.appearanceParams.image.data.set(packAppearance(state), entry.row * APPEARANCE_WIDTH * 4);
      if (entry.state.visibility?.data !== state.visibility?.data
        || entry.state.lights.map(l=>l.id).join() !== state.lights.map(l=>l.id).join()) {
        updateAppearanceVisibility(this.appearanceReceivers.image.data, state, entry.count, entry.offset);
        this.appearanceReceivers.needsUpdate = true;
      }
      entry.state = { ...state, visibility: state.visibility ? { data: state.visibility.data, lightIds: [...state.visibility.lightIds] } : null };
    }
    this.appearanceParams.needsUpdate = true;
    this.appearanceDirty = true;
    return true;
  }

  syncItemTransforms(items) {
    const nextFlat = updateFlattenedSnapshotItemTransforms(this.snapshot, this.flat, items);
    if (nextFlat !== this.flat && this.mesh) {
      this.flat = nextFlat;
      ThreeR186.updateNativeGeometry(this.mesh, this.flat);
      this.appearancePass?.updatePositions(this.flat);
      this.appearanceDirty = true;
    }
  }

  syncFrame({ camera, background, helpers, width, height, pixelRatio }) {
    if (!this.renderer || !this.camera) {
      return;
    }
    if (pixelRatio !== this.lastPixelRatio) {
      this.renderer.setPixelRatio(pixelRatio);
      this.lastPixelRatio = pixelRatio;
      this.lastWidth = 0;
      this.lastHeight = 0;
    }
    if (width !== this.lastWidth || height !== this.lastHeight) {
      this.renderer.setSize(width, height, false);
      this.lastWidth = width;
      this.lastHeight = height;
    }
    this.renderer.setClearColor(background);
    this.camera.fov = camera.fov;
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.near = camera.near;
    this.camera.far = camera.far;
    this.camera.position.copy(camera.position);
    this.camera.quaternion.copy(camera.quaternion);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    const axesLength = Math.max(Number(helpers?.axesLength) || 0.5, 0.5);
    this.axesHelper.visible = Boolean(helpers?.showAxes);
    this.axesHelper.scale.setScalar(axesLength);
    const gridSize = Math.max(Number(helpers?.gridSize) || 1, 0.01);
    const gridStep = Math.max(Number(helpers?.gridStep) || (gridSize / 10), 0.001);
    const gridDivisions = Math.max(1, Math.round(gridSize / gridStep));
    if (gridDivisions !== this.gridDivisions) {
      this.scene.remove(this.gridHelper);
      this.gridHelper.geometry.dispose();
      this.gridHelper.material.dispose();
      this.gridHelper = new ThreeR186.GridHelper(1, gridDivisions, 0x5ce2c3, 0x20384d);
      this.scene.add(this.gridHelper);
      this.gridDivisions = gridDivisions;
    }
    this.gridHelper.visible = Boolean(helpers?.showGrid);
    this.gridHelper.scale.setScalar(gridSize);
    this.boundsHelper.visible = Boolean(helpers?.showBounds && helpers.bounds);
    if (helpers?.bounds) {
      this.boundsBox.min.set(...helpers.bounds.min);
      this.boundsBox.max.set(...helpers.bounds.max);
    }
    if(this.appearancePass && (this.appearanceDirty || !this.appearancePass.camera.value.equals(this.camera.position))) {
      this.appearancePass.camera.value.copy(this.camera.position);
      this.renderer.compute(this.appearancePass.compute);
      this.appearanceDirty = false;
    }
    this.mesh?.updateSort(this.renderer, this.camera);
    this.renderer.render(this.scene, this.camera);
  }

  get telemetry() {
    return `THREE.REVISION ${ThreeR186.REVISION} · GaussianSplat · ${this.canvas?.dataset.graphicsApi ?? 'initializing'}`;
  }

  dispose() {
    this.lifecycle += 1;
    this.releaseSplats();
    for(const helper of [this.axesHelper,this.gridHelper,this.boundsHelper]) {
      helper?.geometry.dispose();
      if(Array.isArray(helper?.material)) helper.material.forEach(m=>m.dispose());
      else helper?.material.dispose();
    }
    this.renderer?.dispose().catch(error => console.warn('Three.js disposal:', error));
    this.canvas?.remove();
    this.renderer = this.canvas = this.scene = this.camera = null;
    this.axesHelper = this.gridHelper = this.boundsHelper = null;
    this.snapshot = this.flat = null;
    this.lastWidth = this.lastHeight = this.lastPixelRatio = 0;
  }
}

export class LookDevBackendManager {
  constructor({ stage, inputCanvas, onFrameRequest, onTelemetry, onStatus, loadVendor = loadBackendVendor }) {
    this.stage = stage;
    this.inputCanvas = inputCanvas;
    this.onTelemetry = onTelemetry;
    this.onStatus = onStatus;
    this.loadVendor = loadVendor;
    this.activeId = "spark";
    this.activationToken = 0;
    this.snapshot = Object.freeze({ version: 1, items: Object.freeze([]), splatCount: 0 });
    this.backends = new Map([
      ["playcanvas", new PlayCanvasBackend({ onFrameRequest, onError: onStatus })],
      ["three-r186", new ThreeR186Backend()],
    ]);
    this.updateCanvasVisibility();
    this.emitTelemetry();
  }

  isSparkActive() {
    return this.activeId === "spark";
  }

  get activeBackend() {
    return this.backends.get(this.activeId) ?? null;
  }

  emitTelemetry() {
    const backend = RENDERER_MANIFEST[this.activeId];
    const rendererTelemetry = this.activeBackend?.telemetry ?? "Spark 2.1 · native canvas";
    this.onTelemetry?.({
      id: this.activeId,
      label: backend.label,
      splatCount: this.snapshot.splatCount,
      text: `${rendererTelemetry} · ${backend.capabilities.sh}`,
    });
  }

  updateCanvasVisibility() {
    this.inputCanvas.classList.toggle("is-overlay-input", !this.isSparkActive());
    this.inputCanvas.classList.toggle("is-active-backend", this.isSparkActive());
    this.backends.forEach((backend, id) => {
      backend.canvas?.classList.toggle("is-active-backend", id === this.activeId);
    });
  }

  async setActive(id, { getSnapshot } = {}) {
    if (!RENDERER_MANIFEST[id]) {
      throw new Error(`Unsupported renderer backend: ${id}`);
    }
    const activationToken = ++this.activationToken;
    this.pendingActivationId = id;
    if (id !== "spark") {
      await this.loadVendor(id);
    }
    if (activationToken !== this.activationToken) return false;
    const previousId = this.activeId;
    if (previousId === id) return true;
    let nextSnapshot = this.snapshot;
    if (id !== "spark") {
      const backend = this.backends.get(id);
      try {
        await backend.ensure(this.stage);
        if (activationToken !== this.activationToken) {
          if (this.pendingActivationId !== id && this.activeId !== id) backend.dispose();
          return false;
        }
        // Capture after vendor and GPU-device initialization so edits during
        // either async wait are included in the replacement's first frame.
        nextSnapshot = getSnapshot ? getSnapshot({ gpuAppearance: backend.supportsGpuAppearance }) : this.snapshot;
        backend.syncSnapshot(nextSnapshot);
      } catch (error) {
        backend.dispose();
        this.updateCanvasVisibility();
        throw error;
      }
    }
    // Keep the prior canvas alive until the replacement is fully prepared.
    this.snapshot = nextSnapshot;
    this.activeId = id;
    this.updateCanvasVisibility();
    if (previousId !== "spark") {
      this.backends.get(previousId)?.dispose();
    }
    this.emitTelemetry();
    this.onStatus?.(`${RENDERER_MANIFEST[id].label} active`);
    return true;
  }

  setSnapshot(snapshot, { syncActive = true } = {}) {
    this.snapshot = snapshot;
    if (syncActive) this.activeBackend?.syncSnapshot(snapshot);
    this.emitTelemetry();
  }

  syncItemTransforms(items) {
    this.activeBackend?.syncItemTransforms?.(items);
  }

  renderFrame({ camera, background, helpers, width, height, pixelRatio }) {
    this.activeBackend?.syncFrame({ camera, background, helpers, width, height, pixelRatio });
  }

  dispose() {
    this.activationToken += 1;
    this.backends.forEach((backend) => backend.dispose());
  }
}

export {
  BACKEND_VENDOR_DEFINITIONS,
  EXPECTED_THREE_REVISION,
  loadBackendVendor,
};
