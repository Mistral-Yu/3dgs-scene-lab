// Defaults verified against Spark 2.1.0, PlayCanvas 2.22.0 and the pinned
// Three.js r186 source. Limits are UI guardrails, not upstream API limits.
const number = (key, value, min, max, step, note) => ({ key, value, min, max, step, note, type: "number" });
const checkbox = (key, value, note) => ({ key, value, note, type: "checkbox" });

export const RENDERER_SETTINGS = {
  spark: {
    source: "https://sparkjs.dev/docs/spark-renderer/",
    note: "Spark 2.1.0 defaults. Changes apply to all splats. LoD controls require a loaded LoD tree. Quality presets also change maxStdDev; Falloff is shared with the Splats tab.",
    fields: [
      { ...number("lodSplatCount", undefined, 1, 10000000, 1, "Target LoD splat count. Leave blank for the engine's platform-dependent automatic budget."), nullable: true, integer: true },
      number("maxStdDev", Math.sqrt(8), 0.1, 6, 0.01, "Gaussian support radius in standard deviations. Smaller values trade edge quality for speed."),
      number("minPixelRadius", 0, 0, 512, 0.1, "Discard splats smaller than this screen radius, in pixels."),
      number("maxPixelRadius", 512, 1, 4096, 1, "Cap the projected splat radius, in pixels."),
      number("minAlpha", 0.5 / 255, 0, 1, 0.0001, "Discard contributions below this opacity threshold."),
      number("preBlurAmount", 0, 0, 10, 0.01, "Enlarge projected covariance without opacity compensation."),
      number("blurAmount", 0.3, 0, 10, 0.01, "Antialiasing blur with opacity compensation."),
      number("falloff", 1, 0, 8, 0.01, "Gaussian falloff: 1 is normal; 0 gives flat splats. Shared with Splats / Falloff."),
      number("focalAdjustment", 1, 0.1, 4, 0.01, "Adjust projected splat scale; larger values tend to sharpen splats."),
      number("clipXY", 1.4, 1, 4, 0.1, "Frustum margin for splat centers; 1.4 allows a 40% margin."),
      checkbox("sortRadial", true, "Sort by distance to the camera. Off uses view-space depth."),
      number("minSortIntervalMs", 0, 0, 1000, 1, "Minimum interval between sorting jobs in milliseconds."),
      checkbox("enable2DGS", false, "Interpret splats with an exactly zero scale axis as oriented 2D Gaussians."),
      number("focalDistance", 0, 0, 10000, 0.1, "Depth-of-field focus distance in scene units; requires a nonzero aperture."),
      number("apertureAngle", 0, 0, 1, 0.001, "Full aperture angle in radians. Zero disables depth of field."),
      checkbox("enableLod", true, "Enable LoD for splats that have a LoD tree; does not generate a tree."),
      number("lodSplatScale", 1, 0.1, 5, 0.1, "Multiply the platform's automatic LoD splat budget."),
      number("lodRenderScale", 1, 0.1, 5, 0.1, "Minimum LoD screen size; larger values favor coarser detail."),
      checkbox("lodInflate", false, "Inflate LoD splats to reduce gaps between coarser splats."),
      number("coneFov0", 90, 1, 179, 1, "Full angle in degrees of the central LoD cone at full detail."),
      number("coneFov", 120, 1, 180, 1, "Full angle of the outer LoD cone; must be greater than coneFov0."),
      number("coneFoveate", 0.4, 0.01, 1, 0.01, "LoD detail scale at the outer cone. Smaller values use fewer, larger splats."),
      number("behindFoveate", 0.2, 0.01, 1, 0.01, "LoD detail scale behind the camera."),
    ],
    unavailable: "Allocation-time options accumExtSplats, covSplats, pagedExtSplats, maxPagedSplats and numLodFetchers require renderer/pager reconstruction and are not editable here. autoUpdate, preUpdate and enableDriveLod are managed by the viewer update loop. Offscreen target.superXY does not control viewport resolution. Use Pixel ratio below for viewport sampling.",
  },
  playcanvas: {
    source: "https://api.playcanvas.com/engine/classes/GSplatParams.html",
    note: "PlayCanvas 2.22.0 GSplatParams defaults. WebGPU is preferred, with WebGL2 compatibility. Scene snapshots remain flat; streamed-LoD controls are omitted.",
    fields: [
      { key: "dataFormat", value: "compact", type: "select", options: ["compact", "large"], note: "Work-buffer precision: compact uses 20 bytes/splat; large uses 32 bytes/splat and higher precision. Increasing precision costs GPU memory." },
      checkbox("antiAlias", false, "Enable Gaussian antialiasing with opacity compensation."),
      checkbox("radialSorting", false, "Sort by camera distance instead of view-space depth."),
      number("minPixelSize", 2, 0, 64, 0.1, "Discard splats below this projected size in pixels."),
      number("alphaClipForward", 1 / 255, 0, 1, 0.0001, "Discard forward-rendered fragments below this alpha value."),
      checkbox("twoDimensional", false, "Enable the 2D Gaussian rendering path; intended for 2DGS data."),
    ],
    unavailable: "WebGPU minContribution, foveationStrength and foveationCenter are not exposed in this panel. Streamed-LoD splatBudget, lodMode, lodBehindPenalty, lodUnderfillLimit and cooldownTicks do not apply to flat snapshots. Source SH is reduced to SH0, so colorUpdateAngle does not improve it. alphaClip affects shadow/pick/prepasses, which this backend does not provide. WebGL2 is the compatibility path when WebGPU is unavailable.",
  },
  "three-r186": {
    source: "https://threejs.org/docs/pages/GaussianSplat.html",
    note: "Official Three.js r186 GaussianSplat. WebGPU counting sort; WebGL2 uses the official CPU sort fallback. Shared appearance is controlled in Splats and Light.",
    fields: [
      checkbox("sortObjects", true, "Sort scene objects; all splats share one global GaussianSplat sort."),
      checkbox("depthTest", true, "Depth testing against opaque helpers and geometry."),
      checkbox("wireframe", false, "Show the edges of the official Gaussian quads."),
    ],
    unavailable: "The official addon fixes Gaussian support at 2 standard deviations and antialiasing kernel variance at 0.3; it exposes no cutoff, alpha threshold or blur controls. Shared snapshots currently carry SH0, not source SH1–SH3. No LoD or native shadow maps. WebGL2 uses CPU appearance compatibility. Extra output tone mapping is omitted to preserve display-encoded splat compositing.",
  },
};

export const RENDERER_SETTING_GROUPS = [
  { id: "quality", label: "Quality / Performance" },
  { id: "effects", label: "Effects" },
  { id: "other", label: "Other" },
];
const effectKeys = new Set(["falloff", "focalDistance", "apertureAngle", "toneMapping", "toneMappingExposure", "preBlurVariance"]);
const otherKeys = new Set(["enable2DGS", "twoDimensional", "depthTest", "wireframe"]);
export const rendererSettingGroup = ({ key }) => effectKeys.has(key) ? "effects" : otherKeys.has(key) ? "other" : "quality";

export const createRendererSettings = (id) => Object.fromEntries(RENDERER_SETTINGS[id].fields.map(({ key, value }) => [key, value]));

export function parseRendererSetting(field, raw) {
  if (field.type === "checkbox") return typeof raw === "boolean" ? raw : null;
  if (field.type === "select") return field.options.includes(raw) ? raw : null;
  if (String(raw).trim() === "") return field.nullable ? undefined : null;
  const value = Number(raw);
  return Number.isFinite(value) && (!field.integer || Number.isInteger(value)) && value >= field.min && value <= field.max ? value : null;
}

export function applyThreeRendererSettings(backend, namespace) {
  const { renderer, material, settings } = backend;
  if (!renderer || !material) return;
  renderer.toneMapping = namespace.NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.sortObjects = settings.sortObjects;
  material.depthTest = settings.depthTest;
  material.wireframe = settings.wireframe;
}

// Keep the native details element (and its open state) while switching engines.
export function renderRendererSettings(container, id, values, onChange, onReset) {
  const config = RENDERER_SETTINGS[id];
  container.replaceChildren();
  const note = document.createElement("p");
  note.className = "renderer-settings-note";
  note.textContent = config.note;
  container.append(note);
  const sections = {};
  for (const group of RENDERER_SETTING_GROUPS) {
    const section = document.createElement("fieldset");
    section.className = "renderer-settings-group";
    section.dataset.settingsGroup = group.id;
    const legend = document.createElement("legend");
    legend.textContent = group.label;
    section.append(legend);
    if (group.id === "quality") {
      const shared = document.createElement("div");
      shared.id = "renderer-shared-quality";
      shared.className = "field-stack compact-fields";
      section.append(shared);
    }
    sections[group.id] = section;
    container.append(section);
  }
  for (const field of config.fields) {
    const label = document.createElement("label");
    label.className = "renderer-setting";
    const row = document.createElement("span");
    row.className = "renderer-setting-row";
    const name = document.createElement("span");
    name.textContent = field.key;
    const control = document.createElement(field.type === "select" ? "select" : "input");
    control.id = `renderer-${id}-${field.key}`;
    control.dataset.rendererSetting = field.key;
    if (field.type === "select") {
      for (const option of field.options) control.add(new Option(option, option));
    } else {
      control.type = field.type;
      if (field.type === "number") {
        control.min = field.min;
        control.max = field.max;
        // Several upstream defaults are irrational or recurring fractions.
        control.step = "any";
        control.inputMode = "decimal";
        if (field.nullable) control.placeholder = "Automatic";
      }
    }
    const sync = () => {
      if (field.type === "checkbox") control.checked = values[field.key];
      else control.value = values[field.key] == null ? "" : String(values[field.key]);
    };
    sync();
    control.addEventListener("change", () => {
      const value = parseRendererSetting(field, field.type === "checkbox" ? control.checked : control.value);
      const coneInvalid = (field.key === "coneFov0" && value >= values.coneFov) || (field.key === "coneFov" && value <= values.coneFov0);
      if (value === null || coneInvalid) {
        control.setCustomValidity(coneInvalid ? "coneFov must be greater than coneFov0." : `Enter a value from ${field.min} to ${field.max}.`);
        control.reportValidity();
        sync();
        return;
      }
      control.setCustomValidity("");
      onChange(field.key, value);
      sync();
    });
    control.addEventListener("input", () => control.setCustomValidity(""));
    const help = document.createElement("small");
    help.id = `${control.id}-help`;
    help.textContent = `${field.note} Default: ${field.value ?? "Automatic"}.`;
    control.setAttribute("aria-describedby", help.id);
    row.append(name, control);
    label.append(row, help);
    sections[rendererSettingGroup(field)].append(label);
  }
  if (!config.fields.some((field) => rendererSettingGroup(field) === "effects")) {
    const none = document.createElement("p");
    none.className = "renderer-settings-note";
    none.textContent = "No additional effects in this backend. Shared appearance controls remain in Splats and Light.";
    sections.effects.append(none);
  }
  const unavailable = document.createElement("details");
  unavailable.className = "options-disclosure";
  const summary = document.createElement("summary");
  summary.textContent = "Quality options unavailable here";
  const reason = document.createElement("p");
  reason.className = "renderer-settings-note";
  reason.textContent = config.unavailable;
  unavailable.append(summary, reason);
  sections.quality.append(unavailable);
  const footer = document.createElement("div");
  footer.className = "renderer-settings-footer";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "toolbar-button";
  reset.textContent = "Reset defaults";
  reset.addEventListener("click", onReset);
  const link = document.createElement("a");
  link.href = config.source;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Official reference ↗";
  footer.append(reset, link);
  container.append(footer);
}
