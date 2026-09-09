import * as THREE from "./vendor/three/three.module.js";
import { appearanceSupported } from "./viewer-gpu-appearance.mjs";
import { expandLightSamples, lightTypeCode, lightVector } from './viewer-light-types.mjs';
import { createRendererSettings, renderRendererSettings } from "./viewer-renderer-settings.mjs";
import { OrbitControls } from "./vendor/three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "./vendor/three/examples/jsm/controls/TransformControls.js";
import * as Spark from "./vendor/spark/spark.module.js";
import { computeLayoutMode, computePanelWidths, computeShellSize, computeUiScale } from "./viewer-layout.mjs";
import { computeRigidAlignment, formatAlignPointLabel } from "./viewer-align.mjs";
import {
  applyToneCurveToLinearRgb,
  buildToneCurveSvgPathData,
  buildToneCurveState,
  findNearestRemovableToneCurvePointIndex,
  getSelectedToneCurvePoint,
  getToneCurveSpline,
  insertToneCurvePoint,
  isNeutralToneCurve,
  normalizeToneCurveState,
  removeToneCurvePoint,
  sampleToneCurveChannel,
  setToneCurveActiveChannel,
  setToneCurveSelectedPoint,
  summarizeToneCurve,
  updateToneCurvePoint,
} from "./viewer-tone-curve.mjs";
import {
  createAnimationModifierFromScript,
  DEFAULT_ANIMATION_SCRIPT_NAME,
  advanceAnimationPlayback,
  buildAnimationDownloadName,
  canPlayAnimation,
  createDefaultAnimationPlaybackState,
  getAnimationPresetScriptText,
  parseAnimationScript,
  serializeAnimationScript,
  shouldRenderAnimationFrame,
} from "./viewer-animation.mjs";
import {
  applyDirectLighting,
  applyOneBouncePreview,
  computeSampledGaussianProxyRadius,
  DEFAULT_LIGHT_COLOR,
  DEFAULT_LIGHT_HELPER_SCALE,
  DIRECT_LIGHT_NORMAL_POLICY,
  clampLightColor,
  createDefaultLightState,
  evaluateSampledLightTransmission,
  ONE_BOUNCE_VPL_LIMIT,
  orientDirectLightNormal,
  selectOneBounceVpls,
} from "./viewer-lighting.mjs";
import { applyCubeLutToLinearRgb, parseCubeLut, summarizeCubeLut } from "./viewer-lut.mjs";
import {
  SPLAT_COLOR_SPACE, detectSplatColorSpace, sourceColorToLinear,
  linearColorToSource, linearColorToSrgb,
} from "./viewer-color.mjs";
import { createSceneSnapshot, flattenVisibleSnapshot } from "./renderer-contract.mjs";
import { LookDevBackendManager } from "./viewer-backends.mjs";
import { WebGpuLightOcclusionController } from "./viewer-webgpu-occlusion.mjs";
import { WebGpuStaticLightingBakeController } from "./viewer-webgpu-static-lighting.mjs";
import {
  getLightOcclusionTextureLayout,
  LIGHT_OCCLUSION_MAX_LIGHTS,
  LIGHT_OCCLUSION_MAX_SCALAR_SLOTS,
} from "./viewer-light-occlusion.mjs";
import {
  createLightOcclusionWorkerSnapshot,
  createStaticBakeRestoreHandle,
} from "./viewer-static-lighting-client.mjs";
import {
getStaticBakeActiveShDegree,
runStaticBakeColorTransaction,
STATIC_BAKE_MODE,
STATIC_BAKE_GENERIC_POLICY,
} from "./viewer-static-lighting.mjs";

function startSparkViewer() {
    const {
      SparkRenderer,
      SplatMesh,
      SplatFileType,
      dyno,
      setPackedSplatCenter,
      setPackedSplatScales,
      unpackSplat,
    } = Spark;
    const DEFAULT_LOOK = new THREE.Vector3(0, 0, -1);
    const DEFAULT_FIT = new THREE.Vector3(1.05, 0.68, 1.2).normalize();
    const DEFAULT_FOCAL_LENGTH = 28;
    const DEPTH_RANGE_DEFAULT = 10;
    const FOCAL_LENGTH_LIMITS = { min: 5, max: 400 };
    const FOCAL_LENGTH_COMMON_LIMIT = 135;
    const FOCAL_LENGTH_SLIDER_LIMITS = { min: 0, max: 1000 };
    const FOCAL_LENGTH_COMMON_WEIGHT = 0.8;
    const MOVE_SPEED_LIMITS = { min: 0.01, max: 100 };
    const OPACITY_LIMITS = { min: 0, max: 8 };
    const TONE_CURVE_POINT_LIMITS = { min: 0, max: 1 };
    const FALLOFF_LIMITS = { min: 0, max: 8 };
    const EXPOSURE_LIMITS = { min: -6, max: 6 };
    const POSITION_RANGE_LIMITS = { min: 0.05, max: 8 };
    const RENDER_FPS_LIMITS = { min: 1, max: 240 };
    const INTERACTION_PREVIEW_FPS = 12;
    const INTERACTION_PREVIEW_MS = 180;
    const INTERACTION_SETTLE_MS = 140;
    const SCALE_LIMITS = { min: 0.001, max: 1000 };
    const LIGHT_INTENSITY_LIMITS = { min: 0, max: 100000 };
    const LIGHT_HELPER_SCALE_LIMITS = { min: 0.1, max: 8 };
    const LIGHT_POSITION_LIMITS = { min: -100000, max: 100000 };
    const LIGHT_HELPER_COLOR = "#fff1b5";
    const LIGHT_COLOR_COMPONENT_LIMITS = { min: 0, max: 1 };
    const BRUSH_RADIUS_LIMITS = { min: 0.01, max: 1000 };
    const BRUSH_STRENGTH_LIMITS = { min: -8, max: 8 };
    const BRUSH_SCALE_LIMITS = { min: 0.05, max: 8 };
    const BRUSH_DEPTH_LIMITS = { min: 0, max: 1000 };
    const BRUSH_OVERLAY_SEGMENTS = 96;
    const BRUSH_OVERLAY_POINT_LIMIT = 900;
    const BRUSH_UNDO_LIMITS = { min: 1, max: 30 };
    const DEFAULT_BRUSH_SETTINGS = {
      brushDepthLimit: 0.35,
      brushMode: "move",
      brushRadius: 0.25,
      brushRelativeToSplatSize: false,
      brushScale: 1,
      brushStrength: 0.35,
      brushUndoLimit: 8,
    };
const LIGHT_OCCLUDER_LIMIT = 96;
const LIGHT_SHADOW_GPU_SLOT_LIMIT = 32;
    const TRANSLATE_LIMITS = { min: -100000, max: 100000 };
    const FPS_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight"]);
    const isEditableKeyboardTarget = (target) => {
      if (!(target instanceof Element)) {
        return false;
      }
      return Boolean(target.closest("input, select, textarea, [contenteditable]:not([contenteditable=\"false\"])"));
    };
    const BACKGROUNDS = {
      dawn: "#efe6d7",
      graphite: "#061019",
      museum: "#17110f",
      studio: "#d7dde8",
    };
    const QUALITY = {
      balanced: { label: "Balanced", maxPixelRatio: 1.4, maxStdDev: Math.sqrt(8) },
      fast: { label: "Fast", maxPixelRatio: 1.0, maxStdDev: Math.sqrt(6) },
      sharp: { label: "Sharp", maxPixelRatio: 1.85, maxStdDev: Math.sqrt(9) },
    };
    const RENDER_MODE_LABELS = {
      beauty: "Beauty",
      depth: "Depth",
      position: "Position",
      worldNormal: "World Normal",
    };
    const COMPRESSION_LABELS = {
      ksplat: "K-SPLAT compressed",
      ply: "Uncompressed PLY",
      splat: "Packed SPLAT",
      spz: "SPZ compressed",
    };
    const ANIMATION_PRESET_LABELS = {
      explosion: "Splat Explosion",
    };
    const ANIMATION_PARAM_LIMITS = {
      distanceScale: { min: 0, max: 6 },
      opacityPower: { min: 0.1, max: 4 },
      scaleInfluence: { min: 0, max: 4 },
      speed: { min: 0.05, max: 8 },
      strength: { min: 0, max: 12 },
      swirl: { min: 0, max: 6 },
    };
    const dom = {
      appShell: document.querySelector(".app-shell"),
      backgroundSelect: document.getElementById("background-select"),
      backendSelect: document.getElementById("backend-select"),
      cameraChip: document.getElementById("camera-chip"),
      clearPickedColorsButton: document.getElementById("clear-picked-colors-button"),
      clearSceneButton: document.getElementById("clear-scene-button"),
      colorspaceChip: document.getElementById("colorspace-chip"),
      lutApplySelectedButton: document.getElementById("lut-apply-selected-button"),
      lutFileInput: document.getElementById("lut-file-input"),
      lutInputColorSpaceSelect: document.getElementById("lut-input-color-space-select"),
      lutOpenButton: document.getElementById("lut-open-button"),
      lutOutputColorSpaceSelect: document.getElementById("lut-output-color-space-select"),
      lutStatus: document.getElementById("lut-status"),
      depthRangeField: document.getElementById("depth-range-field"),
      depthRangeInput: document.getElementById("depth-range-input"),
      depthRangeLabel: document.getElementById("normalize-range-label"),
      depthRangeRange: document.getElementById("depth-range-range"),
      dropOverlay: document.getElementById("drop-overlay"),
      dropOverlayMessage: document.getElementById("drop-overlay-message"),
      emptyState: document.getElementById("empty-state"),
      exposureInput: document.getElementById("exposure-input"),
      exposureRange: document.getElementById("exposure-range"),
      toneCurveAddPointButton: document.getElementById("tone-curve-add-point-button"),
      toneCurveChannelSelect: document.getElementById("tone-curve-channel-select"),
      toneCurveGraph: document.getElementById("tone-curve-graph"),
      toneCurvePointList: document.getElementById("tone-curve-point-list"),
      toneCurvePointXInput: document.getElementById("tone-curve-point-x-input"),
      toneCurvePointYInput: document.getElementById("tone-curve-point-y-input"),
      toneCurveRemovePointButton: document.getElementById("tone-curve-remove-point-button"),
      exportDisableAllButton: document.getElementById("export-disable-all-button"),
      exportEmpty: document.getElementById("export-empty"),
      exportEnableAllButton: document.getElementById("export-enable-all-button"),
      exportFalloffCheckbox: document.getElementById("export-falloff-checkbox"),
      exportList: document.getElementById("export-list"),
      exportOpacityCheckbox: document.getElementById("export-opacity-checkbox"),
      exportShCheckbox: document.getElementById("export-sh-checkbox"),
      falloffInput: document.getElementById("falloff-input"),
      falloffRange: document.getElementById("falloff-range"),
      fileInput: document.getElementById("file-input"),
      fitViewButton: document.getElementById("fit-view-button"),
      fpsChip: document.getElementById("fps-chip"),
      focalLengthInput: document.getElementById("focal-length-input"),
      focalLengthRange: document.getElementById("focal-length-range"),
      gridChip: document.getElementById("grid-chip"),
      gridScaleInput: document.getElementById("grid-scale-input"),
      gridScaleSelect: document.getElementById("grid-scale-select"),
      headerOpenFileButton: document.getElementById("header-open-file-button"),
      hoverChip: document.getElementById("hover-chip"),
      hoverChipColor: document.getElementById("hover-chip-color"),
      hoverChipItem: document.getElementById("hover-chip-item"),
      gizmoRotateButton: document.getElementById("gizmo-rotate-button"),
      gizmoScaleButton: document.getElementById("gizmo-scale-button"),
      gizmoTranslateButton: document.getElementById("gizmo-translate-button"),
      infoBounds: document.getElementById("info-bounds"),
      infoCenter: document.getElementById("info-center"),
      infoCompression: document.getElementById("info-compression"),
      infoCompressionRatio: document.getElementById("info-compression-ratio"),
      infoEncoding: document.getElementById("info-encoding"),
      infoFormat: document.getElementById("info-format"),
      infoLoadTime: document.getElementById("info-load-time"),
      infoName: document.getElementById("info-name"),
      infoPackedCapacity: document.getElementById("info-packed-capacity"),
      infoScaleRange: document.getElementById("info-scale-range"),
      infoShActive: document.getElementById("info-sh-active"),
      infoShDegree: document.getElementById("info-sh-degree"),
      infoSize: document.getElementById("info-size"),
      infoSource: document.getElementById("info-source"),
      infoSplats: document.getElementById("info-splats"),
      lightControlsSection: document.getElementById("light-controls-section"),
      lightEmpty: document.getElementById("light-empty"),
      lightGizmoButton: document.getElementById("light-gizmo-button"),
      lightHelperScaleInput: document.getElementById("light-helper-scale-input"),
      lightHelperScaleRange: document.getElementById("light-helper-scale-range"),
      lightIntensityInput: document.getElementById("light-intensity-input"),
      lightIntensityRange: document.getElementById("light-intensity-range"),
      lightList: document.getElementById("light-list"),
      lightName: document.getElementById("light-name"),
      lightOcclusionCheckbox: document.getElementById("light-occlusion-checkbox"),
      lightOcclusionUpdateButton: document.getElementById("light-occlusion-update-button"),
      lightOcclusionCancelButton: document.getElementById("light-occlusion-cancel-button"),
      lightOcclusionStatus: document.getElementById("light-occlusion-status"),
      legacySampledShadowCheckbox: document.getElementById("legacy-sampled-shadow-checkbox"),
      oneBouncePreviewCheckbox: document.getElementById("one-bounce-preview-checkbox"),
      staticBakeButton: document.getElementById("static-bake-button"),
      staticBakeCancelButton: document.getElementById("static-bake-cancel-button"),
      staticBakeClearButton: document.getElementById("static-bake-clear-button"),
      staticBakeGenericPolicy: document.getElementById("static-bake-generic-policy"),
      staticBakeMode: document.getElementById("static-bake-mode"),
      staticBakeStatus: document.getElementById("static-bake-status"),
      lightRInput: document.getElementById("light-r-input"),
      lightGInput: document.getElementById("light-g-input"),
      lightBInput: document.getElementById("light-b-input"),
      lightXInput: document.getElementById("light-x-input"),
      lightYInput: document.getElementById("light-y-input"),
      lightZInput: document.getElementById("light-z-input"),
      lensChip: document.getElementById("lens-chip"),
      addPointLightButton: document.getElementById("add-point-light-button"),
      lightTypeSelect: document.getElementById("light-type-select"),
      lightRotationFields: document.getElementById("light-rotation-fields"),
      lightAreaFields: document.getElementById("light-area-fields"),
      lightRxInput: document.getElementById("light-rx-input"),
      lightRyInput: document.getElementById("light-ry-input"),
      lightRzInput: document.getElementById("light-rz-input"),
      lightWidthInput: document.getElementById("light-width-input"),
      lightHeightInput: document.getElementById("light-height-input"),
      addPrimitiveButton: document.getElementById("add-primitive-button"),
      animationApplyButton: document.getElementById("animation-apply-button"),
      animationCopyDefaultButton: document.getElementById("animation-copy-default-button"),
      animationFileInput: document.getElementById("animation-file-input"),
      animationLoadPresetButton: document.getElementById("animation-load-preset-button"),
      animationLoopCheckbox: document.getElementById("animation-loop-checkbox"),
      animationOpenButton: document.getElementById("animation-open-button"),
      animationOriginModeSelect: document.getElementById("animation-origin-mode-select"),
      animationOriginXInput: document.getElementById("animation-origin-x-input"),
      animationOriginYInput: document.getElementById("animation-origin-y-input"),
      animationOriginZInput: document.getElementById("animation-origin-z-input"),
      animationPauseButton: document.getElementById("animation-pause-button"),
      animationPlayButton: document.getElementById("animation-play-button"),
      animationPresetSelect: document.getElementById("animation-preset-select"),
      animationResetButton: document.getElementById("animation-reset-button"),
      animationSaveButton: document.getElementById("animation-save-button"),
      animationScriptEditor: document.getElementById("animation-script-editor"),
      animationScriptStatus: document.getElementById("animation-script-status"),
      animationTimeLabel: document.getElementById("animation-time-label"),
      animationTimeRange: document.getElementById("animation-time-range"),
      timelineContent: document.getElementById("timeline-content"),
      timelineContext: document.querySelector(".timeline-empty-note"),
      timelineToggleButton: document.getElementById("timeline-toggle-button"),
      alignAddPointButton: document.getElementById("align-add-point-button"),
      alignApplyButton: document.getElementById("align-apply-button"),
      alignClearPointsButton: document.getElementById("align-clear-points-button"),
      alignPointList: document.getElementById("align-point-list"),
      alignResetButton: document.getElementById("align-reset-button"),
      alignRoleSelect: document.getElementById("align-role-select"),
      alignSourceSelect: document.getElementById("align-source-select"),
      alignStatus: document.getElementById("align-status"),
      alignTargetSelect: document.getElementById("align-target-select"),
      brushModeSelect: document.getElementById("brush-mode-select"),
      brushRadiusInput: document.getElementById("brush-radius-input"),
      brushRadiusRange: document.getElementById("brush-radius-range"),
      brushRelativeCheckbox: document.getElementById("brush-relative-checkbox"),
      brushScaleInput: document.getElementById("brush-scale-input"),
      brushScaleRange: document.getElementById("brush-scale-range"),
      brushStatus: document.getElementById("brush-status"),
      brushStrengthInput: document.getElementById("brush-strength-input"),
      brushStrengthRange: document.getElementById("brush-strength-range"),
      brushDepthInput: document.getElementById("brush-depth-input"),
      brushDepthRange: document.getElementById("brush-depth-range"),
      brushToggleButton: document.getElementById("brush-toggle-button"),
      brushUndoButton: document.getElementById("brush-undo-button"),
      brushResetButton: document.getElementById("brush-reset-button"),
      brushUndoLimitInput: document.getElementById("brush-undo-limit-input"),
      brushUndoLimitRange: document.getElementById("brush-undo-limit-range"),
      brushControlsSection: document.getElementById("brush-controls-section"),
      primitiveSelect: document.getElementById("primitive-select"),
      modeButtons: Array.from(document.querySelectorAll("[data-mode]")),
      moveSpeedInput: document.getElementById("move-speed-input"),
      moveSpeedRange: document.getElementById("move-speed-range"),
      openFileTriggers: Array.from(document.querySelectorAll("[data-open-file-trigger]")),
      opacityInput: document.getElementById("opacity-input"),
      opacityRange: document.getElementById("opacity-range"),
      pickColorButton: document.getElementById("pick-color-button"),
      pickedColorsEmpty: document.getElementById("picked-colors-empty"),
      pickedColorsList: document.getElementById("picked-colors-list"),
      progressFill: document.getElementById("progress-fill"),
      progressLabel: document.getElementById("progress-label"),
      progressTrack: document.getElementById("progress-track"),
      qualitySelect: document.getElementById("quality-select"),
      renderModeSelect: document.getElementById("render-mode-select"),
      renderFpsInput: document.getElementById("render-fps-input"),
      resetRotationButton: document.getElementById("reset-rotation-button"),
      resetViewButton: document.getElementById("reset-view-button"),
      saveSceneSplatsButton: document.getElementById("save-scene-splats-button"),
      selectedExposureInput: document.getElementById("selected-exposure-input"),
      selectedExposureRange: document.getElementById("selected-exposure-range"),
      sceneEmpty: document.getElementById("scene-empty"),
      sceneLimitInput: document.getElementById("scene-limit-input"),
      sceneLimitRange: document.getElementById("scene-limit-range"),
      sceneList: document.getElementById("scene-list"),
      sceneRenderSection: document.getElementById("scene-render-section"),
      sceneSelectInput: document.getElementById("scene-select-input"),
      sceneSelectRange: document.getElementById("scene-select-range"),
      sceneTransformSection: document.getElementById("scene-transform-section"),
      inspectorPanels: Array.from(document.querySelectorAll("[data-inspector-panel]")),
      inspectorTabButtons: Array.from(document.querySelectorAll("[data-inspector-tab]")),
      inspectorScroller: document.querySelector(".inspector-panels"),
      rotationXInput: document.getElementById("rotation-x-input"),
      rotationYInput: document.getElementById("rotation-y-input"),
      rotationZInput: document.getElementById("rotation-z-input"),
      scaleInput: document.getElementById("scale-input"),
      translateXInput: document.getElementById("translate-x-input"),
      translateYInput: document.getElementById("translate-y-input"),
      translateZInput: document.getElementById("translate-z-input"),
      shSelect: document.getElementById("sh-select"),
      speedChip: document.getElementById("speed-chip"),
      stage: document.getElementById("viewer-stage"),
      statusLine: document.getElementById("status-line"),
      toggleAutorotateButton: document.getElementById("toggle-autorotate-button"),
      toggleAxesButton: document.getElementById("toggle-axes-button"),
      toggleBoundsButton: document.getElementById("toggle-bounds-button"),
      toggleGizmoButton: document.getElementById("toggle-gizmo-button"),
      toggleGridButton: document.getElementById("toggle-grid-button"),
    };

    const {
      Gsplat,
      abs,
      add,
      clamp,
      combineGsplat,
      cos,
      cross,
      div,
      dot = dyno.Dot,
      dynoBlock,
      dynoConst,
      dynoFloat,
      dynoVec3,
      floor,
      fract,
      greaterThan,
      gsplatNormal,
      length,
      lessThan,
      max = dyno.Max,
      min = dyno.Min,
      mix,
      mul,
      normalize,
      pow,
      sign,
      sin,
      select,
      split,
      splitGsplat,
      step,
      sub,
    } = dyno;

    const formatBytes = (bytes) => {
      if (!Number.isFinite(bytes) || bytes <= 0) {
        return "-";
      }
      const units = ["B", "KB", "MB", "GB"];
      let value = bytes;
      let unitIndex = 0;
      while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
      }
      return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
    };

    const formatVector = (vector) =>
      `${vector.x.toFixed(2)} / ${vector.y.toFixed(2)} / ${vector.z.toFixed(2)}`;

    const formatRatio = (ratio) => {
      if (!Number.isFinite(ratio) || ratio <= 0) {
        return "-";
      }
      const decimals = ratio >= 10 ? 1 : 2;
      return `~${ratio.toFixed(decimals)}x`;
    };

    const formatNumber = (value, digits = 2) => {
      if (!Number.isFinite(value)) {
        return "-";
      }
      return value.toFixed(digits);
    };

    const linearRgbToSrgb8 = (linearRgb) => {
      const color = new THREE.Color(
        Math.max(linearRgb[0] ?? 0, 0),
        Math.max(linearRgb[1] ?? 0, 0),
        Math.max(linearRgb[2] ?? 0, 0),
      ).convertLinearToSRGB();
      return [
        Math.round(THREE.MathUtils.clamp(color.r, 0, 1) * 255),
        Math.round(THREE.MathUtils.clamp(color.g, 0, 1) * 255),
        Math.round(THREE.MathUtils.clamp(color.b, 0, 1) * 255),
      ];
    };

    const formatHoverColor = (linearRgb) => {
      const [r, g, b] = linearRgbToSrgb8(linearRgb);
      return `${String(r).padStart(3, "0")}/${String(g).padStart(3, "0")}/${String(b).padStart(3, "0")}`;
    };

    const formatLinearColor = (linearRgb) =>
      linearRgb
        .map((value) => (Number.isFinite(value) ? value.toFixed(Math.abs(value) >= 10 ? 2 : 4) : "-"))
        .join(" / ");

    const formatSrgbColor = (linearRgb) => {
      const [r, g, b] = linearRgbToSrgb8(linearRgb);
      return `${String(r).padStart(3, "0")} / ${String(g).padStart(3, "0")} / ${String(b).padStart(3, "0")}`;
    };

    const toLinearRgbArray = (color) => {
      if (!color) {
        return [0, 0, 0];
      }
      if (Array.isArray(color)) {
        return [
          Number(color[0]) || 0,
          Number(color[1]) || 0,
          Number(color[2]) || 0,
        ];
      }
      return [
        Number(color.r ?? color.x ?? 0) || 0,
        Number(color.g ?? color.y ?? 0) || 0,
        Number(color.b ?? color.z ?? 0) || 0,
      ];
    };

    const clipPadText = (value, width) => {
      const text = String(value ?? "");
      if (text.length === width) {
        return text;
      }
      if (text.length > width) {
        return `${text.slice(0, Math.max(width - 1, 0))}\u2026`;
      }
      return text.padEnd(width, " ");
    };

    const formatSpeedLabel = (value) =>
      `${Number(value).toFixed(value < 10 ? 2 : 1)} u/s`;

    const formatDepthLabel = (value) =>
      `${Number(value).toFixed(value < 10 ? 1 : 0)} u`;

    const formatPositionRangeLabel = (value) =>
      `${Number(value).toFixed(value < 10 ? 2 : 1)}x`;

    const formatExposureLabel = (value) =>
      `${Number(value).toFixed(Math.abs(value) < 1 ? 1 : 2)} EV`;

    const formatScaleRange = (minValue, maxValue) =>
      Number.isFinite(minValue) && Number.isFinite(maxValue)
        ? `${formatNumber(minValue, 4)} - ${formatNumber(maxValue, 4)}`
        : "-";

    const formatShLabel = (degree) =>
      Number.isFinite(degree) && degree >= 0 ? `SH${degree}` : "-";

    const sanitizeDownloadName = (value) =>
      (String(value ?? "scene-splat")
        .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        || "scene-splat");

    const buildUniqueFileName = (baseName, extension, usedNames) => {
      const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
      const stem = sanitizeDownloadName(baseName).replace(/\.[^.]+$/, "") || "scene-splat";
      let candidate = `${stem}${normalizedExtension}`;
      if (!usedNames.has(candidate.toLowerCase())) {
        usedNames.add(candidate.toLowerCase());
        return candidate;
      }
      let serial = 2;
      while (true) {
        candidate = `${stem}_${String(serial).padStart(2, "0")}${normalizedExtension}`;
        if (!usedNames.has(candidate.toLowerCase())) {
          usedNames.add(candidate.toLowerCase());
          return candidate;
        }
        serial += 1;
      }
    };

    const createDefaultModelMeta = (name = "No file loaded", source = "Waiting for input") => ({
      activeSh: "-",
      bytes: 0,
      compression: "-",
      compressionRatio: "-",
      elapsedMs: 0,
      encoding: "-",
      format: "-",
      name,
      packedCapacity: "-",
      scaleRange: "-",
      shDegree: "-",
      source,
      splats: 0,
    });

    const isIntermediateNumericInput = (value) =>
      value === "" || value === "-" || value === "." || value === "-." || value === "+";

    const createSplatColorTransferModifier = (toLinear) =>
      dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
        const channels = split(splitGsplat(gsplat).outputs.rgb).outputs;
        const transfer = (value) => {
          const x = clamp(value, dynoConst("float", 0), dynoConst("float", 1));
          return toLinear
            ? select(
              lessThan(x, dynoConst("float", 0.04045)),
              div(x, dynoConst("float", 12.92)),
              pow(div(add(x, dynoConst("float", 0.055)), dynoConst("float", 1.055)), dynoConst("float", 2.4)),
            )
            : select(
              lessThan(x, dynoConst("float", 0.0031308)),
              mul(x, dynoConst("float", 12.92)),
              sub(mul(dynoConst("float", 1.055), pow(x, dynoConst("float", 1 / 2.4))), dynoConst("float", 0.055)),
            );
        };
        return { gsplat: combineGsplat({
          gsplat, r: transfer(channels.x), g: transfer(channels.y), b: transfer(channels.z),
        }) };
      });

    const createWorldNormalModifier = () =>
      dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
        if (!gsplat) {
          throw new Error("No gsplat input");
        }
        const rawNormal = gsplatNormal(gsplat);
        const normal = div(rawNormal, length(rawNormal));
        const rgb = add(
          mul(normal, dynoConst("float", 0.5)),
          dynoConst("float", 0.5),
        );
        return { gsplat: combineGsplat({ gsplat, rgb }) };
      });

    const createDepthColorModifier = ({ maxDepth }, splatToView) =>
      dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
        if (!gsplat) {
          throw new Error("No gsplat input");
        }
        const center = splatToView.apply(splitGsplat(gsplat).outputs.center);
        const depth = clamp(
          div(length(center), maxDepth),
          dynoConst("float", 0),
          dynoConst("float", 1),
        );
        return { gsplat: combineGsplat({ gsplat, r: depth, g: depth, b: depth }) };
      });

    const createPositionColorModifier = ({ minCorner, span, scaleFactor }) =>
      dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
        if (!gsplat) {
          throw new Error("No gsplat input");
        }
        const center = splitGsplat(gsplat).outputs.center;
        const scaledSpan = mul(span, scaleFactor);
        const normalized = clamp(
          div(sub(center, minCorner), scaledSpan),
          dynoConst("float", 0),
          dynoConst("float", 1),
        );
        const { x: r, y: g, z: b } = split(normalized).outputs;
        return { gsplat: combineGsplat({ gsplat, r, g, b }) };
      });

    const createLightOcclusionTexture = (data = new Float32Array([1]), width = 1, height = 1) => {
      const texture = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.FloatType);
      texture.colorSpace = THREE.NoColorSpace;
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.flipY = false;
      texture.needsUpdate = true;
      return texture;
    };

    const readLightOcclusion = (index, handles, lightIndex, lightCount) => new dyno.Dyno({
      inTypes: { index: "int", enabled: "bool", count: "int", width: "int", texture: "sampler2D" },
      outTypes: { transmission: "float" },
      inputs: { index, enabled: handles.enabled, count: handles.count, width: handles.width, texture: handles.sampler },
      statements: ({ inputs, outputs }) => [
        `${outputs.transmission} = 1.0;`,
        `if (${inputs.enabled} && ${inputs.index} >= 0 && ${inputs.index} < ${inputs.count}) {`,
        `  int occlusionSlot = ${inputs.index} * ${lightCount} + ${lightIndex};`,
        `  ivec2 occlusionUv = ivec2(occlusionSlot % ${inputs.width}, occlusionSlot / ${inputs.width});`,
        `  ${outputs.transmission} = texelFetch(${inputs.texture}, occlusionUv, 0).r;`,
        "}",
      ],
    }).outputs.transmission;

    const createPointLightColorModifier = ({
      cameraPosition,
      faceForwardToCamera,
      lightColorB,
      lightColorG,
      lightColorR,
      lightIntensities,
      lightOccluderCount,
      lightOcclusionHandles,
      lightPositions,
      lightTypes,
      lightDirections,
      lightCount,
      occluderOpacities,
      occluderPositions,
      occluderRadii,
      oneBounceFluxB,
      oneBounceFluxG,
      oneBounceFluxR,
      oneBounceNormals,
      oneBouncePositions,
      oneBounceRadii,
    }) =>
      dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
        if (!gsplat) {
          throw new Error("No gsplat input");
        }
        const outputs = splitGsplat(gsplat).outputs;
        const center = outputs.center;
        const { x: rgbR, y: rgbG, z: rgbB } = split(outputs.rgb).outputs;
        const floatZero = dynoConst("float", 0);
        const floatOne = dynoConst("float", 1);
        const floatNegativeOne = dynoConst("float", -1);
        const floatTwo = dynoConst("float", 2);
        const floatEps = dynoConst("float", 0.0001);
        const shadowEndpointBiasScale = dynoConst("float", 1.5);
        const shadowEndpointLengthLimit = dynoConst("float", 0.25);
        const rawNormal = gsplatNormal(gsplat);
        // Imported orientations use the shortest covariance axis face-forwarded
        // to the camera. This is intentionally only an approximate normal.
        const cameraFacingSign = sub(
          mul(step(floatZero, dot(rawNormal, sub(cameraPosition, center))), floatTwo),
          floatOne,
        );
        const orientedNormal = faceForwardToCamera
          ? mul(rawNormal, cameraFacingSign)
          : rawNormal;
        const normal = div(orientedNormal, max(length(orientedNormal), floatEps));
        let lightBoostR = floatZero;
        let lightBoostG = floatZero;
        let lightBoostB = floatZero;
        for (let lightIndex = 0; lightIndex < lightCount; lightIndex += 1) {
          const lightPosition = lightPositions[lightIndex];
          const lightIntensity = max(lightIntensities[lightIndex], floatZero);
          const isDirectional = greaterThan(lightTypes[lightIndex], dynoConst('float', 0.5));
          const isArea = greaterThan(lightTypes[lightIndex], dynoConst('float', 1.5));
          const toLight = select(isArea, sub(lightPosition, center), select(isDirectional, mul(lightDirections[lightIndex], floatNegativeOne), sub(lightPosition, center)));
          const lightDistanceSq = select(isArea, max(dot(toLight, toLight), floatEps), select(isDirectional, floatOne, max(dot(toLight, toLight), floatEps)));
          const lightDirection = div(toLight, max(length(toLight), floatEps));
          const lightFacing = max(dot(normal, lightDirection), floatZero);
          let visibility = floatOne;
          // Active lights are compacted before this modifier is built, so index
          // zero is the first visible point light. This sampled shadow is an
          // approximation in native, unspecified scene units.
          if (lightIndex === 0) {
            for (let occluderIndex = 0; occluderIndex < lightOccluderCount; occluderIndex += 1) {
              const occluderPosition = occluderPositions[occluderIndex];
              const occluderRadius = max(occluderRadii[occluderIndex], floatEps);
              const occluderOpacity = clamp(occluderOpacities[occluderIndex], floatZero, floatOne);
              const segmentLength = max(length(toLight), floatEps);
              const endpointBias = min(
                mul(occluderRadius, shadowEndpointBiasScale),
                mul(segmentLength, shadowEndpointLengthLimit),
              );
              const biasedLight = sub(lightPosition, mul(lightDirection, endpointBias));
              const biasedReceiver = add(center, mul(lightDirection, endpointBias));
              const biasedSegment = sub(biasedReceiver, biasedLight);
              const biasedSegmentLengthSq = max(dot(biasedSegment, biasedSegment), floatEps);
              const toOccluder = sub(occluderPosition, biasedLight);
              const rawSegmentT = div(dot(toOccluder, biasedSegment), biasedSegmentLengthSq);
              const segmentT = clamp(
                rawSegmentT,
                floatZero,
                floatOne,
              );
              const closestPoint = add(biasedLight, mul(biasedSegment, segmentT));
              const closestDelta = sub(occluderPosition, closestPoint);
              const softCoverage = mul(
                clamp(
                  sub(floatOne, div(dot(closestDelta, closestDelta), mul(occluderRadius, occluderRadius))),
                  floatZero,
                  floatOne,
                ),
                occluderOpacity,
              );
              const coverage = select(
                greaterThan(rawSegmentT, floatZero),
                select(lessThan(rawSegmentT, floatOne), softCoverage, floatZero),
                floatZero,
              );
              visibility = mul(visibility, sub(floatOne, coverage));
            }
          }
          if (lightOcclusionHandles) {
            visibility = mul(visibility, readLightOcclusion(outputs.index, lightOcclusionHandles, lightIndex, lightCount));
          }
          const emission = select(isArea, max(dot(lightDirections[lightIndex], mul(lightDirection, floatNegativeOne)), floatZero), floatOne);
          const lightStrength = mul(mul(mul(div(lightIntensity, lightDistanceSq), lightFacing), visibility), emission);
          lightBoostR = add(lightBoostR, mul(lightColorR[lightIndex], lightStrength));
          lightBoostG = add(lightBoostG, mul(lightColorG[lightIndex], lightStrength));
          lightBoostB = add(lightBoostB, mul(lightColorB[lightIndex], lightStrength));
        }
        let oneBounceBoostR = floatZero;
        let oneBounceBoostG = floatZero;
        let oneBounceBoostB = floatZero;
        // Fixed padded VPL handles avoid recompiling the Dyno modifier when
        // this intentionally leaky one-bounce preview is toggled or re-ranked.
        for (let vplIndex = 0; vplIndex < ONE_BOUNCE_VPL_LIMIT; vplIndex += 1) {
          const vplPosition = oneBouncePositions[vplIndex];
          const vplRadius = max(oneBounceRadii[vplIndex], floatZero);
          const toVpl = sub(vplPosition, center);
          const vplDistanceSq = dot(toVpl, toVpl);
          const vplDirection = div(toVpl, max(length(toVpl), floatEps));
          const vplNormal = div(
            oneBounceNormals[vplIndex],
            max(length(oneBounceNormals[vplIndex]), floatEps),
          );
          const receiverFacing = max(dot(normal, vplDirection), floatZero);
          const emitterFacing = max(dot(vplNormal, mul(vplDirection, floatNegativeOne)), floatZero);
          const nearDistance = mul(vplRadius, floatTwo);
          const outsideNearField = select(
            greaterThan(vplDistanceSq, max(mul(nearDistance, nearDistance), floatEps)),
            floatOne,
            floatZero,
          );
          const vplStrength = mul(
            outsideNearField,
            mul(
              mul(receiverFacing, emitterFacing),
              div(floatOne, max(vplDistanceSq, floatEps)),
            ),
          );
          oneBounceBoostR = add(oneBounceBoostR, mul(max(oneBounceFluxR[vplIndex], floatZero), vplStrength));
          oneBounceBoostG = add(oneBounceBoostG, mul(max(oneBounceFluxG[vplIndex], floatZero), vplStrength));
          oneBounceBoostB = add(oneBounceBoostB, mul(max(oneBounceFluxB[vplIndex], floatZero), vplStrength));
        }
        return {
          gsplat: combineGsplat({
            gsplat,
            r: add(add(rgbR, mul(rgbR, lightBoostR)), mul(rgbR, oneBounceBoostR)),
            g: add(add(rgbG, mul(rgbG, lightBoostG)), mul(rgbG, oneBounceBoostG)),
            b: add(add(rgbB, mul(rgbB, lightBoostB)), mul(rgbB, oneBounceBoostB)),
          }),
        };
      });

    const evaluateToneCurveExpression = (value, points) => {
      const { curve: curvePoints, tangents } = getToneCurveSpline(points);
      const floatZero = dynoConst("float", 0);
      const floatOne = dynoConst("float", 1);
      let result = dynoConst("float", curvePoints[0]?.y ?? 0);
      curvePoints.slice(0, -1).forEach((point, index) => {
        const nextPoint = curvePoints[index + 1];
        const span = Math.max(nextPoint.x - point.x, 0.001);
        const t = clamp(
          div(sub(value, dynoConst("float", point.x)), dynoConst("float", span)),
          floatZero,
          floatOne,
        );
        // Sum clamped Hermite segment deltas. Completed segments contribute
        // y1-y0, later segments zero; only the current segment is interpolated.
        const m0 = span * tangents[index];
        const m1 = span * tangents[index + 1];
        const a = 2 * point.y - 2 * nextPoint.y + m0 + m1;
        const b = -3 * point.y + 3 * nextPoint.y - 2 * m0 - m1;
        result = add(result, mul(t, add(dynoConst("float", m0), mul(t, add(
          dynoConst("float", b), mul(t, dynoConst("float", a)),
        )))));
      });
      return clamp(result, floatZero, floatOne);
    };

    const createToneCurveColorModifier = (toneCurveState) => {
      const toneCurve = normalizeToneCurveState(toneCurveState);
      return dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
        if (!gsplat) {
          throw new Error("No gsplat input");
        }
        const outputs = splitGsplat(gsplat).outputs;
        const { x: rgbR, y: rgbG, z: rgbB } = split(outputs.rgb).outputs;
        const masterR = evaluateToneCurveExpression(rgbR, toneCurve.curves.master);
        const masterG = evaluateToneCurveExpression(rgbG, toneCurve.curves.master);
        const masterB = evaluateToneCurveExpression(rgbB, toneCurve.curves.master);
        return {
          gsplat: combineGsplat({
            gsplat,
            r: evaluateToneCurveExpression(masterR, toneCurve.curves.red),
            g: evaluateToneCurveExpression(masterG, toneCurve.curves.green),
            b: evaluateToneCurveExpression(masterB, toneCurve.curves.blue),
          }),
        };
      });
    };

    const getFileExtension = (name) => (name.split(".").pop() || "").toLowerCase();

    const detectSplatFileType = (name) => {
      const extension = getFileExtension(name);
      if (extension === "splat") {
        return SplatFileType?.SPLAT ?? "splat";
      }
      if (extension === "ksplat") {
        return SplatFileType?.KSPLAT ?? "ksplat";
      }
      if (extension === "spz") {
        return SplatFileType?.SPZ ?? "spz";
      }
      if (extension === "ply") {
        return SplatFileType?.PLY ?? "ply";
      }
      return undefined;
    };

    const isSupportedFile = (file) =>
      ["ksplat", "ply", "splat", "spz"].includes(getFileExtension(file.name));

    const parseRotationValue = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const clampNumber = (value, { min, max }) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return min;
      }
      return THREE.MathUtils.clamp(parsed, min, max);
    };

    const sliderToFocalLength = (sliderValue) => {
      const normalized = THREE.MathUtils.clamp(
        Number(sliderValue) / FOCAL_LENGTH_SLIDER_LIMITS.max,
        0,
        1,
      );
      if (normalized <= FOCAL_LENGTH_COMMON_WEIGHT) {
        const local = normalized / FOCAL_LENGTH_COMMON_WEIGHT;
        return THREE.MathUtils.lerp(
          FOCAL_LENGTH_LIMITS.min,
          FOCAL_LENGTH_COMMON_LIMIT,
          local,
        );
      }
      const local = (normalized - FOCAL_LENGTH_COMMON_WEIGHT) / (1 - FOCAL_LENGTH_COMMON_WEIGHT);
      return THREE.MathUtils.lerp(
        FOCAL_LENGTH_COMMON_LIMIT,
        FOCAL_LENGTH_LIMITS.max,
        local,
      );
    };

    const focalLengthToSlider = (focalLength) => {
      const clamped = THREE.MathUtils.clamp(
        Number(focalLength),
        FOCAL_LENGTH_LIMITS.min,
        FOCAL_LENGTH_LIMITS.max,
      );
      let normalized;
      if (clamped <= FOCAL_LENGTH_COMMON_LIMIT) {
        normalized = THREE.MathUtils.mapLinear(
          clamped,
          FOCAL_LENGTH_LIMITS.min,
          FOCAL_LENGTH_COMMON_LIMIT,
          0,
          FOCAL_LENGTH_COMMON_WEIGHT,
        );
      } else {
        normalized = THREE.MathUtils.mapLinear(
          clamped,
          FOCAL_LENGTH_COMMON_LIMIT,
          FOCAL_LENGTH_LIMITS.max,
          FOCAL_LENGTH_COMMON_WEIGHT,
          1,
        );
      }
      return Math.round(normalized * FOCAL_LENGTH_SLIDER_LIMITS.max);
    };

    const firstFinite = (...values) =>
      values.find((value) => Number.isFinite(value) && value >= 0);

    const inferShDegree = (mesh) =>
      THREE.MathUtils.clamp(
        firstFinite(
          mesh?.maxShDegree,
          mesh?.packedSplats?.maxShDegree,
          mesh?.packedSplats?.meta?.maxShDegree,
          mesh?.gsplatArray?.maxShDegree,
          mesh?.csplatArray?.maxShDegree,
          mesh?.packedSplats?.shDegree,
          mesh?.packedSplats?.meta?.shDegree,
          3,
        ),
        0,
        3,
      );

    const estimateRawGaussianBytes = (splats, shDegree) => {
      if (!Number.isFinite(splats) || splats <= 0) {
        return 0;
      }
      const shCoefficients = Math.max(((shDegree + 1) ** 2) - 1, 0) * 3;
      const baseBytesPerSplat = 64;
      return splats * (baseBytesPerSplat + shCoefficients * 4);
    };

    const readPlyHeaderText = (fileBytes) => {
      if (!(fileBytes instanceof ArrayBuffer) || fileBytes.byteLength === 0) {
        return "";
      }
      const prefix = new Uint8Array(fileBytes, 0, Math.min(fileBytes.byteLength, 65536));
      const text = new TextDecoder("latin1").decode(prefix);
      const headerEndMatch = text.match(/end_header\r?\n/i);
      return headerEndMatch ? text.slice(0, headerEndMatch.index + headerEndMatch[0].length) : "";
    };

    const detectPlyCompressionLabel = (fileBytes) => {
      const header = readPlyHeaderText(fileBytes).toLowerCase();
      if (!header.startsWith("ply")) {
        return COMPRESSION_LABELS.ply;
      }
      const hasChunkTable = header.includes("element chunk");
      const hasPackedFields = [
        "property uint packed_position",
        "property uint packed_rotation",
        "property uint packed_scale",
        "property uint packed_color",
      ].every((marker) => header.includes(marker));
      if (hasChunkTable && hasPackedFields) {
        return "Packed PLY (chunked)";
      }
      if (hasPackedFields) {
        return "Packed PLY";
      }
      return COMPRESSION_LABELS.ply;
    };

    const formatEncodingMeta = (encoding) => {
      if (!encoding) {
        return "RGB 0..1 / lnScale -12..9 / lodAlpha off";
      }
      const rgbMin = Number.isFinite(encoding.rgbMin) ? encoding.rgbMin : 0;
      const rgbMax = Number.isFinite(encoding.rgbMax) ? encoding.rgbMax : 1;
      const lnScaleMin = Number.isFinite(encoding.lnScaleMin) ? encoding.lnScaleMin : -12;
      const lnScaleMax = Number.isFinite(encoding.lnScaleMax) ? encoding.lnScaleMax : 9;
      const lodText = encoding.lodOpacity ? "lodAlpha on" : "lodAlpha off";
      return `RGB ${formatNumber(rgbMin, 2)}..${formatNumber(rgbMax, 2)} / lnScale ${formatNumber(lnScaleMin, 1)}..${formatNumber(lnScaleMax, 1)} / ${lodText}`;
    };

    const SH_C0 = 0.28209479177387814;

    const alphaToOpacity = (alpha) => {
      const clamped = THREE.MathUtils.clamp(alpha, 0.000001, 0.999999);
      return Math.log(clamped / (1 - clamped));
    };

    const colorToDc = (color) => ((THREE.MathUtils.clamp(color, 0, 1) - 0.5) / SH_C0);

    const createQuaternionFromNormal = (normal) => {
      const quaternion = new THREE.Quaternion();
      quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
      return quaternion;
    };

    const sanitizePlyComment = (value) =>
      String(value ?? "")
        .replace(/[\r\n]+/g, " ")
        .replace(/[^\x20-\x7e]/g, "?")
        .trim()
        .slice(0, 240);

    // Colors passed here are already encoded in the declared storage space.
    const packGaussianPly = (splats, comments = [], colorSpace = SPLAT_COLOR_SPACE.SRGB) => {
      const commentLines = comments
        .map(sanitizePlyComment)
        .filter(Boolean)
        .map((comment) => `comment ${comment}`);
      const header = [
        "ply",
        "format binary_little_endian 1.0",
        `comment color_space ${colorSpace}`,
        ...commentLines,
        `element vertex ${splats.length}`,
        "property float x",
        "property float y",
        "property float z",
        "property float nx",
        "property float ny",
        "property float nz",
        "property float f_dc_0",
        "property float f_dc_1",
        "property float f_dc_2",
        "property float opacity",
        "property float scale_0",
        "property float scale_1",
        "property float scale_2",
        "property float rot_0",
        "property float rot_1",
        "property float rot_2",
        "property float rot_3",
        "end_header\n",
      ].join("\n");
      const headerBytes = new TextEncoder().encode(header);
      const buffer = new ArrayBuffer(headerBytes.byteLength + (splats.length * 17 * 4));
      const bytes = new Uint8Array(buffer);
      bytes.set(headerBytes, 0);
      const view = new DataView(buffer, headerBytes.byteLength);
      splats.forEach((splat, index) => {
        const offset = index * 17 * 4;
        const values = [
          splat.position.x,
          splat.position.y,
          splat.position.z,
          splat.normal.x,
          splat.normal.y,
          splat.normal.z,
          colorToDc(splat.color.r),
          colorToDc(splat.color.g),
          colorToDc(splat.color.b),
          alphaToOpacity(splat.alpha),
          Math.log(splat.scale.x),
          Math.log(splat.scale.y),
          Math.log(splat.scale.z),
          splat.quaternion.w,
          splat.quaternion.x,
          splat.quaternion.y,
          splat.quaternion.z,
        ];
        values.forEach((value, valueIndex) => {
          view.setFloat32(offset + (valueIndex * 4), value, true);
        });
      });
      return buffer;
    };

    const createPrimitiveSpec = async (kind) => {
      if (!window.PrimitiveLibrary?.createPrimitiveDefinition) {
        throw new Error("Primitive library failed to load");
      }
      const definition = await window.PrimitiveLibrary.createPrimitiveDefinition({
        kind,
        THREE,
        helpers: {
          createQuaternionFromNormal,
          formatScaleRange,
        },
      });
      const hoverEntries = definition.hoverEntries?.map((entry) => {
        const position = new THREE.Vector3(...entry.position);
        let splatIndex = 0;
        let distance = Infinity;
        definition.splats.forEach((splat, index) => {
          const nextDistance = position.distanceToSquared(splat.position);
          if (nextDistance < distance) { distance = nextDistance; splatIndex = index; }
        });
        return {
          alpha: entry.alpha,
          color: entry.color.slice(),
          label: entry.label || "",
          localNormal: definition.splats[splatIndex]?.normal?.clone(),
          position,
          scale: new THREE.Vector3(...entry.scale),
          splatIndex,
        };
      }) ?? definition.splats.map((splat, index) => ({
        alpha: splat.alpha,
        color: [splat.color.r, splat.color.g, splat.color.b],
        label: `${definition.name} ${index + 1}`,
        localNormal: splat.normal?.clone(),
        position: splat.position.clone(),
        scale: splat.scale.clone(),
        splatIndex: index,
      }));
      return {
        ...definition,
        authoredSplats: definition.splats,
        bytes: definition.splats.length * 17 * 4,
        buffer: packGaussianPly(definition.splats, [], SPLAT_COLOR_SPACE.LINEAR),
        hoverEntries,
        splats: definition.splats.length,
      };
    };

    const getBoxCorners = (box) => {
      if (!box) {
        return [];
      }
      const { min, max } = box;
      return [
        new THREE.Vector3(min.x, min.y, min.z),
        new THREE.Vector3(min.x, min.y, max.z),
        new THREE.Vector3(min.x, max.y, min.z),
        new THREE.Vector3(min.x, max.y, max.z),
        new THREE.Vector3(max.x, min.y, min.z),
        new THREE.Vector3(max.x, min.y, max.z),
        new THREE.Vector3(max.x, max.y, min.z),
        new THREE.Vector3(max.x, max.y, max.z),
      ];
    };

    const computeCenterBounds = (mesh, fallbackBounds) => {
      const packedSplats = mesh?.packedSplats;
      if (packedSplats?.forEachSplat) {
        try {
          const bounds = new THREE.Box3();
          let hasPoint = false;
          packedSplats.forEachSplat((splat) => {
            const center = splat?.center ?? splat?.position;
            if (!center) {
              return;
            }
            const point = new THREE.Vector3(center.x, center.y, center.z);
            if (!hasPoint) {
              bounds.min.copy(point);
              bounds.max.copy(point);
              hasPoint = true;
              return;
            }
            bounds.expandByPoint(point);
          });
          if (hasPoint) {
            return bounds;
          }
        } catch {
          return fallbackBounds.clone();
        }
      }
      return fallbackBounds.clone();
    };

    const createAxisLabelSprite = (label, color) => {
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 96;
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "rgba(4, 8, 14, 0.82)";
      context.beginPath();
      context.arc(48, 48, 30, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = color;
      context.font = "700 36px 'Space Grotesk', sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(label, 48, 49);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      });
      material.toneMapped = false;
      const sprite = new THREE.Sprite(material);
      sprite.scale.setScalar(0.24);
      sprite.renderOrder = 20;
      return sprite;
    };

    class FirstPersonController {
      constructor(camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;
        this.onChange = null;
        this.pointerEnabled = false;
        this.movementEnabled = true;
        this.dragMode = null;
        this.keys = new Set();
        this.lookSpeed = 0.0023;
        this.moveSpeed = 1.4;
        this.boostMultiplier = 2.8;
        this.pitchLimit = Math.PI / 2 - 0.03;
        this.pitch = 0;
        this.yaw = 0;
        this.lastX = 0;
        this.lastY = 0;
        this.euler = new THREE.Euler(0, 0, 0, "YXZ");
        this.forward = new THREE.Vector3();
        this.right = new THREE.Vector3();
        this.up = new THREE.Vector3(0, 1, 0);
        this.screenUp = new THREE.Vector3();
        this.move = new THREE.Vector3();
        this.lastMovementDelta = new THREE.Vector3();
        this.handleKeyDown = (event) => {
          if (isEditableKeyboardTarget(event.target)) {
            return;
          }
          if (FPS_KEYS.has(event.code)) {
            const sizeBefore = this.keys.size;
            this.keys.add(event.code);
            if (this.keys.size !== sizeBefore) {
              this.notifyChange();
            }
          }
        };
        this.handleKeyUp = (event) => {
          if (isEditableKeyboardTarget(event.target)) {
            return;
          }
          if (FPS_KEYS.has(event.code)) {
            const removed = this.keys.delete(event.code);
            if (removed) {
              this.notifyChange();
            }
          }
        };
        this.handlePointerDown = (event) => {
          if (!this.pointerEnabled || (event.button !== 0 && event.button !== 2)) {
            return;
          }
          this.dragMode = (event.button === 2 || event.buttons === 2 || event.which === 3) ? "pan" : "look";
          this.lastX = event.clientX;
          this.lastY = event.clientY;
          this.domElement.classList.toggle("is-looking", this.dragMode === "look");
          this.domElement.classList.toggle("is-panning", this.dragMode === "pan");
          this.notifyChange();
          event.preventDefault();
        };
        this.handlePointerMove = (event) => {
          if (!this.pointerEnabled || !this.dragMode) {
            return;
          }
          if (event.buttons === 0) {
            this.handlePointerUp();
            return;
          }
          if ((event.buttons === 2 || event.which === 3) && this.dragMode !== "pan") {
            this.dragMode = "pan";
            this.domElement.classList.remove("is-looking");
            this.domElement.classList.add("is-panning");
          }
          const deltaX = event.clientX - this.lastX;
          const deltaY = event.clientY - this.lastY;
          this.lastX = event.clientX;
          this.lastY = event.clientY;
          if (this.dragMode === "look") {
            this.yaw -= deltaX * this.lookSpeed;
            this.pitch = THREE.MathUtils.clamp(
              this.pitch - deltaY * this.lookSpeed,
              -this.pitchLimit,
              this.pitchLimit,
            );
            this.euler.set(this.pitch, this.yaw, 0, "YXZ");
            this.camera.quaternion.setFromEuler(this.euler);
            this.notifyChange();
            return;
          }
          this.camera.updateMatrixWorld(true);
          this.right.setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
          this.screenUp.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
          const panScale = this.moveSpeed * 0.012;
          this.camera.position.addScaledVector(this.right, -deltaX * panScale);
          this.camera.position.addScaledVector(this.screenUp, deltaY * panScale);
          this.notifyChange();
        };
        this.handlePointerUp = () => {
          const wasDragging = Boolean(this.dragMode);
          this.dragMode = null;
          this.domElement.classList.remove("is-looking");
          this.domElement.classList.remove("is-panning");
          if (wasDragging) {
            this.notifyChange();
          }
        };
        window.addEventListener("keydown", this.handleKeyDown);
        window.addEventListener("keyup", this.handleKeyUp);
        window.addEventListener("mouseup", this.handlePointerUp);
        window.addEventListener("mousemove", this.handlePointerMove);
        window.addEventListener("blur", () => {
          this.keys.clear();
          this.handlePointerUp();
        });
        domElement.addEventListener("mousedown", this.handlePointerDown);
      }

      notifyChange() {
        if (typeof this.onChange === "function") {
          this.onChange();
        }
      }

      setPointerEnabled(enabled) {
        this.pointerEnabled = Boolean(enabled);
        if (!this.pointerEnabled) {
          this.dragMode = null;
          this.domElement.classList.remove("is-looking");
          this.domElement.classList.remove("is-panning");
          return;
        }
        this.syncFromCamera();
      }

      setMovementEnabled(enabled) {
        this.movementEnabled = Boolean(enabled);
        if (!this.movementEnabled) {
          this.keys.clear();
          this.lastMovementDelta.set(0, 0, 0);
        }
      }

      setSpeed(speed) {
        this.moveSpeed = Math.max(speed, 0.001);
      }

      dolly(amount) {
        if (!this.pointerEnabled || !Number.isFinite(amount) || amount === 0) {
          return;
        }
        const direction = new THREE.Vector3();
        this.camera.getWorldDirection(direction);
        if (direction.lengthSq() < 1e-6) {
          direction.copy(DEFAULT_LOOK);
        }
        this.camera.position.addScaledVector(direction.normalize(), amount);
        this.notifyChange();
      }

      syncFromCamera() {
        this.euler.setFromQuaternion(this.camera.quaternion, "YXZ");
        this.pitch = THREE.MathUtils.clamp(this.euler.x, -this.pitchLimit, this.pitchLimit);
        this.yaw = this.euler.y;
      }

      update(delta) {
        if (!this.movementEnabled) {
          this.lastMovementDelta.set(0, 0, 0);
          return false;
        }
        let moved = false;
        this.move.set(0, 0, 0);
        this.camera.getWorldDirection(this.forward);
        this.forward.y = 0;
        if (this.forward.lengthSq() < 1e-6) {
          this.forward.copy(DEFAULT_LOOK);
        }
        this.forward.normalize();
        this.right.crossVectors(this.forward, this.up).normalize();
        if (this.keys.has("KeyW")) {
          this.move.add(this.forward);
        }
        if (this.keys.has("KeyS")) {
          this.move.sub(this.forward);
        }
        if (this.keys.has("KeyD")) {
          this.move.add(this.right);
        }
        if (this.keys.has("KeyA")) {
          this.move.sub(this.right);
        }
        if (this.keys.has("KeyE")) {
          this.move.add(this.up);
        }
        if (this.keys.has("KeyQ")) {
          this.move.sub(this.up);
        }
        if (this.move.lengthSq() === 0) {
          this.lastMovementDelta.set(0, 0, 0);
          return moved;
        }
        const boost = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")
          ? this.boostMultiplier
          : 1;
        this.move.normalize();
        this.lastMovementDelta.copy(this.move).multiplyScalar(delta * this.moveSpeed * boost);
        this.camera.position.add(this.lastMovementDelta);
        moved = true;
        return moved;
      }
    }

    class GaussianViewerApp {
      constructor(elements) {
        this.dom = elements;
        this.isFileProtocol = window.location.protocol === "file:";
        this.clock = new THREE.Clock();
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(60, 1, 0.0005, 5000);
        this.camera.position.set(0, 0, 0);
        this.camera.lookAt(DEFAULT_LOOK);
        this.scene.add(this.camera);

        this.splatSceneRoot = new THREE.Group();
        this.scene.add(this.splatSceneRoot);
        this.lightSceneRoot = new THREE.Group();
        this.scene.add(this.lightSceneRoot);
        this.modelRoot = null;
        this.rotationPivot = null;

        this.renderer = new THREE.WebGLRenderer({
          alpha: true,
          antialias: false,
          powerPreference: "high-performance",
        });
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.LinearToneMapping;
        this.renderer.toneMappingExposure = 1;
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(320, 240, false);
        this.renderer.setClearColor(BACKGROUNDS.graphite);

        this.spark = new SparkRenderer({
          falloff: 1,
          focalAdjustment: 1,
          maxStdDev: QUALITY.balanced.maxStdDev,
          renderer: this.renderer,
        });
        this.scene.add(this.spark);

        this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
        this.orbitControls.enableDamping = true;
        this.orbitControls.dampingFactor = 0.08;
        this.orbitControls.enablePan = true;
        this.orbitControls.screenSpacePanning = true;
        this.orbitControls.zoomSpeed = 1.18;
        this.orbitControls.target.copy(DEFAULT_LOOK);
        this.orbitControls.update();
        this.orbitControls.enabled = true;

        this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
        this.transformControlsHelper = this.transformControls.getHelper();
        this.transformControls.enabled = false;
        this.transformControls.visible = false;
        this.transformControls.size = 0.9;
        this.transformControls.space = "local";
        this.transformControlsHelper.visible = false;
        this.gizmoScene = new THREE.Scene();
        this.gizmoScene.add(this.transformControlsHelper);

        this.firstPerson = new FirstPersonController(this.camera, this.renderer.domElement);
        this.firstPerson.setPointerEnabled(false);
        this.firstPerson.setMovementEnabled(true);
        this.firstPerson.onChange = () => {
          this.invalidateRender();
          this.scheduleCameraDependentAppearanceRefresh();
        };
        this.backendManager = null;
        this.backendSwitchToken = 0;
        this.pendingActiveBackendTransformSync = false;

        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        this.currentMesh = null;
        this.sceneItems = [];
        this.sceneItemSerial = 0;
        this.sceneLights = [];
        this.sceneLightSerial = 0;
        this.selectedSceneItemId = null;
        this.selectedLightId = null;
        this.baseLocalBounds = null;
        this.baseCenterBounds = null;
        this.bounds = null;
        this.boundsSphere = null;
        this.centerBounds = null;
        this.centerBoundsSphere = null;
        this.sceneBounds = null;
        this.sceneBoundsSphere = null;
        this.hoverPointer = null;
        this.lastHoverPointer = null;
        this.lastHoverHit = null;
        this.isColorPickMode = false;
        this.hoverProbePending = false;
        this.hoverReadout = "Hover -";
        this.pickedColors = [];
        this.pickedColorSerial = 0;
        this.alignPoints = { source: [], target: [] };
        this.alignPointContext = null;
        this.alignMarkers = [];
        this.alignPickMode = false;
        this.brushEnabled = false;
        this.brushStroke = null;
        this.lastBrushUndo = null;
        this.brushUndoStack = [];
        this.lastBrushPointer = null;
        this.lastBrushHit = null;
        this.brushOverlayGroup = null;
        this.brushRadiusRing = null;
        this.brushInfluenceRing = null;
        this.brushDepthFrontRing = null;
        this.brushDepthBackRing = null;
        this.brushInfluencePoints = null;
        this.lastAlignmentSnapshot = null;
        this.lightOccluderSamples = [];
        this.runtimeLightOccluders = [];
        this.runtimeOneBounceVpls = [];
        this.staticBakeController = new WebGpuStaticLightingBakeController();
        this.lightOcclusionController = new WebGpuLightOcclusionController();
        this.lightOcclusionSnapshot = null;
        window.addEventListener("pagehide", () => {
          void this.lightOcclusionController.dispose();
          void this.staticBakeController.dispose();
        });
        this.lightOcclusionEmptyTexture = createLightOcclusionTexture();
        this.lightOcclusionRevision = 0;
        this.lightOcclusionTimer = 0;
        this.lightOcclusionRunning = false;
        this.lightOcclusionStatusText = "";
        this.lightOcclusionBlockReason = "";
        this.staticBakeApplied = false;
        this.staticBakeApplying = false;
        this.staticBakeOriginalRgb = null;
        this.staticBakeRequest = 0;
        this.staticBakeResultSnapshot = null;
        this.staticBakeStatusText = "";
        this.staticBakeStartedAt = 0;
        this.staticBakeStaleReason = "";
        this.activeLightCount = 0;
        this.activeOccluderCount = 0;
        this.activeOneBounceVplCount = 0;
        this.lightHandles = {
          cameraPosition: dynoVec3(new THREE.Vector3(), "viewerLightCameraPosition"),
          colorB: [],
          colorG: [],
          colorR: [],
          intensities: [],
          types: [],
          directions: [],
          occluderOpacities: [],
          occluderPositions: [],
          occluderRadii: [],
          oneBounceFluxB: Array.from(
            { length: ONE_BOUNCE_VPL_LIMIT },
            (_, index) => dynoFloat(0, `viewerOneBounceVplFluxB${index}`),
          ),
          oneBounceFluxG: Array.from(
            { length: ONE_BOUNCE_VPL_LIMIT },
            (_, index) => dynoFloat(0, `viewerOneBounceVplFluxG${index}`),
          ),
          oneBounceFluxR: Array.from(
            { length: ONE_BOUNCE_VPL_LIMIT },
            (_, index) => dynoFloat(0, `viewerOneBounceVplFluxR${index}`),
          ),
          oneBounceNormals: Array.from(
            { length: ONE_BOUNCE_VPL_LIMIT },
            (_, index) => dynoVec3(new THREE.Vector3(0, 0, 1), `viewerOneBounceVplNormal${index}`),
          ),
          oneBouncePositions: Array.from(
            { length: ONE_BOUNCE_VPL_LIMIT },
            (_, index) => dynoVec3(new THREE.Vector3(), `viewerOneBounceVplPosition${index}`),
          ),
          oneBounceRadii: Array.from(
            { length: ONE_BOUNCE_VPL_LIMIT },
            (_, index) => dynoFloat(0, `viewerOneBounceVplRadius${index}`),
          ),
          positions: [],
        };
        this.gridHelper = null;
        this.axesHelper = null;
        this.axisLabelGroup = null;
        this.boundsHelper = null;
        this.currentGridScale = null;
        this.currentGridStep = null;
        this.baseMoveSpeed = 1;
        this.defaultPose = null;
        this.hasCapturedInitialPose = false;
        this.activeMode = "orbit";
        this.loadToken = 0;
        this.sceneLoadEpoch = 0;
        this.sceneLoadQueue = Promise.resolve();
        this.frameCounter = 0;
        this.lastFpsUpdate = performance.now();
        this.renderInvalidated = true;
        this.pendingForcedFrames = 0;
        this.animationLoopHandle = 0;
        this.scheduledRenderAt = 0;
        this.lastRenderFrameAt = 0;
        this.activeRenderUntil = 0;
        this.deferredPreviewHandle = 0;
        this.interactionFinalizeHandle = 0;
        this.sparkSceneDirty = false;
        this.sparkSceneUpdateQueued = false;
        this.sparkSceneUpdatePromise = null;
        this.pendingAnimationDelta = 0;
        this.pendingPreviewSparkUpdate = false;
        this.pendingActiveBackendAppearanceRefreshReason = null;
        this.cameraAppearanceRefreshHandle = 0;
        this.postLoadRefreshHandle = 0;
        this.stageResizeObserver = null;
        this.devicePixelRatioMedia = null;
        this.handleViewportResize = () => {
          this.syncUiScale();
          this.syncRendererPixelRatio();
          this.onResize();
        };
        this.handleDevicePixelRatioChange = () => {
          this.watchDevicePixelRatio();
          this.handleViewportResize();
        };
        this.preventExternalFileDrop = (event) => {
          const hasFiles = Array.from(event.dataTransfer?.types || []).includes("Files");
          if (hasFiles && !this.dom.stage.contains(event.target)) {
            event.preventDefault();
          }
        };
        this.idleRenderDelayMs = 160;
        this.depthRangeLimits = { min: 0.1, max: 100 };
        this.depthRangeIsAuto = true;
        this.pendingTransformRefresh = null;
        this.depthModifierHandles = {
          maxDepth: dynoFloat(DEPTH_RANGE_DEFAULT, "viewerNormalizeMax"),
        };
        this.positionModifierHandles = {
          minCorner: dynoVec3(new THREE.Vector3(), "viewerPositionMin"),
          scaleFactor: dynoFloat(1, "viewerPositionScale"),
          span: dynoVec3(new THREE.Vector3(1, 1, 1), "viewerPositionSpan"),
        };
        this.toneCurvePointerDrag = null;
        this.animationModifierHandles = {
          distanceScale: dynoFloat(1.4, "viewerAnimationDistanceScale"),
          epsilon: dynoFloat(0.0001, "viewerAnimationEpsilon"),
          epsilonVector: dynoVec3(new THREE.Vector3(0.0001, 0.0001, 0.0001), "viewerAnimationEpsilonVector"),
          opacityPower: dynoFloat(1.35, "viewerAnimationOpacityPower"),
          origin: dynoVec3(new THREE.Vector3(), "viewerAnimationOrigin"),
          scaleInfluence: dynoFloat(1.2, "viewerAnimationScaleInfluence"),
          speed: dynoFloat(1, "viewerAnimationSpeed"),
          strength: dynoFloat(1.8, "viewerAnimationStrength"),
          swirl: dynoFloat(0.18, "viewerAnimationSwirl"),
          time: dynoFloat(0, "viewerAnimationTime"),
          up: dynoVec3(new THREE.Vector3(0, 1, 0.35).normalize(), "viewerAnimationUp"),
        };
        this.activeAnimationModifier = null;
        this.activeAnimationScript = null;
        this.activeAnimationTargetItemId = null;
        this.animationEditorDirty = false;
        this.animationEditorDraft = "";
        const defaultAnimationState = createDefaultAnimationPlaybackState(null);
        this.baseObjectModifier = undefined;
        this.baseWorldModifier = undefined;
        this.loadedShDegree = 3;
        this.modelMeta = createDefaultModelMeta();
        this.state = {
          autoRotate: false,
          background: "graphite",
          ...DEFAULT_BRUSH_SETTINGS,
          depthRange: DEPTH_RANGE_DEFAULT,
          exportFalloff: true,
          exportOpacity: true,
          exportSh: true,
          exposure: 0,
          loadedLut: null,
          loadedLutName: "",
          toneCurve: buildToneCurveState(),
          timelineExpanded: false,
          falloff: 1,
          focalLength: DEFAULT_FOCAL_LENGTH,
          gridScaleMode: "auto",
          gridScaleValue: 1,
          inspectorTab: "scene",
          ...defaultAnimationState,
          lightHelperScale: DEFAULT_LIGHT_HELPER_SCALE,
          lightIntensity: 20,
          lightR: DEFAULT_LIGHT_COLOR.r,
          lightG: DEFAULT_LIGHT_COLOR.g,
          lightB: DEFAULT_LIGHT_COLOR.b,
          lightX: 0,
          lightY: 0,
          lightZ: 0,
          legacySampledShadow: false,
          lightOcclusionEnabled: false,
          moveSpeedFactor: 1,
          oneBouncePreview: false,
          staticBakeMode: STATIC_BAKE_MODE.DIRECT,
          staticBakeGenericPolicy: STATIC_BAKE_GENERIC_POLICY.PRESERVE,
          opacity: 1,
          positionRangeScale: 1,
          quality: "balanced",
          renderFps: 60,
          renderPixelRatio: 0,
          renderMode: "beauty",
          rotationX: 0,
          rotationY: 0,
          rotationZ: 0,
          scale: 1,
          translateX: 0,
          translateY: 0,
          translateZ: 0,
          selectedExposure: 0,
          shLevel: 3,
          sceneListLimit: 6,
          showAxes: true,
          showBounds: false,
          showGizmo: false,
          showGrid: true,
          transformGizmoMode: "translate",
        };
      }

      async init() {
        this.dom.stage.append(this.renderer.domElement);
        this.backendManager = new LookDevBackendManager({
          stage: this.dom.stage,
          inputCanvas: this.renderer.domElement,
          onFrameRequest: () => this.forceVisualRefresh(2),
          onStatus: (message) => this.updateStatus(message),
          onTelemetry: (telemetry) => this.syncBackendTelemetry(telemetry),
        });
        this.syncUiScale();
        this.sparkSettings = createRendererSettings("spark");
        this.rendererCommonQuality = document.getElementById("renderer-common-quality");
        this.bindUi();
        this.syncRendererSettingsUi();
        this.syncOpenFileAction();
        if (this.dom.sceneRenderSection && this.dom.sceneTransformSection) {
          this.dom.sceneRenderSection.parentElement?.insertBefore(
            this.dom.sceneTransformSection,
            this.dom.sceneRenderSection,
          );
        }
        this.applyBackground();
        this.applyQualityPreset(this.state.quality);
        this.applyOpacity(false);
        this.applyFalloff(false);
        this.applyExposure(false);
        this.applyToneCurve(false);
        this.syncLutUi();
        this.applyFocalLength(false, false);
        this.applyMoveSpeed(false);
        this.applyRenderFps(false);
        this.applyDepthRange(false);
        this.applyPositionRange(false);
        this.syncTransformInputs();
        this.syncToggleButtons();
        this.syncOneBouncePreviewUi();
        this.syncLegacySampledShadowUi();
        this.syncStaticBakeUi();
        this.applyRenderMode(false);
        this.updateModeUi();
        this.syncInspectorTabs();
        this.syncExportList();
        this.syncGridControls();
        this.syncSelectedLightControls(true);
        this.syncLightList();
        this.syncAnimationEditor();
        this.syncAnimationControls(true);
        this.syncTimelineToggle();
        this.syncAlignUi();
        this.createBrushOverlay();
        this.syncBrushUi(true);
        if (this.dom.colorspaceChip) {
          this.dom.colorspaceChip.textContent = "Display sRGB";
        }
        this.clearHoverReadout();
        this.renderPickedColors();
        this.syncColorPickButton();
        this.updateTransformGizmoButtons();
        this.updateMetaUi();
        this.onResize();
        this.startAnimationLoop();
        this.setProgress("Idle", 0);
        this.updateRenderChip("Idle");
        this.updateStatus("Viewer ready");
        this.orbitControls.addEventListener("change", () => {
          this.invalidateRender();
          this.scheduleCameraDependentAppearanceRefresh();
        });
        window.addEventListener("resize", this.handleViewportResize);
        window.visualViewport?.addEventListener("resize", this.handleViewportResize);
        this.watchDevicePixelRatio();
        document.addEventListener("dragover", this.preventExternalFileDrop);
        document.addEventListener("drop", this.preventExternalFileDrop);
        window.addEventListener("pointermove", (event) => this.updateToneCurvePointFromPointer(event));
        window.addEventListener("pointerup", () => this.stopToneCurvePointDrag());
        window.addEventListener("pointercancel", () => this.stopToneCurvePointDrag());
        if (typeof ResizeObserver === "function") {
          this.stageResizeObserver = new ResizeObserver(() => this.onResize());
          this.stageResizeObserver.observe(this.dom.stage);
        }
        this.renderer.domElement.addEventListener("dblclick", (event) => this.focusPick(event));
        this.renderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());
        this.renderer.domElement.addEventListener("pointerdown", (event) => {
          if (this.brushEnabled && event.button === 0) {
            event.preventDefault();
            event.stopPropagation();
            this.startBrushStroke(event);
            return;
          }
          if (this.alignPickMode && event.button === 0) {
            event.preventDefault();
            event.stopPropagation();
            this.pickAlignPoint(event);
            return;
          }
          if (this.isColorPickMode && event.button === 0) {
            event.preventDefault();
            event.stopPropagation();
            const rect = this.renderer.domElement.getBoundingClientRect();
            this.hoverPointer = {
              x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
              y: -(((event.clientY - rect.top) / rect.height) * 2 - 1),
            };
            this.lastHoverPointer = { ...this.hoverPointer };
            this.pickHoveredColor({ fromPointerClick: true });
            return;
          }
          this.commitActiveField();
        }, true);
        this.renderer.domElement.addEventListener("pointermove", (event) => {
          if (this.brushEnabled) {
            this.updateBrushOverlayFromEvent(event);
          }
          if (this.brushStroke) {
            this.continueBrushStroke(event);
          }
          this.queueHoverProbe(event);
        });
        window.addEventListener("pointerup", () => this.endBrushStroke());
        window.addEventListener("pointercancel", () => this.endBrushStroke());
        this.renderer.domElement.addEventListener("pointerleave", () => this.handleViewportPointerLeave());
        this.renderer.domElement.addEventListener("wheel", (event) => this.handleStageWheel(event), { passive: false });
        this.invalidateRender();

        if (this.isFileProtocol) {
          this.prepareFileProtocolMode();
          return;
        }

        this.dom.progressLabel.textContent = "Open a local file or drag one into the viewer.";
        this.updateRenderChip("Ready");
        this.updateStatus("Ready");
      }

      bindUi() {
        const pixelRatioInput = document.getElementById("render-pixel-ratio-input");
        pixelRatioInput?.addEventListener("change", () => {
          const value = Number(pixelRatioInput.value);
          if (!pixelRatioInput.value.trim() || !Number.isFinite(value) || (value !== 0 && (value < 0.25 || value > 4))) {
            pixelRatioInput.setCustomValidity("Use 0 for Auto, or a pixel ratio from 0.25 to 4.");
            pixelRatioInput.reportValidity();
            pixelRatioInput.value = String(this.state.renderPixelRatio);
            return;
          }
          pixelRatioInput.setCustomValidity("");
          this.state.renderPixelRatio = value;
          this.syncRendererPixelRatio();
          this.onResize();
          this.forceVisualRefresh(3);
        });
        pixelRatioInput?.addEventListener("input", () => pixelRatioInput.setCustomValidity(""));
        document.getElementById("reset-shared-quality")?.addEventListener("click", () => {
          this.state.renderPixelRatio = 0;
          pixelRatioInput.value = "0";
          pixelRatioInput.setCustomValidity("");
          this.state.renderFps = 60;
          this.applyRenderFps(false);
          this.applyQualityPreset("balanced");
          if (this.backendManager.isSparkActive() && this.getSelectedItem()) {
            this.markStaticBakeStale("SH level reset");
            this.state.shLevel = 3;
            this.applyShLevel();
            this.syncSelectedSplatControls(true);
          }
          this.forceVisualRefresh(3);
        });
        this.dom.backendSelect?.addEventListener("change", (event) => this.setRendererBackend(event.target.value));
        this.dom.backgroundSelect.addEventListener("change", (event) => {
          this.state.background = event.target.value;
          this.applyBackground();
        });

        this.bindNumberPair({
          input: this.dom.opacityInput,
          range: this.dom.opacityRange,
          limits: OPACITY_LIMITS,
          onChange: (value, options) => this.setOpacity(value, options),
        });
        this.bindNumberPair({
          input: this.dom.falloffInput,
          range: this.dom.falloffRange,
          limits: FALLOFF_LIMITS,
          onChange: (value, options) => this.setFalloff(value, options),
        });
        this.dom.focalLengthRange.addEventListener("input", (event) => {
          this.setFocalLength(
            sliderToFocalLength(event.target.value),
            true,
            { commit: true, syncInput: true },
          );
        });
        this.bindNumberPair({
          input: this.dom.focalLengthInput,
          range: null,
          limits: FOCAL_LENGTH_LIMITS,
          onChange: (value, options) => this.setFocalLength(value, true, options),
        });
        this.bindNumberPair({
          input: this.dom.moveSpeedInput,
          range: this.dom.moveSpeedRange,
          limits: MOVE_SPEED_LIMITS,
          onChange: (value, options) => this.setMoveSpeedFactor(value, options),
        });
        this.bindNumberPair({
          input: this.dom.renderFpsInput,
          range: null,
          limits: RENDER_FPS_LIMITS,
          onChange: (value, options) => this.setRenderFps(value, options),
        });
        this.bindNumberPair({
          input: this.dom.exposureInput,
          range: this.dom.exposureRange,
          limits: EXPOSURE_LIMITS,
          onChange: (value, options) => this.setExposure(value, options),
        });
        this.dom.toneCurveChannelSelect?.addEventListener("change", (event) => {
          this.state.toneCurve = setToneCurveActiveChannel(this.state.toneCurve, event.target.value);
          this.syncToneCurveUi();
        });
        this.dom.toneCurveGraph?.addEventListener("pointerdown", (event) => this.handleToneCurveGraphPointerDown(event));
        this.dom.toneCurveGraph?.addEventListener("contextmenu", (event) => this.handleToneCurveGraphContextMenu(event));
        this.dom.toneCurveAddPointButton?.addEventListener("click", () => {
          this.state.toneCurve = insertToneCurvePoint(this.state.toneCurve);
          this.applyToneCurve(true, true);
        });
        this.dom.toneCurveRemovePointButton?.addEventListener("click", () => {
          this.state.toneCurve = removeToneCurvePoint(this.state.toneCurve);
          this.applyToneCurve(true, true);
        });
        this.bindNumberPair({
          input: this.dom.toneCurvePointXInput,
          range: null,
          limits: TONE_CURVE_POINT_LIMITS,
          onChange: (value, options) => this.setSelectedToneCurvePointValue("x", value, options),
        });
        this.bindNumberPair({
          input: this.dom.toneCurvePointYInput,
          range: null,
          limits: TONE_CURVE_POINT_LIMITS,
          onChange: (value, options) => this.setSelectedToneCurvePointValue("y", value, options),
        });
        this.bindNumberPair({
          input: this.dom.selectedExposureInput,
          range: this.dom.selectedExposureRange,
          limits: EXPOSURE_LIMITS,
          onChange: (value, options) => this.setSelectedExposure(value, options),
        });
        this.dom.pickColorButton?.addEventListener("click", () => {
          if (this.isColorPickMode) {
            this.stopColorPickMode();
            this.updateStatus("Color picker canceled");
            return;
          }
          this.startColorPickMode();
        });
        this.dom.lutOpenButton?.addEventListener("click", () => this.dom.lutFileInput?.click());
        this.dom.lutFileInput?.addEventListener("change", (event) => this.loadLutFile(event.target.files?.[0]));
        this.dom.lutApplySelectedButton?.addEventListener("click", () => this.applyLoadedLutToSelectedSplat());
        this.dom.lutInputColorSpaceSelect?.addEventListener("change", () => this.syncLutUi());
        this.dom.lutOutputColorSpaceSelect?.addEventListener("change", () => this.syncLutUi());
        this.dom.clearPickedColorsButton?.addEventListener("click", () => {
          this.clearPickedColors();
        });
        this.dom.alignSourceSelect?.addEventListener("change", () => this.syncAlignUi());
        this.dom.alignTargetSelect?.addEventListener("change", () => this.syncAlignUi());
        this.dom.alignRoleSelect?.addEventListener("change", () => this.syncAlignUi());
        this.dom.alignAddPointButton?.addEventListener("click", () => this.startAlignPointPick());
        this.dom.alignClearPointsButton?.addEventListener("click", () => this.clearAlignPoints());
        this.dom.alignApplyButton?.addEventListener("click", () => this.applyAlignment());
        this.dom.alignResetButton?.addEventListener("click", () => this.resetAlignment());
        this.dom.brushToggleButton?.addEventListener("click", () => this.toggleBrushEditing());
        this.dom.brushUndoButton?.addEventListener("click", () => this.undoLastBrushStroke());
        this.dom.brushResetButton?.addEventListener("click", () => this.resetBrushSettings());
        this.dom.brushModeSelect?.addEventListener("change", (event) => {
          this.state.brushMode = ["move", "standard", "scale"].includes(event.target.value) ? event.target.value : "move";
          this.syncBrushUi(false);
        });
        this.dom.brushRelativeCheckbox?.addEventListener("change", () => {
          this.state.brushRelativeToSplatSize = Boolean(this.dom.brushRelativeCheckbox.checked);
          this.syncBrushUi(false);
          this.invalidateRender();
        });
        this.bindNumberPair({
          input: this.dom.brushRadiusInput,
          range: this.dom.brushRadiusRange,
          limits: BRUSH_RADIUS_LIMITS,
          onChange: (value, options) => this.setBrushRadius(value, options),
        });
        this.bindNumberPair({
          input: this.dom.brushStrengthInput,
          range: this.dom.brushStrengthRange,
          limits: BRUSH_STRENGTH_LIMITS,
          onChange: (value, options) => this.setBrushStrength(value, options),
        });
        this.bindNumberPair({
          input: this.dom.brushScaleInput,
          range: this.dom.brushScaleRange,
          limits: BRUSH_SCALE_LIMITS,
          onChange: (value, options) => this.setBrushScale(value, options),
        });
        this.bindNumberPair({
          input: this.dom.brushDepthInput,
          range: this.dom.brushDepthRange,
          limits: BRUSH_DEPTH_LIMITS,
          onChange: (value, options) => this.setBrushDepthLimit(value, options),
        });
        this.bindNumberPair({
          input: this.dom.brushUndoLimitInput,
          range: this.dom.brushUndoLimitRange,
          limits: BRUSH_UNDO_LIMITS,
          onChange: (value, options) => this.setBrushUndoLimit(value, options),
        });
        this.dom.addPointLightButton?.addEventListener("click", () => {
          this.addPointLight();
        });
        this.dom.lightOcclusionCheckbox?.addEventListener("change", () => {
          this.setLightOcclusionEnabled(this.dom.lightOcclusionCheckbox.checked);
        });
        this.dom.lightOcclusionUpdateButton?.addEventListener("click", () => this.invalidateLightOcclusion("Update requested", { delay: 0 }));
        this.dom.lightOcclusionCancelButton?.addEventListener("click", () => {
          this.invalidateLightOcclusion("Canceled; added light is unshadowed", { schedule: false });
        });
        this.dom.oneBouncePreviewCheckbox?.addEventListener("change", () => {
          this.setOneBouncePreview(this.dom.oneBouncePreviewCheckbox.checked);
        });
        this.dom.legacySampledShadowCheckbox?.addEventListener("change", () => {
          this.setLegacySampledShadow(this.dom.legacySampledShadowCheckbox.checked);
        });
        this.dom.staticBakeGenericPolicy?.addEventListener("change", () => {
          this.state.staticBakeGenericPolicy = this.dom.staticBakeGenericPolicy.value;
          this.syncStaticBakeUi();
        });
        this.dom.staticBakeMode?.addEventListener("change", () => {
          this.state.staticBakeMode = this.dom.staticBakeMode.value;
          if (this.state.staticBakeMode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE) {
            this.state.staticBakeGenericPolicy = STATIC_BAKE_GENERIC_POLICY.PRESERVE;
            this.disableLegacyLightingForAuthoredBounce();
          }
          this.syncStaticBakeUi();
        });
        this.dom.staticBakeButton?.addEventListener("click", () => this.startStaticBake());
        this.dom.staticBakeCancelButton?.addEventListener("click", () => this.cancelStaticBake());
        this.dom.staticBakeClearButton?.addEventListener("click", () => this.clearStaticBake());
        this.bindNumberPair({
          input: this.dom.depthRangeInput,
          range: this.dom.depthRangeRange,
          limits: () => this.getActiveNormalizeLimits(),
          onChange: (value, options) => this.setNormalizeValue(value, options),
        });

        this.dom.fileInput.addEventListener("change", async (event) => {
          await this.loadFromFiles(event.target.files);
          event.target.value = "";
        });

        this.dom.fitViewButton.addEventListener("click", () => this.fitView({ preserveDirection: true }));
        this.dom.addPrimitiveButton.addEventListener("click", async () => {
          await this.loadPrimitive(this.dom.primitiveSelect.value || "sphere");
        });
        this.dom.clearSceneButton.addEventListener("click", () => {
          if (this.confirmClearScene()) {
            this.clearLoadedSplat();
          }
        });
        this.dom.saveSceneSplatsButton?.addEventListener("click", async () => {
          try {
            await this.saveVisibleSceneSplats();
          } catch (error) {
            this.updateStatus(error instanceof Error ? error.message : "Save failed");
          }
        });
        this.dom.exportEnableAllButton?.addEventListener("click", () => this.setAllExportEnabled(true));
        this.dom.exportDisableAllButton?.addEventListener("click", () => this.setAllExportEnabled(false));
        [
          [this.dom.exportOpacityCheckbox, "exportOpacity"],
          [this.dom.exportFalloffCheckbox, "exportFalloff"],
          [this.dom.exportShCheckbox, "exportSh"],
        ].forEach(([checkbox, stateKey]) => {
          checkbox?.addEventListener("change", () => {
            this.state[stateKey] = Boolean(checkbox.checked);
          });
        });

        this.dom.modeButtons.forEach((button) => {
          button.addEventListener("click", () => this.setMode(button.dataset.mode || "orbit"));
        });
        this.dom.inspectorTabButtons.forEach((button) => {
          button.addEventListener("click", () => this.setInspectorTab(button.dataset.inspectorTab || "scene"));
          button.addEventListener("keydown", (event) => this.handleInspectorTabKeydown(event));
        });
        this.dom.animationLoopCheckbox?.addEventListener("change", () => {
          this.state.animationLoop = Boolean(this.dom.animationLoopCheckbox.checked);
          if (this.activeAnimationScript) {
            this.activeAnimationScript.loop = this.state.animationLoop;
            this.syncAnimationEditor();
          }
        });
        this.dom.animationOriginModeSelect?.addEventListener("change", () => this.setAnimationOriginMode(this.dom.animationOriginModeSelect.value));
        this.bindNumberPair({
          input: this.dom.animationOriginXInput,
          range: null,
          limits: TRANSLATE_LIMITS,
          onChange: (value) => this.setAnimationOriginAxis("x", value),
        });
        this.bindNumberPair({
          input: this.dom.animationOriginYInput,
          range: null,
          limits: TRANSLATE_LIMITS,
          onChange: (value) => this.setAnimationOriginAxis("y", value),
        });
        this.bindNumberPair({
          input: this.dom.animationOriginZInput,
          range: null,
          limits: TRANSLATE_LIMITS,
          onChange: (value) => this.setAnimationOriginAxis("z", value),
        });
        this.dom.animationLoadPresetButton?.addEventListener("click", () => this.loadAnimationPreset(this.dom.animationPresetSelect?.value || "explosion"));
        this.dom.animationCopyDefaultButton?.addEventListener("click", () => this.clearAnimationScript(true));
        this.dom.animationScriptEditor?.addEventListener("input", () => {
          this.animationEditorDirty = true;
          this.animationEditorDraft = this.dom.animationScriptEditor.value;
          this.syncAnimationScriptStatus();
        });
        this.dom.animationApplyButton?.addEventListener("click", () => this.applyAnimationScript(true));
        this.dom.animationPlayButton?.addEventListener("click", () => this.playAnimation());
        this.dom.animationPauseButton?.addEventListener("click", () => this.pauseAnimation());
        this.dom.animationResetButton?.addEventListener("click", () => this.resetAnimation());
        this.dom.animationOpenButton?.addEventListener("click", () => this.dom.animationFileInput?.click());
        this.dom.animationSaveButton?.addEventListener("click", () => this.saveAnimationScript());
        this.dom.animationFileInput?.addEventListener("change", async (event) => {
          const [file] = Array.from(event.target.files || []);
          if (!file) {
            return;
          }
          await this.loadAnimationScriptFile(file);
          event.target.value = "";
        });
        this.dom.animationTimeRange?.addEventListener("input", () => this.setAnimationTimeFromUi(false));
        this.dom.animationTimeRange?.addEventListener("change", () => this.setAnimationTimeFromUi(true));
        this.dom.timelineToggleButton?.addEventListener("click", () => this.setTimelineExpanded(!this.state.timelineExpanded));
        this.bindNumberPair({
          input: this.dom.sceneLimitInput,
          range: this.dom.sceneLimitRange,
          limits: { min: 3, max: 14 },
          onChange: (value, options) => this.setSceneListLimit(value, options),
        });
        this.bindNumberPair({
          input: this.dom.sceneSelectInput,
          range: this.dom.sceneSelectRange,
          limits: () => ({ min: 1, max: Math.max(this.sceneItems.length, 1) }),
          onChange: (value, options) => this.setSceneSelectionIndex(value, options),
        });
        this.bindNumberPair({
          input: this.dom.lightHelperScaleInput,
          range: this.dom.lightHelperScaleRange,
          limits: LIGHT_HELPER_SCALE_LIMITS,
          onChange: (value, options) => this.setSelectedLightHelperScale(value, options),
        });
        this.bindNumberPair({
          input: this.dom.lightIntensityInput,
          range: this.dom.lightIntensityRange,
          limits: LIGHT_INTENSITY_LIMITS,
          onChange: (value, options) => this.setSelectedLightIntensity(value, options),
        });
        this.dom.gridScaleSelect?.addEventListener("change", (event) => {
          this.setGridScaleMode(event.target.value);
        });
        this.bindNumberPair({
          input: this.dom.gridScaleInput,
          range: null,
          limits: { min: 0.01, max: 100000 },
          onChange: (value, options) => this.setGridScaleValue(value, options),
        });

        this.dom.openFileTriggers.forEach((button) => {
          button.addEventListener("click", () => this.dom.fileInput.click());
        });
        this.dom.renderModeSelect.addEventListener("change", (event) => {
          this.setRenderMode(event.target.value);
          this.dom.renderModeSelect.blur();
        });
        this.dom.renderModeSelect.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });

        this.dom.qualitySelect.addEventListener("change", (event) => {
          this.applyQualityPreset(event.target.value);
        });

        this.dom.resetViewButton.addEventListener("click", () => this.resetView());
        this.dom.toggleGizmoButton.addEventListener("click", () => this.toggleTransformGizmo());
        this.dom.lightGizmoButton?.addEventListener("click", () => this.toggleTransformGizmo());
        this.dom.gizmoTranslateButton.addEventListener("click", () => this.setTransformGizmoMode("translate"));
        this.dom.gizmoRotateButton.addEventListener("click", () => this.setTransformGizmoMode("rotate"));
        this.dom.gizmoScaleButton.addEventListener("click", () => this.setTransformGizmoMode("scale"));
        this.dom.shSelect.addEventListener("change", (event) => {
          this.markStaticBakeStale("SH level changed");
          this.state.shLevel = Number(event.target.value);
          this.applyShLevel();
          this.updateRenderChip("SH level updated");
        });

        this.dom.toggleAutorotateButton.addEventListener("click", () => {
          this.state.autoRotate = !this.state.autoRotate;
          this.orbitControls.autoRotate = this.state.autoRotate;
          this.syncToggleButtons();
        });
        this.dom.toggleAxesButton.addEventListener("click", () => this.toggleHelper("showAxes"));
        this.dom.toggleBoundsButton.addEventListener("click", () => this.toggleHelper("showBounds"));
        this.dom.toggleGridButton.addEventListener("click", () => this.toggleHelper("showGrid"));

        this.dom.resetRotationButton.addEventListener("click", () => this.resetTransform());
        this.bindCommitInputs([
          this.dom.lightRInput,
          this.dom.lightGInput,
          this.dom.lightBInput,
        ], (commit) => this.applySelectedLightColor(commit));
        this.bindCommitInputs([
          this.dom.lightXInput,
          this.dom.lightYInput,
          this.dom.lightZInput,
        ], (commit) => this.applySelectedLightPosition(commit));
        this.bindCommitInputs([
          this.dom.lightRxInput, this.dom.lightRyInput, this.dom.lightRzInput,
          this.dom.lightWidthInput, this.dom.lightHeightInput,
        ], (commit) => this.applySelectedLightShape(commit));
        this.bindCommitInputs([
          this.dom.rotationXInput,
          this.dom.rotationYInput,
          this.dom.rotationZInput,
          this.dom.scaleInput,
          this.dom.translateXInput,
          this.dom.translateYInput,
          this.dom.translateZInput,
        ], (commit) => this.applyTransformFromInputs(commit, commit));

        this.dom.stage.addEventListener("dragenter", (event) => this.onDrag(event));
        this.dom.stage.addEventListener("dragover", (event) => this.onDrag(event));
        this.dom.stage.addEventListener("dragleave", (event) => this.onDragLeave(event));
        this.dom.stage.addEventListener("drop", async (event) => this.onDrop(event));

        this.transformControls.addEventListener("dragging-changed", (event) => {
          this.orbitControls.enabled = this.activeMode === "orbit" && !event.value;
          this.firstPerson.setPointerEnabled(this.activeMode === "fps" && !event.value);
          this.firstPerson.setMovementEnabled(!event.value);
          if (event.value) {
            this.startDeferredInteraction();
          } else {
            this.finishDeferredInteraction();
            this.refreshActiveBackendSnapshot("Gizmo transform committed");
          }
        });
        this.transformControls.addEventListener("change", () => {
          if (!this.state.showGizmo) {
            return;
          }
          this.startDeferredInteraction();
        });
        this.transformControls.addEventListener("objectChange", () => {
          if (!this.state.showGizmo) {
            return;
          }
          this.applyTransformFromGizmo();
          this.startDeferredInteraction();
        });
      }

      syncUiScale() {
        const viewport = window.visualViewport;
        const viewportWidth = viewport?.width ?? window.innerWidth;
        const viewportHeight = viewport?.height ?? window.innerHeight;
        const layoutMode = computeLayoutMode({ viewportWidth });
        const shellSize = computeShellSize({ viewportHeight, viewportWidth });
        const compensation = computeUiScale({
          viewportHeight,
          viewportWidth,
        });
        const panelWidths = computePanelWidths({ layoutMode, uiScale: compensation, viewportWidth });
        document.documentElement.style.setProperty("--ui-scale", compensation.toFixed(4));
        document.documentElement.style.setProperty("--shell-width", `${shellSize.width}px`);
        document.documentElement.style.setProperty("--shell-height", `${shellSize.height}px`);
        document.documentElement.style.setProperty("--panel-left-width", `${panelWidths.left}px`);
        document.documentElement.style.setProperty("--panel-right-width", `${panelWidths.right}px`);
        document.body.dataset.layout = layoutMode;
      }

      syncRendererPixelRatio() {
        const preset = QUALITY[this.state.quality] || QUALITY.balanced;
        const automatic = Math.min(window.devicePixelRatio || 1, preset.maxPixelRatio);
        this.renderer.setPixelRatio(this.state.renderPixelRatio > 0 ? this.state.renderPixelRatio : automatic);
      }

      watchDevicePixelRatio() {
        const previousMedia = this.devicePixelRatioMedia;
        if (previousMedia) {
          if (typeof previousMedia.removeEventListener === "function") {
            previousMedia.removeEventListener("change", this.handleDevicePixelRatioChange);
          } else {
            previousMedia.removeListener?.(this.handleDevicePixelRatioChange);
          }
        }
        this.devicePixelRatioMedia = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) || null;
        if (this.devicePixelRatioMedia) {
          if (typeof this.devicePixelRatioMedia.addEventListener === "function") {
            this.devicePixelRatioMedia.addEventListener("change", this.handleDevicePixelRatioChange);
          } else {
            this.devicePixelRatioMedia.addListener?.(this.handleDevicePixelRatioChange);
          }
        }
      }

      syncBackendTelemetry({ id }) {
        if (this.dom.backendSelect && this.dom.backendSelect.value !== id) {
          this.dom.backendSelect.value = id;
        }
        if (this.sparkSettings) this.syncRendererSettingsUi();
      }

      syncRendererSettingsUi() {
        const container = document.getElementById("renderer-settings-fields");
        if (!container || !this.backendManager || !this.sparkSettings) return;
        const id = this.backendManager.activeId;
        const backend = this.backendManager.activeBackend;
        const values = id === "spark" ? this.sparkSettings : backend.settings;
        if (id === "spark") {
          for (const key of Object.keys(values)) values[key] = this.spark[key];
        }
        renderRendererSettings(container, id, values, (key, value) => {
          values[key] = value;
          if (id === "spark") {
            if (key === "falloff") this.setFalloff(value);
            else this.spark[key] = value;
            this.spark.dirty = true;
            this.queueSparkSceneUpdate();
          } else backend.applySettings();
          this.forceVisualRefresh(3);
        }, () => {
          Object.assign(values, createRendererSettings(id));
          if (id === "spark") {
            Object.assign(this.spark, values);
            this.setFalloff(values.falloff);
            this.spark.dirty = true;
            this.queueSparkSceneUpdate();
          } else backend.applySettings();
          this.syncRendererSettingsUi();
          this.forceVisualRefresh(3);
        });
        const shared = container.querySelector("#renderer-shared-quality");
        if (shared && this.rendererCommonQuality) shared.append(this.rendererCommonQuality);
        this.dom.shSelect.disabled = id !== "spark" || !this.getSelectedItem();
      }

      getGpuAppearanceStates() {
        return this.sceneItems.filter(item => item.visible && item.mesh?.visible !== false && item.mesh).map(item => {
          const beauty = this.getRenderModeForItem(item) === "beauty";
          return { id: item.id, exposure: beauty ? this.getBeautyExposureScaleForItem(item) : 1,
            faceForward: !item.hasAuthoredSplatNormals,
            lights: beauty && !this.staticBakeApplied ? this.getLightSamples() : [],
            legacy: beauty && !this.staticBakeApplied && this.state.legacySampledShadow,
            bounce: beauty && !this.staticBakeApplied && this.state.oneBouncePreview,
            toneCurve: item.settings?.toneCurve ?? buildToneCurveState(),
            visibility: item.lightOcclusion?.enabled.value ? item.lightOcclusion : null,
          };
        });
      }

      captureRendererSnapshot({ gpuAppearance = Boolean(this.backendManager?.activeBackend?.supportsGpuAppearance) } = {}) {
        this.syncVisibleSceneItemTransforms();
        const states = this.getGpuAppearanceStates();
        const useGpu = gpuAppearance && states.every(appearanceSupported);
        const normals = new Map();
        // Camera position is shared by every splat in this CPU snapshot. Cache
        // it once to avoid two world-matrix reads and allocations per sample.
        const appearanceContext = {
          cameraPosition: this.camera.getWorldPosition(new THREE.Vector3()),
        };
        const snapshot = createSceneSnapshot(this.sceneItems, {
          mapLinearRgb: ({ index, linearRgb, sceneItem, splatCenter, splatQuaternion, splatScale }) => {
            const sample = {
              baseLinearRgb: linearRgb,
              localNormal: this.getSplatLocalNormal({
                quaternion: splatQuaternion,
                scales: splatScale,
              }),
              localPosition: new THREE.Vector3(
                Number(splatCenter?.x ?? splatCenter?.[0] ?? 0) || 0,
                Number(splatCenter?.y ?? splatCenter?.[1] ?? 0) || 0,
                Number(splatCenter?.z ?? splatCenter?.[2] ?? 0) || 0,
              ),
              splatIndex: index,
            };
            if (!useGpu) return this.getDisplayLinearColorForSample(sceneItem, sample, appearanceContext);
            let values = normals.get(sceneItem.id);
            if (!values) { values = new Float32Array(this.getPackedSplatCount(sceneItem) * 3); normals.set(sceneItem.id, values); }
            const normal = this.getSampleWorldNormal(sceneItem, sample);
            if (normal) values.set([normal.x, normal.y, normal.z], index * 3);
            return linearRgb;
          },
          visibleOnly: true,
        });
        snapshot.items.forEach(item => {
          item.appearance = useGpu ? states.find(state => state.id === item.id) : null;
          item.appearanceNormals = useGpu ? normals.get(item.id) : null;
        });
        return snapshot;
      }

      refreshActiveBackendSnapshot(reason = "scene updated", { force = false, syncActive = true, appearanceOnly = false } = {}) {
        if (!this.backendManager) {
          return;
        }
        if (!force && this.backendManager.isSparkActive()) return;
        try {
          if (appearanceOnly && syncActive && this.backendManager.activeBackend?.setAppearance?.(this.getGpuAppearanceStates())) {
            this.forceVisualRefresh(2);
            return;
          }
          this.backendManager.setSnapshot(this.captureRendererSnapshot(), { syncActive });
          this.pendingActiveBackendTransformSync = false;
          // PlayCanvas reconciles unified GSplat placement changes during its
          // first render pass. Keep a second invalidated frame so the newly
          // uploaded appearance, rather than the retired placement, is shown.
          if (syncActive) this.forceVisualRefresh(2);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Renderer snapshot failed";
          this.updateStatus(`${reason}: ${message}`);
          this.updateRenderChip("Backend error");
        }
      }

      requestActiveBackendAppearanceRefresh(reason, { immediate = false } = {}) {
        if (!this.backendManager || this.backendManager.isSparkActive()) return;
        if (immediate) {
          this.pendingActiveBackendAppearanceRefreshReason = null;
          this.refreshActiveBackendSnapshot(reason, { appearanceOnly: true });
          return;
        }
        this.pendingActiveBackendAppearanceRefreshReason = reason;
      }

      flushActiveBackendAppearanceRefresh() {
        const reason = this.pendingActiveBackendAppearanceRefreshReason;
        if (!reason) return;
        this.pendingActiveBackendAppearanceRefreshReason = null;
        this.refreshActiveBackendSnapshot(reason, { appearanceOnly: true });
      }

      hasCameraDependentAlternateAppearance() {
        return Boolean(
          this.backendManager
          && !this.backendManager.isSparkActive()
          && !this.staticBakeApplied
          && this.sceneLights.some((light) => light.visible)
          && this.sceneItems.some((item) => (
            item.visible
            && this.getRenderModeForItem(item) === "beauty"
            && !item.hasAuthoredSplatNormals
          )),
        );
      }

      scheduleCameraDependentAppearanceRefresh() {
        if (this.backendManager?.activeBackend?.gpuAppearanceActive) return;
        if (!this.hasCameraDependentAlternateAppearance()) {
          if (this.cameraAppearanceRefreshHandle) {
            window.clearTimeout(this.cameraAppearanceRefreshHandle);
            this.cameraAppearanceRefreshHandle = 0;
          }
          return;
        }
        if (this.cameraAppearanceRefreshHandle) {
          window.clearTimeout(this.cameraAppearanceRefreshHandle);
        }
        // Covariance-derived normals face the camera. Keep navigation smooth,
        // then rebake once after the view settles so alternate lighting cannot
        // remain captured from an old side of the surface.
        this.cameraAppearanceRefreshHandle = window.setTimeout(() => {
          this.cameraAppearanceRefreshHandle = 0;
          if (this.hasCameraDependentAlternateAppearance()) {
            this.refreshActiveBackendSnapshot("Camera-dependent lighting updated");
          }
        }, 140);
      }

      syncActiveBackendItemTransforms() {
        if (!this.backendManager || this.backendManager.isSparkActive()) return;
        this.pendingActiveBackendTransformSync = true;
        this.invalidateRender();
      }

      flushActiveBackendItemTransforms() {
        if (!this.pendingActiveBackendTransformSync || !this.backendManager || this.backendManager.isSparkActive()) return;
        this.pendingActiveBackendTransformSync = false;
        this.syncVisibleSceneItemTransforms();
        this.backendManager.syncItemTransforms(this.sceneItems.map((item) => ({
          id: item.id,
          worldMatrix: Array.from(item.mesh.matrixWorld.elements),
        })));
      }

      async setRendererBackend(id) {
        if (!this.backendManager) {
          return;
        }
        const request = ++this.backendSwitchToken;
        if (this.dom.backendSelect) this.dom.backendSelect.disabled = true;
        try {
          const activated = await this.backendManager.setActive(id, {
            getSnapshot: (options) => this.captureRendererSnapshot(options),
          });
          if (request !== this.backendSwitchToken || !activated) return;
          this.pendingActiveBackendAppearanceRefreshReason = null;
          this.pendingActiveBackendTransformSync = false;
          if (!this.backendManager.isSparkActive()) this.alignPickMode = false;
          if (!this.isSparkAnimationAvailable()) {
            this.pauseAnimation({ announce: false, allowUnsupported: true });
          }
          this.syncTransformGizmo();
          this.updateTransformGizmoButtons();
          this.syncAlignUi();
          this.syncBrushUi(false);
          this.syncAnimationEditor();
          this.syncAnimationControls(true);
          this.syncStaticBakeUi();
          this.forceVisualRefresh(2);
        } catch (error) {
          if (request !== this.backendSwitchToken) return;
          const message = error instanceof Error ? error.message : "Renderer backend failed";
          this.updateStatus(`${message}; renderer was not changed`);
          this.updateRenderChip("Backend error");
          this.syncBackendTelemetry({
            id: this.backendManager.activeId,
            label: this.backendManager.activeId,
            splatCount: this.backendManager.snapshot.splatCount,
            text: "Active renderer retained after error",
          });
        } finally {
          if (request === this.backendSwitchToken && this.dom.backendSelect) {
            this.dom.backendSelect.disabled = false;
            this.dom.backendSelect.value = this.backendManager.activeId;
          }
        }
      }

      renderActiveBackendFrame() {
        if (!this.backendManager || this.backendManager.isSparkActive()) {
          return;
        }
        this.flushActiveBackendItemTransforms();
        const width = this.dom.stage.clientWidth;
        const height = this.dom.stage.clientHeight;
        if (!width || !height) {
          return;
        }
        try {
          this.backendManager.renderFrame({
            camera: this.camera,
            background: BACKGROUNDS[this.state.background] || BACKGROUNDS.graphite,
            helpers: {
              axesLength: Math.max((this.currentGridScale || 1) * 0.5, 0.5),
              bounds: this.sceneBounds ? {
                min: this.sceneBounds.min.toArray(),
                max: this.sceneBounds.max.toArray(),
              } : null,
              gridSize: this.currentGridScale || 1,
              gridStep: this.currentGridStep || 0.1,
              showAxes: this.state.showAxes,
              showBounds: this.state.showBounds,
              showGrid: this.state.showGrid,
            },
            width,
            height,
            pixelRatio: this.renderer.getPixelRatio(),
          });
          this.renderTransformOverlay(true);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Renderer frame failed";
          this.updateStatus(`${this.backendManager.activeId} renderer error: ${message}`);
          this.updateRenderChip("Backend error");
        }
      }

      startAnimationLoop() {
        if (this.animationLoopHandle) {
          return;
        }
        const tick = () => {
          this.animationLoopHandle = 0;
          if (this.renderLoop()) this.animationLoopHandle = window.requestAnimationFrame(tick);
        };
        this.animationLoopHandle = window.requestAnimationFrame(tick);
      }

      markRenderActivity(durationMs = 1400) {
        this.activeRenderUntil = Math.max(
          this.activeRenderUntil,
          performance.now() + Math.max(0, durationMs),
        );
        this.scheduleRender(this.getRenderFrameDelay());
      }

      queueSparkSceneUpdate() {
        if (!this.spark || !this.scene || !this.camera) {
          return Promise.resolve();
        }
        this.sparkSceneDirty = true;
        if (this.sparkSceneUpdatePromise) {
          this.sparkSceneUpdateQueued = true;
          return this.sparkSceneUpdatePromise;
        }
        const runUpdate = async () => {
          while (this.sparkSceneDirty || this.sparkSceneUpdateQueued) {
            this.sparkSceneDirty = false;
            this.sparkSceneUpdateQueued = false;
            this.syncLightingRuntimeState();
            await this.spark.update({
              scene: this.scene,
              camera: this.camera,
            });
            this.pendingForcedFrames = Math.max(this.pendingForcedFrames, 1);
            this.renderInvalidated = true;
            this.scheduleRender(0);
          }
        };
        this.sparkSceneUpdatePromise = runUpdate()
          .catch((error) => {
            console.error("Spark scene update failed", error);
          })
          .finally(() => {
            this.sparkSceneUpdatePromise = null;
            if (this.sparkSceneDirty || this.sparkSceneUpdateQueued) {
              this.queueSparkSceneUpdate();
            }
          });
        return this.sparkSceneUpdatePromise;
      }

      isTimedRenderActive(now = performance.now()) {
        return now < this.activeRenderUntil;
      }

      getRenderFrameIntervalMs() {
        const fps = THREE.MathUtils.clamp(
          Number(this.state.renderFps) || 60,
          RENDER_FPS_LIMITS.min,
          RENDER_FPS_LIMITS.max,
        );
        return 1000 / fps;
      }

      getRenderFrameDelay(now = performance.now()) {
        const elapsed = this.lastRenderFrameAt > 0
          ? now - this.lastRenderFrameAt
          : Number.POSITIVE_INFINITY;
        return Math.max(0, this.getRenderFrameIntervalMs(now) - elapsed);
      }

      startDeferredInteraction(durationMs = INTERACTION_PREVIEW_MS) {
        const safeDuration = Math.max(0, durationMs);
        this.renderInvalidated = true;
        if (!this.deferredPreviewHandle) {
          const previewIntervalMs = Math.max(
            16,
            Math.round(1000 / Math.min(Number(this.state.renderFps) || 60, INTERACTION_PREVIEW_FPS)),
          );
          this.deferredPreviewHandle = window.setInterval(() => {
            if (this.pendingPreviewSparkUpdate) {
              this.pendingPreviewSparkUpdate = false;
              this.queueSparkSceneUpdate();
            }
            this.flushActiveBackendAppearanceRefresh();
            this.flushRenderNow();
          }, previewIntervalMs);
        }
        if (this.interactionFinalizeHandle) {
          window.clearTimeout(this.interactionFinalizeHandle);
        }
        this.interactionFinalizeHandle = window.setTimeout(() => {
          this.interactionFinalizeHandle = 0;
          this.finishDeferredInteraction();
        }, safeDuration + INTERACTION_SETTLE_MS);
        this.scheduleRender(0);
      }

      finishDeferredInteraction() {
        if (this.interactionFinalizeHandle) {
          window.clearTimeout(this.interactionFinalizeHandle);
          this.interactionFinalizeHandle = 0;
        }
        if (this.deferredPreviewHandle) {
          window.clearInterval(this.deferredPreviewHandle);
          this.deferredPreviewHandle = 0;
        }
        if (this.pendingPreviewSparkUpdate) {
          this.pendingPreviewSparkUpdate = false;
          this.queueSparkSceneUpdate();
        }
        this.flushActiveBackendAppearanceRefresh();
        this.scheduledRenderAt = 0;
        this.lastRenderFrameAt = 0;
        this.renderInvalidated = true;
        this.pendingForcedFrames = Math.max(this.pendingForcedFrames, 1);
        this.flushRenderNow();
      }

      flushRenderNow() {
        this.syncVisibleSceneItemTransforms();
        this.lightHandles.cameraPosition.value.copy(this.camera.position);
        // New lights start at the camera. Do not let a near-clipped helper cone
        // cover the viewport; visibility here affects helpers, never emission.
        for (const light of this.sceneLights ?? []) {
          const helperRadius = 0.8 * (light.helperScale ?? DEFAULT_LIGHT_HELPER_SCALE);
          light.root.visible = light.visible && this.camera.position.distanceTo(light.position) > helperRadius + this.camera.near;
        }
        if (this.brushOverlayGroup?.visible && this.lastBrushHit) {
          this.updateBrushOverlay(this.lastBrushHit, { invalidate: false });
        }
        if (this.backendManager?.isSparkActive() ?? true) {
          this.renderer.setRenderTarget(null);
          this.renderer.render(this.scene, this.camera);
          this.renderTransformOverlay(false);
        } else {
          this.renderActiveBackendFrame();
        }
        this.updateFps();
        this.updateCameraUi();
        this.lastRenderFrameAt = performance.now();
        this.scheduledRenderAt = 0;
        this.renderInvalidated = false;
        if (this.pendingForcedFrames > 0) {
          this.pendingForcedFrames -= 1;
        }
      }

      renderTransformOverlay(clearCanvas) {
        // The input canvas carries editing helpers over alternate engines.
        // Scene splats continue to be drawn exclusively by the chosen backend.
        const alpha = this.renderer.getClearAlpha();
        const autoClear = this.renderer.autoClear;
        this.renderer.setRenderTarget(null);
        try {
          if (clearCanvas) {
            this.renderer.setClearAlpha(0);
            this.renderer.clear();
          }
          this.renderer.autoClear = false;
          this.renderer.clearDepth();
          if (clearCanvas && this.lightSceneRoot?.children.some(child => child.visible)) {
            this.renderer.render(this.lightSceneRoot, this.camera);
            this.renderer.clearDepth();
          }
          if (this.transformControlsHelper.visible) {
            this.transformControls.object?.updateWorldMatrix(true, false);
            this.renderer.render(this.gizmoScene, this.camera);
          }
        } finally {
          this.renderer.autoClear = autoClear;
          this.renderer.setClearAlpha(alpha);
        }
      }

      ensureDynoHandleArray(target, count, factory) {
        while (target.length < count) {
          target.push(factory(target.length));
        }
        return target;
      }

      createSceneItemRecord(name, source) {
        const modelRoot = new THREE.Group();
        const rotationPivot = new THREE.Group();
        rotationPivot.rotation.order = "XYZ";
        modelRoot.add(rotationPivot);
        this.splatSceneRoot.add(modelRoot);
        return {
          id: `scene-item-${++this.sceneItemSerial}`,
          modelRoot,
          rotationPivot,
          mesh: null,
          visible: true,
          loadedShDegree: 3,
          baseObjectModifier: undefined,
          baseWorldModifier: undefined,
          baseLocalBounds: null,
          baseCenterBounds: null,
          bounds: null,
          boundsSphere: null,
          centerBounds: null,
          centerBoundsSphere: null,
          authoredBounceMaterialEntries: null,
          authoredNormalEntries: null,
          hasAuthoredSplatNormals: false,
          geometryRevision: 0,
          lightOcclusion: null,
          hoverEntries: null,
          modelMeta: createDefaultModelMeta(name, source),
          exportEnabled: true,
          settings: {
            exposure: 0,
            falloff: 1,
            opacity: 1,
            renderMode: "beauty",
            shLevel: 3,
            toneCurve: buildToneCurveState(),
          },
          lightExposureHandle: dynoFloat(1, `itemLightExposure-${this.sceneItemSerial}`),
          transform: {
            rotationX: 0,
            rotationY: 0,
            rotationZ: 0,
            scale: 1,
            translateX: 0,
            translateY: 0,
            translateZ: 0,
          },
        };
      }

      createLightRecord(type = 'point') {
        const root = new THREE.Group();
        const defaultLight = createDefaultLightState({
          radius: this.sceneBoundsSphere?.radius ?? 1,
          sceneLightSerial: this.sceneLightSerial + 1,
        });
        const bulb = new THREE.Mesh(
          new THREE.SphereGeometry(0.14, 18, 18),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(defaultLight.color.r, defaultLight.color.g, defaultLight.color.b) }),
        );
        const halo = new THREE.Mesh(
          new THREE.RingGeometry(0.18, 0.28, 28),
          new THREE.MeshBasicMaterial({
            color: LIGHT_HELPER_COLOR,
            opacity: 0.82,
            side: THREE.DoubleSide,
            transparent: true,
          }),
        );
        halo.rotation.x = -Math.PI / 2;
        root.add(halo, bulb);
        if (type !== 'point') {
          const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 0.7, LIGHT_HELPER_COLOR, 0.15, 0.08);
          root.add(arrow);
          if (type === 'area') {
            const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(-0.5,-0.5,0), new THREE.Vector3(0.5,-0.5,0),
              new THREE.Vector3(0.5,0.5,0), new THREE.Vector3(-0.5,0.5,0),
            ]), new THREE.LineBasicMaterial({ color: LIGHT_HELPER_COLOR }));
            outline.name = 'area-outline';
            root.add(outline);
          }
        }
        this.lightSceneRoot.add(root);
        return {
          id: `scene-light-${++this.sceneLightSerial}`,
          color: { ...defaultLight.color },
          helperScale: defaultLight.helperScale,
          intensity: type === 'directional' ? 1 : defaultLight.intensity,
          name: type === 'point' ? defaultLight.name : `${type === 'area' ? 'Area' : 'Directional'} Light ${this.sceneLightSerial}`,
          type, rotation: new THREE.Euler(), width: 1, height: 1,
          direction: new THREE.Vector3(0,0,-1), right: new THREE.Vector3(1,0,0), up: new THREE.Vector3(0,1,0),
          root,
          visible: true,
          position: new THREE.Vector3(),
        };
      }

      getSelectedItem() {
        return this.sceneItems.find((item) => item.id === this.selectedSceneItemId) || null;
      }

      getActiveAnimationTargetItem() {
        return this.sceneItems.find((item) => item.id === this.activeAnimationTargetItemId) || null;
      }

      isSparkAnimationAvailable() {
        return this.backendManager?.isSparkActive() ?? true;
      }

      isSparkViewportEditingAvailable() {
        return this.backendManager?.isSparkActive() ?? true;
      }

      setTimelineExpanded(expanded) {
        this.state.timelineExpanded = Boolean(expanded);
        this.syncTimelineToggle();
      }

      syncTimelineToggle() {
        const expanded = Boolean(this.state.timelineExpanded);
        if (this.dom.timelineContent) {
          this.dom.timelineContent.hidden = !expanded;
        }
        if (this.dom.timelineToggleButton) {
          this.dom.timelineToggleButton.setAttribute("aria-expanded", String(expanded));
          const action = expanded ? "Hide" : "Show";
          const visibleAction = !expanded && this.state.animationPlaying ? "Playing · Show" : action;
          this.dom.timelineToggleButton.innerHTML = `${visibleAction} <span aria-hidden="true">${expanded ? "⌃" : "⌄"}</span>`;
          this.dom.timelineToggleButton.title = `${action} animation timeline controls.`;
          this.dom.timelineToggleButton.setAttribute("aria-label", `${this.state.animationPlaying ? "Animation playing. " : ""}${action} animation timeline controls`);
        }
      }

      getSelectedLight() {
        return this.sceneLights.find((light) => light.id === this.selectedLightId) || null;
      }

      syncSelectionRefs(item) {
        this.currentMesh = item?.mesh ?? null;
        this.modelRoot = item?.modelRoot ?? null;
        this.rotationPivot = item?.rotationPivot ?? null;
        this.baseLocalBounds = item?.baseLocalBounds ?? null;
        this.baseCenterBounds = item?.baseCenterBounds ?? null;
        this.bounds = item?.bounds ?? null;
        this.boundsSphere = item?.boundsSphere ?? null;
        this.centerBounds = item?.centerBounds ?? null;
        this.centerBoundsSphere = item?.centerBoundsSphere ?? null;
        this.baseObjectModifier = item?.baseObjectModifier;
        this.baseWorldModifier = item?.baseWorldModifier;
        this.loadedShDegree = item?.loadedShDegree ?? 3;
        this.modelMeta = item?.modelMeta ?? createDefaultModelMeta();
      }

      applySelectedTransformState(syncInputs = true) {
        const item = this.getSelectedItem();
        if (!item) {
          this.state.rotationX = 0;
          this.state.rotationY = 0;
          this.state.rotationZ = 0;
          this.state.scale = 1;
          this.state.translateX = 0;
          this.state.translateY = 0;
          this.state.translateZ = 0;
          if (syncInputs) {
            this.syncTransformInputs();
          }
          return;
        }
        this.state.rotationX = item.transform.rotationX;
        this.state.rotationY = item.transform.rotationY;
        this.state.rotationZ = item.transform.rotationZ;
        this.state.scale = item.transform.scale;
        this.state.translateX = item.transform.translateX;
        this.state.translateY = item.transform.translateY;
        this.state.translateZ = item.transform.translateZ;
        if (syncInputs) {
          this.syncTransformInputs();
        }
        this.syncTransformGizmo();
      }

      syncSelectedSplatControls(syncInputs = true) {
        const item = this.getSelectedItem();
        this.dom.shSelect.disabled = !(this.backendManager?.isSparkActive() ?? true) || !item;
        this.state.selectedExposure = item?.settings?.exposure ?? 0;
        this.state.toneCurve = normalizeToneCurveState(item?.settings?.toneCurve ?? buildToneCurveState());
        this.state.falloff = Number.isFinite(this.spark?.falloff)
          ? this.spark.falloff
          : item?.settings?.falloff ?? 1;
        this.state.opacity = item?.settings?.opacity ?? 1;
        if (item) {
          this.spark.falloff = this.state.falloff;
        }
        if (this.dom.selectedExposureRange) {
          this.dom.selectedExposureRange.value = String(
            clampNumber(this.state.selectedExposure, EXPOSURE_LIMITS),
          );
        }
        if (this.dom.selectedExposureInput && syncInputs) {
          this.dom.selectedExposureInput.value = this.state.selectedExposure
            .toFixed(Math.abs(this.state.selectedExposure) < 1 ? 1 : 2);
        }
        if (this.dom.falloffRange) {
          this.dom.falloffRange.value = String(
            clampNumber(this.state.falloff, FALLOFF_LIMITS),
          );
        }
        if (this.dom.falloffInput && syncInputs) {
          this.dom.falloffInput.value = this.state.falloff.toFixed(2);
        }
        if (this.dom.opacityRange) {
          this.dom.opacityRange.value = String(Math.min(this.state.opacity, 2));
        }
        if (this.dom.opacityInput && syncInputs) {
          this.dom.opacityInput.value = this.state.opacity.toFixed(2);
        }
        if (this.dom.renderModeSelect) {
          this.dom.renderModeSelect.value = this.state.renderMode;
        }
        if (this.dom.shSelect) {
          this.dom.shSelect.value = String(this.state.shLevel);
        }
        this.syncToneCurveUi(syncInputs);
        this.syncLutUi();
        [this.dom.sceneRenderSection, this.dom.sceneTransformSection].forEach((section) => {
          if (!section) {
            return;
          }
          section.hidden = !item;
          this.setSectionDisabled(section, false);
        });
      }

      syncSelectedLightControls(syncInputs = true) {
        const light = this.getSelectedLight();
        this.dom.lightRotationFields.hidden = !light || light.type === 'point';
        this.dom.lightAreaFields.hidden = light?.type !== 'area';
        if (syncInputs) {
          ['x','y','z'].forEach(axis => {
            this.dom[`lightR${axis}Input`].value = formatNumber(THREE.MathUtils.radToDeg(light?.rotation?.[axis] ?? 0), 1);
          });
          this.dom.lightWidthInput.value = formatNumber(light?.width ?? 1, 3);
          this.dom.lightHeightInput.value = formatNumber(light?.height ?? 1, 3);
        }
        const lightColor = clampLightColor(light?.color ?? DEFAULT_LIGHT_COLOR);
        this.state.lightHelperScale = light?.helperScale ?? DEFAULT_LIGHT_HELPER_SCALE;
        this.state.lightIntensity = light?.intensity ?? 20;
        this.state.lightR = lightColor.r;
        this.state.lightG = lightColor.g;
        this.state.lightB = lightColor.b;
        this.state.lightX = light?.position?.x ?? 0;
        this.state.lightY = light?.position?.y ?? 0;
        this.state.lightZ = light?.position?.z ?? 0;
        if (this.dom.lightName) {
          this.dom.lightName.textContent = light?.name ?? "No light selected";
        }
        if (this.dom.lightHelperScaleRange) {
          this.dom.lightHelperScaleRange.value = String(clampNumber(this.state.lightHelperScale, LIGHT_HELPER_SCALE_LIMITS));
          this.dom.lightHelperScaleRange.disabled = !light;
        }
        if (syncInputs && this.dom.lightHelperScaleInput) {
          this.dom.lightHelperScaleInput.value = formatNumber(this.state.lightHelperScale, 2);
        }
        if (this.dom.lightIntensityRange) {
          this.dom.lightIntensityRange.value = String(Math.min(clampNumber(this.state.lightIntensity, LIGHT_INTENSITY_LIMITS), 100));
          this.dom.lightIntensityRange.disabled = !light;
        }
        if (syncInputs && this.dom.lightIntensityInput) {
          this.dom.lightIntensityInput.value = this.state.lightIntensity.toFixed(this.state.lightIntensity < 10 ? 2 : 1);
        }
        [
          this.dom.lightHelperScaleInput,
          this.dom.lightIntensityInput,
          this.dom.lightRInput,
          this.dom.lightGInput,
          this.dom.lightBInput,
          this.dom.lightXInput,
          this.dom.lightYInput,
          this.dom.lightZInput,
        ].forEach((input) => {
          if (input) {
            input.disabled = !light;
          }
        });
        if (syncInputs) {
          if (this.dom.lightRInput) {
            this.dom.lightRInput.value = formatNumber(this.state.lightR, 3);
          }
          if (this.dom.lightGInput) {
            this.dom.lightGInput.value = formatNumber(this.state.lightG, 3);
          }
          if (this.dom.lightBInput) {
            this.dom.lightBInput.value = formatNumber(this.state.lightB, 3);
          }
          if (this.dom.lightXInput) {
            this.dom.lightXInput.value = formatNumber(this.state.lightX, Math.abs(this.state.lightX) < 10 ? 2 : 1);
          }
          if (this.dom.lightYInput) {
            this.dom.lightYInput.value = formatNumber(this.state.lightY, Math.abs(this.state.lightY) < 10 ? 2 : 1);
          }
          if (this.dom.lightZInput) {
            this.dom.lightZInput.value = formatNumber(this.state.lightZ, Math.abs(this.state.lightZ) < 10 ? 2 : 1);
          }
        }
        if (this.dom.lightControlsSection) {
          this.dom.lightControlsSection.hidden = !light;
          this.setSectionDisabled(this.dom.lightControlsSection, false);
        }
      }

      syncOneBouncePreviewUi() {
        if (this.dom.oneBouncePreviewCheckbox) {
          this.dom.oneBouncePreviewCheckbox.checked = Boolean(this.state.oneBouncePreview);
        }
      }

      syncLegacySampledShadowUi() {
        if (this.dom.legacySampledShadowCheckbox) {
          this.dom.legacySampledShadowCheckbox.checked = Boolean(this.state.legacySampledShadow);
        }
      }

      getLightOcclusionAvailability() {
        const items = this.sceneItems.filter((item) => item.visible && item.mesh?.visible !== false && item.mesh);
        const lights = this.getLightSamples();
        const splatCount = items.reduce((sum, item) => sum + this.getPackedSplatCount(item), 0);
        const unavailable = (reason) => ({ enabled: false, reason, items, lights, splatCount });
        if (this.staticBakeApplied || this.staticBakeApplying) return unavailable("Clear / Restore the static bake to use live occlusion");
        if (this.state.animationApplied || this.activeAnimationModifier) return unavailable("Clear the animation before computing occlusion");
        if (!splatCount) return unavailable("Add visible splats");
        if (!lights.length) return unavailable("Add a visible light");
        if (lights.length > LIGHT_OCCLUSION_MAX_LIGHTS) return unavailable(`At most ${LIGHT_OCCLUSION_MAX_LIGHTS} shadow samples (Point/Directional: 1, Area: 4); no partial shadows`);
        if (splatCount * lights.length > LIGHT_OCCLUSION_MAX_SCALAR_SLOTS) return unavailable("Occlusion exceeds the 8M splat × light budget; no partial shadows");
        if (items.some((item) => !item.mesh.forEachSplat || item.mesh.covSplats || item.mesh.paged
          || item.mesh.skinning || item.mesh.rgbaDisplaceEdits || item.baseObjectModifier || item.baseWorldModifier)) {
          return unavailable("This splat modifier/storage cannot be captured for occlusion");
        }
        try {
          items.forEach((item) => getLightOcclusionTextureLayout({
            splatCount: this.getPackedSplatCount(item), lightCount: lights.length,
            maxTextureSize: this.renderer.capabilities.maxTextureSize,
          }));
        } catch (error) {
          return unavailable(error.message);
        }
        return { enabled: true, reason: "Ready", items, lights, splatCount };
      }

      syncLightOcclusionUi() {
        const availability = this.getLightOcclusionAvailability();
        const enabled = this.state.lightOcclusionEnabled;
        if (this.dom.lightOcclusionCheckbox) this.dom.lightOcclusionCheckbox.checked = enabled;
        if (this.dom.lightOcclusionUpdateButton) {
          this.dom.lightOcclusionUpdateButton.disabled = !enabled || !availability.enabled || this.lightOcclusionRunning;
        }
        if (this.dom.lightOcclusionCancelButton) {
          this.dom.lightOcclusionCancelButton.disabled = !this.lightOcclusionRunning && !this.lightOcclusionTimer;
        }
        if (this.dom.lightOcclusionStatus) {
          this.dom.lightOcclusionStatus.textContent = !enabled ? "Off" : !availability.enabled
            ? availability.reason : this.lightOcclusionStatusText || "Ready to compute";
        }
        if (this.dom.legacySampledShadowCheckbox) {
          this.dom.legacySampledShadowCheckbox.disabled = enabled || this.state.staticBakeMode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE;
        }
      }

      syncLightOcclusionEligibility() {
        const availability = this.getLightOcclusionAvailability();
        const reason = availability.enabled ? "" : availability.reason;
        if (reason !== this.lightOcclusionBlockReason) {
          this.lightOcclusionBlockReason = reason;
          this.invalidateLightOcclusion(reason || "Conditions updated");
        } else {
          this.syncLightOcclusionUi();
        }
      }

      setLightOcclusionEnabled(enabled) {
        this.state.lightOcclusionEnabled = Boolean(enabled);
        if (enabled && this.state.legacySampledShadow) {
          this.state.legacySampledShadow = false;
          this.syncLegacySampledShadowUi();
          this.refreshLightingModel({ forceModifierRebuild: true, occlusionChanged: false });
        }
        this.invalidateLightOcclusion(enabled ? "Occlusion requested" : "Off", { delay: 0 });
      }

      getLightOcclusionHandles(item) {
        if (!item.lightOcclusion) {
          const key = item.id.replace(/[^a-zA-Z0-9]/g, "");
          item.lightOcclusion = {
            count: dyno.dynoInt(0, `occlusionCount${key}`),
            enabled: dyno.dynoBool(false, `occlusionEnabled${key}`),
            sampler: dyno.dynoSampler2D(this.lightOcclusionEmptyTexture, `occlusionTexture${key}`),
            width: dyno.dynoInt(1, `occlusionWidth${key}`),
            texture: null, lightIds: [], data: null,
          };
        }
        return item.lightOcclusion;
      }

      releaseLightOcclusion(item) {
        const handles = item.lightOcclusion;
        if (!handles) return;
        handles.enabled.value = false;
        handles.sampler.value = this.lightOcclusionEmptyTexture;
        handles.count.value = 0;
        handles.texture?.dispose();
        handles.texture = null;
        handles.data = null;
        handles.lightIds = [];
      }

      invalidateLightOcclusion(reason, { schedule = true, delay = 450, geometryChanged = true } = {}) {
        this.lightOcclusionRevision += 1;
        this.lightOcclusionController.cancel();
        if (geometryChanged) {
          this.lightOcclusionSnapshot = null;
          this.lightOcclusionController.invalidateGeometry?.();
        }
        this.lightOcclusionRunning = false;
        window.clearTimeout(this.lightOcclusionTimer);
        this.lightOcclusionTimer = 0;
        const hadCache = this.sceneItems.some((item) => item.lightOcclusion?.enabled.value);
        this.sceneItems.forEach((item) => this.releaseLightOcclusion(item));
        const availability = this.getLightOcclusionAvailability();
        this.lightOcclusionBlockReason = availability.enabled ? "" : availability.reason;
        this.lightOcclusionStatusText = reason;
        if (this.state.lightOcclusionEnabled && schedule && availability.enabled) {
          this.lightOcclusionStatusText = "Pending · added light is temporarily unshadowed";
          this.lightOcclusionTimer = window.setTimeout(() => this.startLightOcclusion(), delay);
        }
        this.syncLightOcclusionUi();
        if (hadCache) {
          this.refreshActiveBackendSnapshot("Shadows invalidated", { appearanceOnly: true });
          this.renderPickedColors();
          if (this.hoverPointer) this.updateHoverReadout();
          this.forceVisualRefresh(2);
          this.queueSparkSceneUpdate();
        }
      }

      async startLightOcclusion() {
        this.lightOcclusionTimer = 0;
        const availability = this.getLightOcclusionAvailability();
        if (!this.state.lightOcclusionEnabled || !availability.enabled || this.lightOcclusionRunning) {
          this.syncLightOcclusionUi();
          return;
        }
        if (this.brushStroke || this.transformControls.dragging || this.deferredPreviewHandle) {
          this.lightOcclusionTimer = window.setTimeout(() => this.startLightOcclusion(), 200);
          return;
        }
        const revision = this.lightOcclusionRevision;
        const startedAt = performance.now();
        this.lightOcclusionRunning = true;
        this.lightOcclusionStatusText = "Preparing occlusion…";
        this.syncLightOcclusionUi();
        try {
          let snapshot = this.lightOcclusionSnapshot;
          if (!snapshot) {
            const fullSnapshot = this.createStaticBakeSnapshot();
            snapshot = { ...createLightOcclusionWorkerSnapshot(fullSnapshot), itemIds: fullSnapshot.itemIds };
            this.lightOcclusionSnapshot = snapshot;
          }
          if (snapshot.count !== availability.splatCount) throw new Error("Incomplete splat snapshot; no partial shadows applied");
          const lights = availability.lights.map((light) => {
            return { id: light.id, type: light.type, direction: lightVector(light.direction), position: lightVector(light.position) };
          });
          const result = await this.lightOcclusionController.startOcclusion({
            snapshot, lights,
            onProgress: ({ phase, processed, total }) => {
              if (revision !== this.lightOcclusionRevision) return;
              this.lightOcclusionStatusText = `${phase === "indexing" ? "Indexing" : "Occlusion"} ${processed.toLocaleString()}/${total.toLocaleString()} splats…`;
              this.syncLightOcclusionUi();
            },
          });
          if (revision !== this.lightOcclusionRevision || !this.state.lightOcclusionEnabled) return;
          if (result.canceled) {
            this.lightOcclusionStatusText = "Canceled · added light is unshadowed";
            return;
          }
          this.applyLightOcclusionResult(snapshot, result, lights.map((light) => light.id));
          this.refreshActiveBackendSnapshot("Shadows updated", { appearanceOnly: true });
          const execution = result.diagnostics?.execution ?? "CPU";
          const reused = result.diagnostics?.reusedLights ?? 0;
          const precision = result.diagnostics?.precisionFallbackReceivers ?? 0;
          const fallback = result.diagnostics?.fallbackReason;
          this.lightOcclusionStatusText = `Cached · ${execution} · ${snapshot.count.toLocaleString()} splats × ${lights.length} shadow sample${lights.length === 1 ? "" : "s"} · ${(performance.now() - startedAt).toFixed(0)} ms${reused ? ` · ${reused} reused` : ""}${precision ? ` · ${precision} CPU boundary checks` : ""}${fallback ? ` · ${fallback}` : ""}`;
          this.renderPickedColors();
          if (this.hoverPointer) this.updateHoverReadout();
          this.forceVisualRefresh(3);
          this.queueSparkSceneUpdate();
        } catch (error) {
          if (revision !== this.lightOcclusionRevision) return;
          this.sceneItems.forEach((item) => this.releaseLightOcclusion(item));
          this.lightOcclusionStatusText = `Unavailable · ${error instanceof Error ? error.message : "Occlusion failed"}`;
        } finally {
          if (revision === this.lightOcclusionRevision) {
            this.lightOcclusionRunning = false;
            this.syncLightOcclusionUi();
          }
        }
      }

      applyLightOcclusionResult(snapshot, result, lightIds) {
        const lightCount = lightIds.length;
        const currentLightIds = this.getLightSamples().map((light) => light.id);
        if (result.lightCount !== lightCount || result.total !== snapshot.count
          || result.transmission?.length !== snapshot.count * lightCount
          || JSON.stringify(result.lightIds) !== JSON.stringify(lightIds)
          || JSON.stringify(currentLightIds) !== JSON.stringify(lightIds)) {
          throw new Error("Occlusion light/splat mapping changed; result discarded");
        }
        const staged = new Map();
        const itemsById = new Map(this.sceneItems.map((item) => [item.id, item]));
        try {
          for (let index = 0; index < snapshot.count; index += 1) {
            const id = snapshot.itemIds[snapshot.itemIndex[index]];
            const item = itemsById.get(id);
            if (!item?.visible || !item.mesh) throw new Error("Occlusion item mapping changed");
            if (!staged.has(id)) {
              const count = this.getPackedSplatCount(item);
              const layout = getLightOcclusionTextureLayout({ splatCount: count, lightCount, maxTextureSize: this.renderer.capabilities.maxTextureSize });
              staged.set(id, { item, count, layout, data: new Float32Array(layout.width * layout.height), seen: new Uint8Array(count), copied: 0, texture: null });
            }
            const entry = staged.get(id);
            const sourceIndex = snapshot.sourceIndex[index];
            if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= entry.count || entry.seen[sourceIndex]) {
              throw new Error("Occlusion source index is invalid or duplicated");
            }
            entry.seen[sourceIndex] = 1;
            entry.copied += 1;
            for (let light = 0; light < lightCount; light += 1) {
              const transmission = result.transmission[index * lightCount + light];
              if (!Number.isFinite(transmission) || transmission < 0 || transmission > 1) throw new Error("Invalid occlusion transmission");
              entry.data[sourceIndex * lightCount + light] = transmission;
            }
          }
          for (const entry of staged.values()) {
            if (entry.copied !== entry.count) throw new Error("Incomplete occlusion source mapping");
            entry.texture = createLightOcclusionTexture(entry.data, entry.layout.width, entry.layout.height);
          }
          for (const entry of staged.values()) {
            const handles = this.getLightOcclusionHandles(entry.item);
            handles.texture?.dispose();
            handles.texture = entry.texture;
            handles.sampler.value = entry.texture;
            handles.data = entry.data;
            handles.count.value = entry.count;
            handles.width.value = entry.layout.width;
            handles.lightIds = lightIds.slice();
            handles.enabled.value = true;
          }
        } catch (error) {
          staged.forEach((entry) => entry.texture?.dispose());
          throw error;
        }
      }

      setLegacySampledShadow(enabled) {
        this.state.legacySampledShadow = Boolean(enabled);
        this.syncLegacySampledShadowUi();
        this.refreshLightingModel({ forceModifierRebuild: true, occlusionChanged: false });
        this.updateStatus(this.state.legacySampledShadow
          ? "Legacy sampled shadow enabled (32 proxies; approximate)"
          : "Legacy sampled shadow disabled");
      }

      setOneBouncePreview(enabled) {
        if (enabled && this.sceneLights.some(light => light.visible && light.type !== 'point')) {
          this.state.oneBouncePreview = false;
          this.syncOneBouncePreviewUi();
          this.updateStatus('Legacy bounce preview supports Point lights only');
          return;
        }
        this.state.oneBouncePreview = Boolean(enabled);
        this.syncOneBouncePreviewUi();
        // The VPL Dyno handles are fixed and padded, so this only updates
        // uniform values and never rebuilds a shader for toggle/count changes.
        this.syncLightingRuntimeState();
        if (this.hoverPointer) {
          this.updateHoverReadout();
        }
        this.renderPickedColors();
        this.invalidateRender();
        this.queueSparkSceneUpdate();
        this.refreshActiveBackendSnapshot('Bounce preview updated', { appearanceOnly: true });
        this.updateStatus(this.state.oneBouncePreview
          ? `Legacy 6-VPL bounce preview enabled (${this.activeOneBounceVplCount}/${ONE_BOUNCE_VPL_LIMIT} authored VPLs; approximate and may leak through occluders)`
          : "Legacy 6-VPL bounce preview disabled");
      }

      disableLegacyLightingForAuthoredBounce() {
        const changed = this.state.legacySampledShadow || this.state.oneBouncePreview;
        this.state.legacySampledShadow = false;
        this.state.oneBouncePreview = false;
        this.syncLegacySampledShadowUi();
        this.syncOneBouncePreviewUi();
        if (!changed) return;
        this.refreshLightingModel({ forceModifierRebuild: true, occlusionChanged: false });
        this.syncLightingRuntimeState();
        if (this.hoverPointer) {
          this.updateHoverReadout();
        }
        this.renderPickedColors();
        this.invalidateRender();
        this.queueSparkSceneUpdate();
      }

      getStaticBakeAvailability() {
        const visibleItems = this.sceneItems.filter((item) => item.visible && item.mesh);
        const splatCount = visibleItems.reduce(
          (sum, item) => sum + Number(item.mesh.numSplats ?? item.mesh.packedSplats?.numSplats ?? 0),
          0,
        );
        const visibleLights = this.sceneLights.filter((light) => light.visible);
        const authoredBounceMaterialCount = visibleItems.reduce((sum, item) => sum + (
          item.authoredBounceMaterialEntries?.reduce((entrySum, entry) => (
            entrySum + (entry?.authoredDiffuseAlbedo && Number(entry?.authoredSurfaceArea) > 0 ? 1 : 0)
          ), 0) ?? 0
        ), 0);
        const bounceMode = this.state.staticBakeMode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE;
        if (this.staticBakeApplying) return { enabled: false, reason: "Bake is running", splatCount };
        if (this.staticBakeApplied) return { enabled: false, reason: this.staticBakeStaleReason || "Baked; Clear / Restore before a new bake", splatCount };
        if (!splatCount) return { enabled: false, reason: "No visible splats to bake", splatCount };
        if (!visibleLights.length) return { enabled: false, reason: "Add one visible point light to bake", splatCount };
        if (visibleLights.length !== 1) return { enabled: false, reason: "v1 supports exactly one visible point light", splatCount };
        if (visibleLights[0].type !== 'point') return { enabled: false, reason: 'Static Bake supports Point only; Area / Directional use live lighting and color export', splatCount };
        if (this.state.animationApplied || this.activeAnimationModifier) {
          return { enabled: false, reason: "Clear the active animation modifier before baking; animation is not captured", splatCount };
        }
        if (visibleItems.some((item) => getStaticBakeActiveShDegree({
          loadedShDegree: item.loadedShDegree,
          requestedShLevel: item.settings?.shLevel,
        }) > 0)) {
          return { enabled: false, reason: "All visible splat items must use SH0; SH>0 is not baked", splatCount };
        }
        if (visibleItems.some((item) => {
          const splats = this.getEditableSplatStorage(item);
          return !splats?.getSplat || !splats?.setSplat;
        })) return { enabled: false, reason: "Visible splat storage does not expose public getSplat/setSplat", splatCount };
        if (bounceMode && !authoredBounceMaterialCount) {
          return { enabled: false, reason: "Authored one bounce requires visible Cube or Macbeth authored material", splatCount };
        }
        if (bounceMode) {
          return {
            authoredBounceMaterialCount,
            enabled: true,
            reason: "Ready: authored material splats bounce; generic splats are BVH occluders only",
            splatCount,
          };
        }
        return { enabled: true, reason: "Ready: all visible splats will be receivers and occluders", splatCount };
      }

      syncStaticBakeUi() {
        const availability = this.getStaticBakeAvailability();
        if (this.dom.staticBakeButton) this.dom.staticBakeButton.disabled = !availability.enabled;
        if (this.dom.staticBakeCancelButton) this.dom.staticBakeCancelButton.disabled = !this.staticBakeApplying;
        if (this.dom.staticBakeClearButton) this.dom.staticBakeClearButton.disabled = !this.staticBakeApplied;
        if (this.dom.staticBakeGenericPolicy) {
          if (this.state.staticBakeMode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE) {
            this.state.staticBakeGenericPolicy = STATIC_BAKE_GENERIC_POLICY.PRESERVE;
          }
          this.dom.staticBakeGenericPolicy.value = this.state.staticBakeGenericPolicy;
          this.dom.staticBakeGenericPolicy.disabled = this.staticBakeApplying
            || this.staticBakeApplied
            || this.state.staticBakeMode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE;
        }
        if (this.dom.staticBakeMode) {
          this.dom.staticBakeMode.value = this.state.staticBakeMode;
          this.dom.staticBakeMode.disabled = this.staticBakeApplying || this.staticBakeApplied;
        }
        const bounceMode = this.state.staticBakeMode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE;
        const nonPoint = this.sceneLights.some(light => light.visible && light.type !== 'point');
        if (this.dom.legacySampledShadowCheckbox) this.dom.legacySampledShadowCheckbox.disabled = bounceMode || nonPoint;
        if (this.dom.oneBouncePreviewCheckbox) this.dom.oneBouncePreviewCheckbox.disabled = bounceMode || nonPoint;
        if (this.dom.staticBakeStatus && !this.staticBakeApplying) {
          this.dom.staticBakeStatus.textContent = this.staticBakeStaleReason
            ? (this.staticBakeApplied
              ? `Stale: ${this.staticBakeStaleReason}. Clear / Restore before baking again.`
              : `Stale: ${this.staticBakeStaleReason}. Update conditions, then Bake again.`)
            : (this.staticBakeStatusText || availability.reason);
        }
        this.syncLightOcclusionEligibility();
      }

      markStaticBakeStale(reason) {
        if (!this.staticBakeApplied && !this.staticBakeApplying) return;
        this.staticBakeStaleReason = reason;
        this.staticBakeStatusText = "";
        if (this.staticBakeApplying) this.staticBakeController.cancel();
        this.syncStaticBakeUi();
      }

      createStaticBakeSnapshot() {
        this.syncVisibleSceneItemTransforms();
        return flattenVisibleSnapshot(
          createSceneSnapshot(this.sceneItems, {
            includeQuaternion: false,
            visibleOnly: true,
          }),
          { includeQuaternion: false },
        );
      }

      getStaticBakeLight() {
        const light = this.sceneLights.find((entry) => entry.visible);
        if (!light) return null;
        light.root.updateMatrixWorld(true);
        const position = light.root.getWorldPosition(new THREE.Vector3());
        return {
          color: [light.color.r, light.color.g, light.color.b],
          genericPolicy: this.state.staticBakeMode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE
            ? STATIC_BAKE_GENERIC_POLICY.PRESERVE
            : this.state.staticBakeGenericPolicy,
          intensity: light.intensity,
          position: [position.x, position.y, position.z],
          shadowFloor: 0,
        };
      }

      collectStaticBakeWrites(snapshot, linearRgb) {
        const records = [];
        for (let outputIndex = 0; outputIndex < snapshot.count; outputIndex += 1) {
          const itemId = snapshot.itemIds?.[snapshot.itemIndex[outputIndex]];
          const item = this.getSceneItemById(itemId);
          const splats = this.getEditableSplatStorage(item);
          const sourceIndex = snapshot.sourceIndex[outputIndex];
          const splat = splats?.getSplat?.(sourceIndex);
          if (!item || !splats?.setSplat || !splat) {
            throw new Error("Static bake could not preflight public splat setters; no colors were changed");
          }
          // Spark getSplat() reuses one module-level scratch object. Clone every
          // geometry component immediately or all records collapse to the last
          // decoded splat when the color transaction starts writing.
          const sourceCenter = splat.center ?? splat.position;
          const sourceScales = splat.scales ?? splat.scale;
          if (!sourceCenter?.clone || !sourceScales?.clone) {
            throw new Error("Static bake could not clone public splat geometry; no colors were changed");
          }
          records.push({
            center: sourceCenter.clone(),
            item,
            opacity: splat.opacity ?? splat.alpha ?? splat.rgba?.w ?? splat.rgba?.a ?? 1,
            outputIndex,
            quaternion: this.getSplatQuaternion(splat),
            scales: sourceScales.clone(),
            sourceIndex,
            splats,
          });
        }
        return records;
      }

      captureStaticBakeSourceColors(snapshot) {
        const rgb = new Float32Array(snapshot.count * 3);
        for (let index = 0; index < snapshot.count; index += 1) {
          const item = this.getSceneItemById(snapshot.itemIds[snapshot.itemIndex[index]]);
          const splat = this.getEditableSplatStorage(item)?.getSplat?.(snapshot.sourceIndex[index]);
          if (!splat) throw new Error("Could not preserve original splat colors");
          rgb.set(toLinearRgbArray(splat.color ?? splat.rgb ?? splat.rgba), index * 3);
        }
        return rgb;
      }

      applyStaticBakeColors(snapshot, linearRgb, { sourceEncoded = false } = {}) {
        const writes = this.collectStaticBakeWrites(snapshot, linearRgb);
        const touchedItems = new Set();
        writes.forEach(({ center, item, opacity, outputIndex, quaternion, scales, sourceIndex, splats }) => {
          const offset = outputIndex * 3;
          const rgb = [linearRgb[offset], linearRgb[offset + 1], linearRgb[offset + 2]];
          const stored = sourceEncoded ? rgb : linearColorToSource(rgb, item.sourceColorSpace);
          const color = new THREE.Color(...stored);
          splats.setSplat(
            sourceIndex,
            center,
            scales,
            quaternion,
            opacity,
            color,
          );
          touchedItems.add(item);
        });
        touchedItems.forEach((item) => {
          this.markSplatStorageNeedsUpdate(this.getEditableSplatStorage(item));
          item.mesh.updateGenerator?.();
          item.hoverEntries = this.createMeshHoverEntries(item);
        });
        return writes.length;
      }

      async startStaticBake() {
        const availability = this.getStaticBakeAvailability();
        if (!availability.enabled) {
          this.updateStatus(`Static bake unavailable: ${availability.reason}`);
          return;
        }
        const snapshot = this.createStaticBakeSnapshot();
        if (snapshot.unsupportedStaticBakeTransformCount) {
          this.updateStatus(`Static bake unavailable: ${snapshot.unsupportedStaticBakeTransformCount.toLocaleString()} visible item transform${snapshot.unsupportedStaticBakeTransformCount === 1 ? "" : "s"} uses non-uniform scale, shear, or mirroring`);
          return;
        }
        const light = this.getStaticBakeLight();
        const request = ++this.staticBakeRequest;
        this.staticBakeApplying = true;
        this.staticBakeStaleReason = "";
        this.staticBakeStatusText = "Preparing immutable world-space snapshot…";
        this.staticBakeStartedAt = performance.now();
        this.syncStaticBakeUi();
        try {
          const result = await this.staticBakeController.start({
            light,
            mode: this.state.staticBakeMode,
            snapshot,
            onProgress: ({ phase, processed, stage, total }) => {
              if (request !== this.staticBakeRequest || !this.staticBakeApplying) return;
              const stageLabel = {
                "center-scan": "scan",
                hierarchy: "hierarchy",
                morton: "morton",
                sort: "sort",
              }[stage] ?? stage;
              const label = phase === "indexing"
                ? `Indexing exact packed BVH · ${stageLabel || "scan"}`
                : (phase === "bounce" ? "Authored one-bounce paths" : "Direct bake");
              this.staticBakeStatusText = `${label} ${processed.toLocaleString()}/${total.toLocaleString()}${phase === "bounce" ? " paths" : " splats"}…`;
              if (this.dom.staticBakeStatus) this.dom.staticBakeStatus.textContent = this.staticBakeStatusText;
            },
          });
          if (request !== this.staticBakeRequest) return;
          if (result.canceled || this.staticBakeStaleReason) {
            this.updateStatus(result.canceled ? "Static bake canceled; no colors were applied" : "Static bake became stale; no colors were applied");
            return;
          }
          // Keep a recoverable original before the first public setter. If a
          // later setter/update fails, either rollback atomically or retain
          // this state so Clear / Restore can be retried without data loss.
          this.staticBakeOriginalRgb = this.captureStaticBakeSourceColors(snapshot);
          this.staticBakeResultSnapshot = createStaticBakeRestoreHandle(snapshot);
          const transaction = runStaticBakeColorTransaction({
            applyBaked: () => this.applyStaticBakeColors(snapshot, result.bakedLinearRgb),
            restoreOriginal: () => this.applyStaticBakeColors(snapshot, this.staticBakeOriginalRgb, { sourceEncoded: true }),
          });
          if (transaction.error) {
            if (transaction.rolledBack) {
              this.staticBakeOriginalRgb = null;
              this.staticBakeResultSnapshot = null;
              throw new Error(`Static bake write failed and was rolled back: ${transaction.error.message}`);
            }
            this.staticBakeApplied = true;
            const rollbackMessage = transaction.rollbackError instanceof Error
              ? transaction.rollbackError.message
              : "unknown rollback error";
            throw new Error(`Static bake write failed; Clear / Restore retains the original RGB for retry (${rollbackMessage})`);
          }
          const changed = transaction.result;
          this.staticBakeApplied = true;
          const elapsed = performance.now() - this.staticBakeStartedAt;
          const execution = result.execution === "webgpu" ? "WebGPU visibility"
            : `${result.execution === "worker" ? "Worker" : "main-thread fallback"}${result.fallbackReason ? ` (${result.fallbackReason})` : ""}`;
          const stats = result.diagnostics;
          const modeLabel = this.state.staticBakeMode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE
            ? `Direct + authored one bounce · sources: ${stats.selectedSourceCount} coherent source clusters (${stats.sourceClusterGroupCount} groups; experimental approximation), receivers ${stats.authoredBounceReceiverCount}, paths ${stats.testedPaths}/${stats.plannedPaths}, indirect Y ${stats.totalIndirectLuminance.toExponential(3)}`
            : `All-splat direct · authored ${stats.authoredReceiverCount}, generic visibility-only ${stats.genericVisibilityOnlyCount}`;
          this.staticBakeStatusText = `Baked ${result.processed.toLocaleString()}/${result.total.toLocaleString()} · ${result.bvhNodeCount.toLocaleString()} BVH nodes · ${elapsed.toFixed(0)} ms · ${execution} · ${modeLabel}`;
          this.applyRenderMode(false);
          this.refreshActiveBackendSnapshot("Static bake applied");
          this.updateStatus(this.state.staticBakeMode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE
            ? `Applied direct + authored one-bounce bake to ${changed.toLocaleString()} splats; generic splats remained occluders only`
            : `Applied all-splat direct bake to ${changed.toLocaleString()} splats; no indirect light was added`);
        } catch (error) {
          if (request !== this.staticBakeRequest) return;
          const message = error instanceof Error ? error.message : "Static bake failed";
          this.staticBakeStaleReason = `Error: ${message}`;
          this.updateStatus(`Static bake failed: ${message}`);
        } finally {
          if (request === this.staticBakeRequest) {
            this.staticBakeApplying = false;
            this.syncStaticBakeUi();
          }
        }
      }

      cancelStaticBake() {
        if (!this.staticBakeApplying) return;
        this.staticBakeRequest += 1;
        this.staticBakeController.cancel();
        this.staticBakeApplying = false;
        this.staticBakeStaleReason = "Canceled";
        this.staticBakeStatusText = "";
        this.syncStaticBakeUi();
        this.updateStatus("Static bake cancel requested; no partial colors will be applied");
      }

      clearStaticBake() {
        if (!this.staticBakeApplied || !this.staticBakeResultSnapshot || !this.staticBakeOriginalRgb) return;
        try {
          const restored = this.applyStaticBakeColors(this.staticBakeResultSnapshot, this.staticBakeOriginalRgb, { sourceEncoded: true });
          this.staticBakeApplied = false;
          this.staticBakeOriginalRgb = null;
          this.staticBakeResultSnapshot = null;
          this.staticBakeStaleReason = "";
          this.staticBakeStatusText = "";
          this.applyRenderMode(false);
          this.refreshActiveBackendSnapshot("Static bake restored");
          this.updateStatus(`Restored immutable pre-bake RGB for ${restored.toLocaleString()} splats`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Static bake restore failed";
          this.staticBakeStaleReason = `Restore failed: ${message}`;
          this.updateStatus(`Static bake restore failed: ${message}`);
        } finally {
          this.syncStaticBakeUi();
        }
      }

      setSectionDisabled(section, disabled, allowedButtons = []) {
        if (!section) {
          return;
        }
        section.classList.toggle("is-disabled", Boolean(disabled));
        const allowSet = new Set(allowedButtons.filter(Boolean));
        section.querySelectorAll("input, select, textarea, button").forEach((element) => {
          if (allowSet.has(element)) {
            return;
          }
          element.disabled = Boolean(disabled);
        });
      }

      updateLightVisual(light) {
        if (!light?.root) {
          return;
        }
        light.root.position.copy(light.position);
        light.root.rotation.copy(light.rotation);
        light.direction.set(0,0,-1).applyEuler(light.rotation);
        light.right.set(1,0,0).applyEuler(light.rotation);
        light.up.set(0,1,0).applyEuler(light.rotation);
        light.root.getObjectByName('area-outline')?.scale.set(light.width, light.height, 1);
        light.root.visible = light.visible;
        const bulb = light.root.children[1];
        const halo = light.root.children[0];
        const helperScale = clampNumber(light.helperScale ?? DEFAULT_LIGHT_HELPER_SCALE, LIGHT_HELPER_SCALE_LIMITS);
        const lightColor = clampLightColor(light.color ?? DEFAULT_LIGHT_COLOR);
        if (bulb?.material?.color) {
          bulb.material.color.setRGB(lightColor.r, lightColor.g, lightColor.b);
        }
        if (bulb) {
          bulb.scale.setScalar(helperScale);
        }
        if (halo) {
          halo.material?.color?.setRGB(lightColor.r, lightColor.g, lightColor.b);
          const haloScale = THREE.MathUtils.clamp(0.8 + Math.log10(Math.max(light.intensity, 1) + 1) * 0.32, 0.8, 2.5);
          halo.scale.setScalar(haloScale * helperScale);
        }
        if (light.type !== 'point') light.root.children[2]?.scale.setScalar(helperScale);
      }

      getRenderModeForItem(item) {
        if (!item) {
          return "beauty";
        }
        return item.id === this.selectedSceneItemId
          ? (this.state.renderMode || "beauty")
          : "beauty";
      }

      getGlobalExposureScale() {
        return 2 ** clampNumber(this.state.exposure, EXPOSURE_LIMITS);
      }

      getBeautyExposureScaleForItem(item) {
        return this.getGlobalExposureScale()
          * (2 ** clampNumber(item?.settings?.exposure ?? 0, EXPOSURE_LIMITS));
      }

      selectLight(lightId, announce = true) {
        const light = this.sceneLights.find((entry) => entry.id === lightId) || null;
        this.selectedLightId = light?.id ?? null;
        this.selectedSceneItemId = null;
        this.syncSelectionRefs(null);
        this.applySelectedTransformState(true);
        this.syncSelectedSplatControls(true);
        this.syncSelectedLightControls(true);
        this.applyRenderMode(false);
        this.syncAnimationEditor();
        this.syncAnimationControls(true);
        this.updateNormalizeFieldState();
        this.updateMetaUi();
        this.syncSceneList();
        this.syncAlignUi();
        this.syncLightList();
        this.syncTransformGizmo();
        this.updateTransformGizmoButtons();
        this.clearHoverReadout();
        this.renderPickedColors();
        if (announce && light) {
          this.updateStatus(`Selected ${light.name}`);
        }
        this.invalidateRender();
      }

      selectSceneItem(itemId, announce = true) {
        const item = this.sceneItems.find((entry) => entry.id === itemId) || null;
        this.selectedSceneItemId = item?.id ?? null;
        this.selectedLightId = null;
        this.syncSelectionRefs(item);
        this.applySelectedTransformState(true);
        this.syncSelectedSplatControls(true);
        this.syncSelectedLightControls(true);
        this.updatePositionModifierBounds();
        this.applyRenderMode(false);
        this.syncAnimationEditor();
        this.syncAnimationControls(true);
        this.updateNormalizeFieldState();
        this.updateMetaUi();
        this.syncSceneList();
        this.syncAlignUi();
        this.syncLightList();
        this.updateTransformGizmoButtons();
        this.syncBrushUi(true);
        if (this.hoverPointer) {
          this.updateHoverReadout();
        } else {
          this.clearHoverReadout();
        }
        this.renderPickedColors();
        requestAnimationFrame(() => {
          this.dom.sceneList?.querySelector(".scene-item.is-active")?.scrollIntoView?.({
            block: "nearest",
          });
        });
        if (announce && item) {
          this.updateStatus(`Selected ${item.modelMeta.name}`);
        }
        this.invalidateRender();
      }

      getAlignSelection(role) {
        const select = role === "target" ? this.dom.alignTargetSelect : this.dom.alignSourceSelect;
        return this.sceneItems.find((item) => item.id === select?.value) || null;
      }

      ensureAlignSelections() {
        if (!this.dom.alignSourceSelect || !this.dom.alignTargetSelect) {
          return;
        }
        const ids = this.sceneItems.map((item) => item.id);
        if (!ids.includes(this.dom.alignSourceSelect.value)) {
          this.dom.alignSourceSelect.value = ids[0] || "";
        }
        if (!ids.includes(this.dom.alignTargetSelect.value) || this.dom.alignTargetSelect.value === this.dom.alignSourceSelect.value) {
          this.dom.alignTargetSelect.value = ids.find((id) => id !== this.dom.alignSourceSelect.value) || ids[1] || ids[0] || "";
        }
      }

      reconcileAlignPointContext() {
        // Picked coordinates are world-space measurements, valid only for
        // these participants at these geometry/transformation revisions.
        const context = JSON.stringify(["source", "target"].map((role) => {
          const item = this.getAlignSelection(role);
          item?.mesh?.updateWorldMatrix?.(true, false);
          return [item?.id ?? null, item?.geometryRevision ?? 0,
            Array.from(item?.mesh?.matrixWorld?.elements ?? [])];
        }));
        const changed = this.alignPointContext !== null && this.alignPointContext !== context;
        this.alignPointContext = context;
        if (changed) {
          const hadPoints = this.alignPoints.source.length || this.alignPoints.target.length;
          this.alignPoints = { source: [], target: [] };
          this.disposeAlignMarkers();
          this.alignPickMode = false;
          if (hadPoints) this.updateStatus("Alignment targets changed; pick matching points again");
          this.forceVisualRefresh(2);
        }
        return changed;
      }

      syncAlignUi() {
        if (!this.dom.alignSourceSelect || !this.dom.alignTargetSelect) {
          return;
        }
        const previousSource = this.dom.alignSourceSelect.value;
        const previousTarget = this.dom.alignTargetSelect.value;
        const buildOptions = (select, selectedId) => {
          select.replaceChildren(...this.sceneItems.map((item, index) => {
            const option = document.createElement("option");
            option.value = item.id;
            option.textContent = `${index + 1}. ${item.modelMeta.name}`;
            option.selected = item.id === selectedId;
            return option;
          }));
        };
        buildOptions(this.dom.alignSourceSelect, previousSource);
        buildOptions(this.dom.alignTargetSelect, previousTarget);
        this.ensureAlignSelections();
        this.reconcileAlignPointContext();
        this.renderAlignPointList();
        const pairs = Math.min(this.alignPoints.source.length, this.alignPoints.target.length);
        const viewportEditingAvailable = this.isSparkViewportEditingAvailable();
        const animatedParticipant = this.state.animationApplied && [
          this.dom.alignSourceSelect.value, this.dom.alignTargetSelect.value,
        ].includes(this.activeAnimationTargetItemId);
        const ready = this.sceneItems.length >= 2
          && !animatedParticipant
          && this.dom.alignSourceSelect.value
          && this.dom.alignTargetSelect.value
          && this.dom.alignSourceSelect.value !== this.dom.alignTargetSelect.value
          && pairs >= 3;
        if (this.dom.alignApplyButton) {
          this.dom.alignApplyButton.disabled = !ready;
        }
        if (this.dom.alignResetButton) {
          const resetItem = this.lastAlignmentSnapshot
            ? this.sceneItems.find((item) => item.id === this.lastAlignmentSnapshot.itemId)
            : null;
          this.dom.alignResetButton.disabled = !resetItem;
        }
        if (this.dom.alignAddPointButton) {
          this.dom.alignAddPointButton.disabled = !viewportEditingAvailable || animatedParticipant || this.sceneItems.length < 1;
          this.dom.alignAddPointButton.classList.toggle("is-active", this.alignPickMode);
          this.dom.alignAddPointButton.textContent = this.alignPickMode ? "Click Splat..." : "Add Point";
        }
        if (this.dom.alignStatus) {
          this.dom.alignStatus.textContent = animatedParticipant
            ? "Clear the participant's animation before picking or aligning."
            : !viewportEditingAvailable
            ? "Point picking is available in Spark; existing coordinates remain editable."
            : ready
            ? `${pairs} matching pairs ready. Source will align to Target.`
            : `Need two splats and 3 matching point pairs. Current pairs: ${pairs}.`;
        }
      }

      renderAlignPointList() {
        if (!this.dom.alignPointList) {
          return;
        }
        const count = Math.max(this.alignPoints.source.length, this.alignPoints.target.length);
        this.dom.alignPointList.innerHTML = "";
        for (let index = 0; index < count; index += 1) {
          const row = document.createElement("div");
          row.className = "align-point-row";
          const label = document.createElement("span");
          label.className = "align-point-label";
          label.textContent = `#${index + 1}`;
          const editors = document.createElement("div");
          editors.className = "align-point-editors";
          const source = this.createAlignPointEditor({ role: "source", index, point: this.alignPoints.source[index] });
          const target = this.createAlignPointEditor({ role: "target", index, point: this.alignPoints.target[index] });
          editors.append(source, target);
          const removeButton = document.createElement("button");
          removeButton.className = "toolbar-button align-point-remove-button";
          removeButton.type = "button";
          removeButton.textContent = "Remove";
          removeButton.title = `Remove marker pair #${index + 1}`;
          removeButton.addEventListener("click", () => this.removeAlignPointPair(index));
          row.append(label, editors, removeButton);
          this.dom.alignPointList.append(row);
        }
      }

      createAlignPointEditor({ role, index, point }) {
        const wrapper = document.createElement("div");
        wrapper.className = `align-point-editor align-point-editor-${role}`;
        const title = document.createElement("span");
        title.className = "align-point-editor-label";
        title.textContent = point
          ? formatAlignPointLabel({ role, index: index + 1 })
          : `${role === "source" ? "S" : "T"}-`;
        wrapper.append(title);
        ["x", "y", "z"].forEach((axis) => {
          const axisField = document.createElement("label");
          axisField.className = "align-point-coordinate-field";
          const axisLabel = document.createElement("span");
          axisLabel.className = "align-point-axis-label";
          axisLabel.textContent = axis.toUpperCase();
          const input = document.createElement("input");
          input.className = "text-input align-point-coordinate-input";
          input.type = "number";
          input.step = "0.001";
          input.inputMode = "decimal";
          input.dataset.alignRole = role;
          input.dataset.alignIndex = String(index);
          input.dataset.alignAxis = axis;
          input.title = `${formatAlignPointLabel({ role, index: index + 1 })} ${axis.toUpperCase()}`;
          input.setAttribute("aria-label", input.title);
          input.value = point ? formatNumber(point[axis], 3) : "";
          input.disabled = !point;
          input.addEventListener("blur", () => {
            // Preserve full-precision picked coordinates when the field was not edited.
            if (!point || input.value === formatNumber(point[axis], 3)) return;
            this.updateAlignPointCoordinate(role, index, axis, input.value);
            input.value = formatNumber(point[axis], 3);
          });
          input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              input.blur();
            }
          });
          axisField.append(axisLabel, input);
          wrapper.append(axisField);
        });
        return wrapper;
      }

      updateAlignPointCoordinate(role, index, axis, rawValue) {
        const point = this.alignPoints[role]?.[index];
        if (String(rawValue).trim() === "") return;
        const value = Number(rawValue);
        if (!point || !["x", "y", "z"].includes(axis) || !Number.isFinite(value)) {
          return;
        }
        if (point[axis] === value) return;
        point[axis] = value;
        const label = formatAlignPointLabel({ role, index: index + 1 });
        this.alignMarkers.find((marker) => marker.name === label)?.position.copy(point);
        this.updateStatus(`Edited ${label} ${axis.toUpperCase()} to ${formatNumber(value, 3)}`);
        this.forceVisualRefresh(2);
      }

      removeAlignPointPair(index) {
        this.alignPoints.source.splice(index, 1);
        this.alignPoints.target.splice(index, 1);
        this.rebuildAlignMarkers();
        this.syncAlignUi();
        this.updateStatus(`Removed alignment point pair #${index + 1}`);
        this.forceVisualRefresh(2);
      }

      startAlignPointPick() {
        if (!this.isSparkViewportEditingAvailable()) {
          this.alignPickMode = false;
          this.syncAlignUi();
          this.updateStatus("Switch to Spark to pick alignment points in the viewport");
          return;
        }
        this.setViewportEditingMode("align");
        const role = this.dom.alignRoleSelect?.value === "target" ? "target" : "source";
        const item = this.getAlignSelection(role);
        this.updateStatus(item
          ? `Click ${item.modelMeta.name} to add ${formatAlignPointLabel({ role, index: this.alignPoints[role].length + 1 })}`
          : "Select an align splat first");
      }

      pickAlignPoint(event) {
        this.reconcileAlignPointContext();
        const role = this.dom.alignRoleSelect?.value === "target" ? "target" : "source";
        const expectedItem = this.getAlignSelection(role);
        if (!expectedItem?.mesh) {
          this.alignPickMode = false;
          this.syncAlignUi();
          this.updateStatus("Select a loaded splat before adding align points");
          return;
        }
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObjects([expectedItem.mesh], true);
        if (!hits.length) {
          this.updateStatus(`No hit on ${expectedItem.modelMeta.name}; try again`);
          this.forceVisualRefresh(1);
          return;
        }
        const point = hits[0].point.clone();
        this.alignPoints[role].push(point);
        this.addAlignMarker({ role, index: this.alignPoints[role].length, point });
        this.alignPickMode = false;
        this.syncAlignUi();
        this.updateStatus(`Added ${formatAlignPointLabel({ role, index: this.alignPoints[role].length })} at ${formatVector(point)}`);
        this.forceVisualRefresh(3);
      }

      addAlignMarker({ role, index, point }) {
        const color = role === "target" ? 0xf97316 : 0x22c55e;
        const radius = Math.max((this.sceneBoundsSphere?.radius ?? 1) * 0.012, 0.015);
        const marker = new THREE.Group();
        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(radius, 16, 12),
          new THREE.MeshBasicMaterial({ color, depthTest: false }),
        );
        marker.add(sphere);
        marker.position.copy(point);
        marker.name = formatAlignPointLabel({ role, index });
        marker.renderOrder = 20;
        this.scene.add(marker);
        this.alignMarkers.push(marker);
      }

      disposeAlignMarkers() {
        this.alignMarkers.forEach((marker) => {
          this.scene.remove(marker);
          marker.traverse((child) => {
            child.geometry?.dispose();
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach((material) => material?.dispose());
          });
        });
        this.alignMarkers = [];
      }

      rebuildAlignMarkers() {
        this.disposeAlignMarkers();
        ["source", "target"].forEach((role) => {
          this.alignPoints[role].forEach((point, index) => {
            this.addAlignMarker({ role, index: index + 1, point });
          });
        });
      }

      snapshotSceneItemTransform(item) {
        return {
          itemId: item.id,
          transform: { ...item.transform },
        };
      }

      applySceneItemTransformSnapshot(item, snapshot) {
        Object.assign(item.transform, snapshot.transform);
        item.modelRoot.position.set(
          item.transform.translateX,
          item.transform.translateY,
          item.transform.translateZ,
        );
        item.rotationPivot.rotation.set(
          THREE.MathUtils.degToRad(item.transform.rotationX),
          THREE.MathUtils.degToRad(item.transform.rotationY),
          THREE.MathUtils.degToRad(item.transform.rotationZ),
        );
        item.rotationPivot.scale.setScalar(item.transform.scale);
        item.rotationPivot.updateMatrixWorld(true);
        item.modelRoot.updateMatrixWorld(true);
      }

      refreshSceneAfterAlignTransform(item) {
        this.selectSceneItem(item.id, false);
        this.applySelectedTransformState(true);
        this.syncTransformInputs();
        this.syncVisibleSceneItemTransforms();
        this.recomputeBounds();
        this.recomputeSceneBounds();
        this.refreshHelpers();
        this.updateCameraClipping();
        this.refreshLightingModel();
        this.updateMetaUi();
        this.syncAlignUi();
        this.refreshActiveBackendSnapshot("Alignment transform updated");
        this.forceVisualRefresh(4);
      }

      resetAlignment() {
        const snapshot = this.lastAlignmentSnapshot;
        const sourceItem = snapshot
          ? this.sceneItems.find((item) => item.id === snapshot.itemId)
          : null;
        if (!sourceItem) {
          this.updateStatus("No alignment result to reset");
          this.syncAlignUi();
          return;
        }
        this.applySceneItemTransformSnapshot(sourceItem, snapshot);
        this.lastAlignmentSnapshot = null;
        this.refreshSceneAfterAlignTransform(sourceItem);
        this.updateStatus(`Reset alignment on ${sourceItem.modelMeta.name}`);
      }

      clearAlignPoints() {
        this.alignPoints = { source: [], target: [] };
        this.disposeAlignMarkers();
        this.alignPickMode = false;
        this.syncAlignUi();
        this.updateStatus("Alignment points cleared");
        this.invalidateRender();
      }

      applyAlignment() {
        this.reconcileAlignPointContext();
        const sourceItem = this.getAlignSelection("source");
        const targetItem = this.getAlignSelection("target");
        if (!sourceItem || !targetItem || sourceItem.id === targetItem.id) {
          this.updateStatus("Choose different Source and Target splats before aligning");
          return;
        }
        if (this.state.animationApplied && [sourceItem.id, targetItem.id].includes(this.activeAnimationTargetItemId)) {
          this.updateStatus("Clear the participant's animation before aligning");
          return;
        }
        try {
          const transform = computeRigidAlignment({
            sourcePoints: this.alignPoints.source,
            targetPoints: this.alignPoints.target,
          });
          const matrix4 = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(
            transform.quaternion.x,
            transform.quaternion.y,
            transform.quaternion.z,
            transform.quaternion.w,
          ));
          matrix4.scale(new THREE.Vector3(transform.scale, transform.scale, transform.scale));
          matrix4.setPosition(transform.translation.x, transform.translation.y, transform.translation.z);
          sourceItem.modelRoot.updateMatrixWorld(true);
          // The root carries translation; its child pivot carries the
          // existing rotation/scale. Compose the full editable transform.
          const nextWorld = matrix4.multiply(sourceItem.rotationPivot.matrixWorld.clone());
          const parentInverse = sourceItem.modelRoot.parent
            ? sourceItem.modelRoot.parent.matrixWorld.clone().invert()
            : new THREE.Matrix4();
          matrix4.copy(parentInverse.multiply(nextWorld));
          const translation = new THREE.Vector3();
          const quaternion = new THREE.Quaternion();
          const scaleVector = new THREE.Vector3();
          matrix4.decompose(translation, quaternion, scaleVector);
          this.lastAlignmentSnapshot = this.snapshotSceneItemTransform(sourceItem);
          sourceItem.modelRoot.position.copy(translation);
          sourceItem.rotationPivot.quaternion.copy(quaternion);
          sourceItem.rotationPivot.rotation.setFromQuaternion(quaternion, "XYZ");
          sourceItem.rotationPivot.scale.setScalar((scaleVector.x + scaleVector.y + scaleVector.z) / 3);
          sourceItem.transform.translateX = sourceItem.modelRoot.position.x;
          sourceItem.transform.translateY = sourceItem.modelRoot.position.y;
          sourceItem.transform.translateZ = sourceItem.modelRoot.position.z;
          sourceItem.transform.rotationX = THREE.MathUtils.radToDeg(sourceItem.rotationPivot.rotation.x);
          sourceItem.transform.rotationY = THREE.MathUtils.radToDeg(sourceItem.rotationPivot.rotation.y);
          sourceItem.transform.rotationZ = THREE.MathUtils.radToDeg(sourceItem.rotationPivot.rotation.z);
          sourceItem.transform.scale = sourceItem.rotationPivot.scale.x;
          this.refreshSceneAfterAlignTransform(sourceItem);
          this.updateStatus(`Aligned ${sourceItem.modelMeta.name} to ${targetItem.modelMeta.name} using ${transform.pairCount} pairs`);
        } catch (error) {
          this.updateStatus(error instanceof Error ? error.message : "Alignment failed");
        }
      }

      toggleTransformGizmo() {
        if (!this.getSelectedItem() && !this.getSelectedLight()) {
          this.updateStatus("Select a splat or light to use the gizmo");
          return;
        }
        this.state.showGizmo = !this.state.showGizmo;
        this.syncTransformGizmo();
        this.updateTransformGizmoButtons();
      }

      setTransformGizmoMode(mode) {
        this.state.transformGizmoMode = ["translate", "rotate", "scale"].includes(mode) ? mode : "translate";
        this.state.showGizmo = Boolean(this.getSelectedItem() || this.getSelectedLight());
        this.syncTransformGizmo();
        this.updateTransformGizmoButtons();
      }

      updateTransformGizmoButtons() {
        const lightSelected = Boolean(this.getSelectedLight());
        const viewportEditingAvailable = Boolean(this.getSelectedItem() || lightSelected);
        const effectiveMode = lightSelected ? "translate" : this.state.transformGizmoMode;
        const gizmoVisible = viewportEditingAvailable && this.state.showGizmo;
        this.dom.toggleGizmoButton.classList.toggle("is-active", gizmoVisible);
        this.dom.toggleGizmoButton.textContent = gizmoVisible ? "Gizmo On" : "Gizmo Off";
        if (this.dom.lightGizmoButton) {
          this.dom.lightGizmoButton.classList.toggle("is-active", gizmoVisible && lightSelected);
          this.dom.lightGizmoButton.textContent = gizmoVisible && lightSelected
            ? "Move Gizmo On"
            : "Move Gizmo Off";
          this.dom.lightGizmoButton.disabled = !viewportEditingAvailable;
        }
        this.dom.gizmoTranslateButton.classList.toggle("is-active", gizmoVisible && effectiveMode === "translate");
        this.dom.gizmoRotateButton.classList.toggle("is-active", gizmoVisible && effectiveMode === "rotate");
        this.dom.gizmoScaleButton.classList.toggle("is-active", gizmoVisible && effectiveMode === "scale");
        for (const [button, pressed] of [
          [this.dom.toggleGizmoButton, gizmoVisible],
          [this.dom.gizmoTranslateButton, gizmoVisible && effectiveMode === "translate"],
          [this.dom.gizmoRotateButton, gizmoVisible && effectiveMode === "rotate"],
          [this.dom.gizmoScaleButton, gizmoVisible && effectiveMode === "scale"],
        ]) button.setAttribute("aria-pressed", String(pressed));
        this.dom.toggleGizmoButton.disabled = !viewportEditingAvailable;
        this.dom.gizmoTranslateButton.disabled = !viewportEditingAvailable;
        this.dom.gizmoRotateButton.disabled = !viewportEditingAvailable || lightSelected;
        this.dom.gizmoScaleButton.disabled = !viewportEditingAvailable || lightSelected;
      }

      syncTransformGizmo() {
        const light = this.getSelectedLight();
        const item = this.getSelectedItem();
        if (
          !this.state.showGizmo
          || (light && !light.visible)
          || (!light && (!item || !item.visible))
        ) {
          if (this.transformControls.dragging) this.transformControls.pointerUp(null);
          this.transformControls.detach();
          this.transformControls.visible = false;
          this.transformControls.enabled = false;
          this.transformControlsHelper.visible = false;
          this.invalidateRender();
          return;
        }
        const mode = light ? "translate" : this.state.transformGizmoMode;
        const target = light
          ? light.root
          : (mode === "translate" ? item.modelRoot : item.rotationPivot);
        if (!target) {
          if (this.transformControls.dragging) this.transformControls.pointerUp(null);
          this.transformControls.detach();
          this.transformControls.visible = false;
          this.transformControls.enabled = false;
          this.transformControlsHelper.visible = false;
          return;
        }
        if (this.transformControls.dragging && (this.transformControls.object !== target || this.transformControls.mode !== mode)) {
          this.transformControls.pointerUp(null);
        }
        this.transformControls.enabled = true;
        this.transformControls.visible = true;
        this.transformControlsHelper.visible = true;
        this.transformControls.setMode(mode);
        this.transformControls.space = mode === "translate" ? "world" : "local";
        this.transformControls.attach(target);
        this.invalidateRender();
      }

      applyTransformFromGizmo() {
        const light = this.getSelectedLight();
        if (light?.root) {
          light.root.updateMatrixWorld(true);
          light.root.getWorldPosition(light.position);
          this.state.lightX = light.position.x;
          this.state.lightY = light.position.y;
          this.state.lightZ = light.position.z;
          this.syncSelectedLightControls(true);
          this.refreshLightingModel({ geometryChanged: false });
          this.lastRenderFrameAt = 0;
          this.forceVisualRefresh(4);
          return;
        }
        const item = this.getSelectedItem();
        if (!item || !item.modelRoot || !item.rotationPivot) {
          return;
        }
        this.markStaticBakeStale("Splat transform changed");
        if (this.state.transformGizmoMode === "scale") {
          // Scene transforms store one uniform scale. A Y/Z/plane handle must
          // update that scalar as well, rather than silently saving only X.
          const axis = this.transformControls.axis || "XYZ";
          const component = axis.includes("X") ? "x" : axis.includes("Y") ? "y" : "z";
          const scale = clampNumber(item.rotationPivot.scale[component], SCALE_LIMITS);
          item.rotationPivot.scale.setScalar(scale);
        }
        item.modelRoot.updateWorldMatrix(true, true);
        this.state.translateX = item.modelRoot.position.x;
        this.state.translateY = item.modelRoot.position.y;
        this.state.translateZ = item.modelRoot.position.z;
        this.state.rotationX = THREE.MathUtils.radToDeg(item.rotationPivot.rotation.x);
        this.state.rotationY = THREE.MathUtils.radToDeg(item.rotationPivot.rotation.y);
        this.state.rotationZ = THREE.MathUtils.radToDeg(item.rotationPivot.rotation.z);
        this.state.scale = item.rotationPivot.scale.x;
        item.transform.rotationX = this.state.rotationX;
        item.transform.rotationY = this.state.rotationY;
        item.transform.rotationZ = this.state.rotationZ;
        item.transform.scale = this.state.scale;
        item.transform.translateX = this.state.translateX;
        item.transform.translateY = this.state.translateY;
        item.transform.translateZ = this.state.translateZ;
        this.invalidateLightOcclusion("Splat transform changed");
        this.syncTransformInputs();
        this.syncAlignUi();
        this.syncActiveBackendItemTransforms();
        this.scheduleSelectedTransformRefresh(false, false);
        this.forceVisualRefresh(3);
      }

      scheduleSelectedTransformRefresh(announce = false, commit = false) {
        if (this.pendingTransformRefresh != null) {
          this.pendingTransformRefresh.announce = this.pendingTransformRefresh.announce || announce;
          this.pendingTransformRefresh.commit = this.pendingTransformRefresh.commit || commit;
          return;
        }
        this.pendingTransformRefresh = { announce, commit };
        requestAnimationFrame(() => {
          const refresh = this.pendingTransformRefresh;
          this.pendingTransformRefresh = null;
          if (!this.currentMesh) {
            if (refresh?.commit) {
              this.finishDeferredInteraction();
            } else {
              this.startDeferredInteraction();
            }
            return;
          }
          this.recomputeBounds();
          this.configureDepthRangeFromBounds();
          this.updatePositionModifierBounds();
          this.refreshHelpers();
          this.updateMetaUi();
          this.updateCameraClipping();
          this.syncLightingRuntimeState();
          if (this.hoverPointer) {
            this.updateHoverReadout();
          }
          this.renderPickedColors();
          if (refresh?.announce) {
            this.updateStatus(
              `Applied splat transform: rot ${this.state.rotationX.toFixed(1)} / ${this.state.rotationY.toFixed(1)} / ${this.state.rotationZ.toFixed(1)} deg, move ${this.state.translateX.toFixed(2)} / ${this.state.translateY.toFixed(2)} / ${this.state.translateZ.toFixed(2)}, scale ${this.state.scale.toFixed(2)}`,
            );
            this.updateRenderChip("Transform updated");
          }
          this.queueSparkSceneUpdate();
          if (refresh?.commit) {
            this.finishDeferredInteraction();
          } else {
            this.invalidateRender(true);
          }
        });
      }

      setSceneListLimit(value, { commit = true, syncInput = true } = {}) {
        const nextLimit = commit
          ? Math.round(clampNumber(value, { min: 3, max: 14 }))
          : Math.max(3, Math.round(Number(value) || this.state.sceneListLimit));
        this.state.sceneListLimit = nextLimit;
        if (this.dom.sceneLimitRange) {
          this.dom.sceneLimitRange.value = String(nextLimit);
        }
        if (syncInput && this.dom.sceneLimitInput) {
          this.dom.sceneLimitInput.value = String(nextLimit);
        }
        this.syncSceneList();
      }

      setSceneSelectionIndex(value, { commit = true, syncInput = true } = {}) {
        const total = this.sceneItems.length;
        const nextIndex = commit
          ? Math.round(clampNumber(value, { min: 1, max: Math.max(total, 1) }))
          : Math.max(1, Math.round(Number(value) || 1));
        if (this.dom.sceneSelectRange) {
          this.dom.sceneSelectRange.min = total ? "1" : "0";
          this.dom.sceneSelectRange.max = String(Math.max(total, 1));
          this.dom.sceneSelectRange.value = String(total ? Math.min(nextIndex, total) : 0);
          this.dom.sceneSelectRange.disabled = total <= 1;
        }
        if (syncInput && this.dom.sceneSelectInput) {
          this.dom.sceneSelectInput.value = String(total ? Math.min(nextIndex, total) : 0);
        }
        if (!total) {
          return;
        }
        const item = this.sceneItems[Math.min(Math.max(nextIndex - 1, 0), total - 1)];
        if (item) {
          this.selectSceneItem(item.id);
        }
      }

      toggleExportItem(itemId) {
        const item = this.getSceneItemById(itemId);
        if (!item) {
          return;
        }
        item.exportEnabled = !item.exportEnabled;
        this.syncExportList();
        this.updateStatus(`${item.modelMeta.name} export ${item.exportEnabled ? "enabled" : "disabled"}`);
      }

      setAllExportEnabled(enabled) {
        this.sceneItems.forEach((item) => {
          item.exportEnabled = enabled;
        });
        this.syncExportList();
        this.updateStatus(enabled ? "Enabled export for all splats" : "Disabled export for all splats");
      }

      syncExportList() {
        const exportableItems = this.sceneItems.filter((item) => item.mesh);
        const hasSelection = exportableItems.some((item) => item.exportEnabled);
        if (this.dom.saveSceneSplatsButton) this.dom.saveSceneSplatsButton.disabled = !hasSelection;
        if (this.dom.exportEnableAllButton) {
          this.dom.exportEnableAllButton.disabled = !exportableItems.some((item) => !item.exportEnabled);
        }
        if (this.dom.exportDisableAllButton) this.dom.exportDisableAllButton.disabled = !hasSelection;
        if (!this.dom.exportList || !this.dom.exportEmpty) {
          return;
        }
        this.dom.exportList.replaceChildren();
        this.dom.exportEmpty.hidden = this.sceneItems.length > 0;
        this.sceneItems.forEach((item) => {
          const row = document.createElement("div");
          row.className = `scene-item${item.exportEnabled ? " is-active" : ""}`;

          const body = document.createElement("div");
          body.className = "scene-item-main";

          const title = document.createElement("span");
          title.className = "scene-item-title";
          title.textContent = item.modelMeta.name;

          const meta = document.createElement("span");
          meta.className = "scene-item-meta";
          meta.textContent = `${item.modelMeta.splats || 0} splats`;

          body.append(title, meta);

          const toggleButton = document.createElement("button");
          toggleButton.type = "button";
          toggleButton.className = `scene-item-button${item.exportEnabled ? " is-active" : ""}`;
          toggleButton.textContent = item.exportEnabled ? "On" : "Off";
          toggleButton.title = "Toggle whether this splat will be included in export.";
          toggleButton.setAttribute("aria-label", `${item.exportEnabled ? "Exclude" : "Include"} ${item.modelMeta.name} from export`);
          toggleButton.setAttribute("aria-pressed", String(item.exportEnabled));
          toggleButton.addEventListener("click", () => this.toggleExportItem(item.id));

          row.append(body, toggleButton);
          this.dom.exportList.append(row);
        });
      }

      setGridScaleMode(mode) {
        const nextMode = ["auto", "1", "10", "100", "custom"].includes(mode) ? mode : "auto";
        this.state.gridScaleMode = nextMode;
        if (nextMode !== "auto" && nextMode !== "custom") {
          this.state.gridScaleValue = Number(nextMode);
        }
        this.syncGridControls();
        this.refreshHelpers();
      }

      setGridScaleValue(value, { commit = true, syncInput = true } = {}) {
        const parsed = commit
          ? clampNumber(value, { min: 0.01, max: 100000 })
          : Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return;
        }
        this.state.gridScaleValue = parsed;
        this.state.gridScaleMode = ["1", "10", "100"].includes(String(parsed)) ? String(parsed) : "custom";
        this.syncGridControls(syncInput);
        this.refreshHelpers();
      }

      syncGridControls(syncInput = true) {
        if (this.dom.gridScaleSelect) {
          this.dom.gridScaleSelect.value = this.state.gridScaleMode;
        }
        if (syncInput && this.dom.gridScaleInput) {
          this.dom.gridScaleInput.value = formatNumber(this.state.gridScaleValue, this.state.gridScaleValue < 10 ? 2 : 0);
        }
      }

      getAutoGridStep(gridSize) {
        if (!Number.isFinite(gridSize) || gridSize <= 4) {
          return 1;
        }
        if (gridSize <= 40) {
          return 1;
        }
        if (gridSize <= 400) {
          return 10;
        }
        return 100;
      }

      syncSceneList() {
        if (!this.dom.sceneList || !this.dom.sceneEmpty) {
          return;
        }
        this.syncOpenFileAction();
        this.dom.sceneList.replaceChildren();
        this.dom.sceneEmpty.hidden = this.sceneItems.length > 0;
        const total = this.sceneItems.length;
        const limit = Math.max(3, Math.round(this.state.sceneListLimit || 6));
        const rowHeight = 78;
        this.dom.sceneList.style.maxHeight = `${rowHeight * limit}px`;
        const selectedIndex = Math.max(this.sceneItems.findIndex((item) => item.id === this.selectedSceneItemId), 0);
        if (this.dom.sceneLimitRange) {
          this.dom.sceneLimitRange.value = String(limit);
        }
        if (this.dom.sceneLimitInput) {
          this.dom.sceneLimitInput.value = String(limit);
        }
        if (this.dom.sceneSelectRange) {
          this.dom.sceneSelectRange.min = total ? "1" : "0";
          this.dom.sceneSelectRange.max = String(Math.max(total, 1));
          this.dom.sceneSelectRange.value = String(total ? selectedIndex + 1 : 0);
          this.dom.sceneSelectRange.disabled = total <= 1;
        }
        if (this.dom.sceneSelectInput) {
          this.dom.sceneSelectInput.value = String(total ? selectedIndex + 1 : 0);
        }
        this.sceneItems.forEach((item) => {
          const row = document.createElement("div");
          row.className = "scene-item";
          if (item.id === this.selectedSceneItemId) {
            row.classList.add("is-active");
          }

          const mainButton = document.createElement("button");
          mainButton.type = "button";
          mainButton.className = "scene-item-main";
          mainButton.title = "Select this splat item.";
          mainButton.setAttribute("aria-label", `Select splat ${item.modelMeta.name}`);
          mainButton.addEventListener("click", () => this.selectSceneItem(item.id));

          const name = document.createElement("p");
          name.className = "scene-item-name";
          name.textContent = item.modelMeta.name;
          const meta = document.createElement("p");
          meta.className = "scene-item-meta";
          const splatText = item.modelMeta.splats
            ? `${item.modelMeta.splats.toLocaleString()} splats`
            : "No splats";
          meta.textContent = `${item.visible ? "Visible" : "Hidden"} / ${splatText}`;
          mainButton.append(name, meta);

          const toggleButton = document.createElement("button");
          toggleButton.type = "button";
          toggleButton.className = "scene-item-button";
          if (!item.visible) {
            toggleButton.classList.add("is-hidden");
          }
          toggleButton.textContent = item.visible ? "On" : "Off";
          toggleButton.title = "Toggle item visibility.";
          toggleButton.setAttribute("aria-label", `${item.visible ? "Hide" : "Show"} splat ${item.modelMeta.name}`);
          toggleButton.setAttribute("aria-pressed", String(item.visible));
          toggleButton.addEventListener("click", () => this.toggleSceneItemVisibility(item.id));

          const deleteButton = document.createElement("button");
          deleteButton.type = "button";
          deleteButton.className = "scene-item-button";
          deleteButton.textContent = "Delete";
          deleteButton.title = "Delete this splat item from the scene.";
          deleteButton.setAttribute("aria-label", `Delete splat ${item.modelMeta.name}`);
          deleteButton.addEventListener("click", () => this.removeSceneItem(item.id));

          row.append(mainButton, toggleButton, deleteButton);
          this.dom.sceneList.append(row);
        });
        this.syncExportList();
      }

      syncLightList() {
        if (!this.dom.lightList || !this.dom.lightEmpty) {
          return;
        }
        this.syncOpenFileAction();
        this.dom.lightList.replaceChildren();
        this.dom.lightEmpty.hidden = this.sceneLights.length > 0;
        this.sceneLights.forEach((light) => {
          const row = document.createElement("div");
          row.className = "scene-item";
          row.dataset.lightId = light.id;
          if (light.id === this.selectedLightId) {
            row.classList.add("is-active");
          }

          const mainButton = document.createElement("button");
          mainButton.type = "button";
          mainButton.className = "scene-item-main";
          mainButton.title = "Select this light.";
          mainButton.setAttribute("aria-label", `Select light ${light.name}`);
          mainButton.addEventListener("click", () => this.selectLight(light.id));

          const name = document.createElement("p");
          name.className = "scene-item-name";
          name.textContent = light.name;

          const meta = document.createElement("p");
          meta.className = "scene-item-meta";
          meta.textContent =
            `${light.visible ? "On" : "Off"} / I ${formatNumber(light.intensity, light.intensity < 10 ? 2 : 1)}`;
          mainButton.append(name, meta);

          const toggleButton = document.createElement("button");
          toggleButton.type = "button";
          toggleButton.className = "scene-item-button";
          if (!light.visible) {
            toggleButton.classList.add("is-hidden");
          }
          toggleButton.textContent = light.visible ? "On" : "Off";
          toggleButton.title = "Toggle this light.";
          toggleButton.setAttribute("aria-label", `${light.visible ? "Hide" : "Show"} light ${light.name}`);
          toggleButton.setAttribute("aria-pressed", String(light.visible));
          toggleButton.addEventListener("click", () => this.toggleLightVisibility(light.id));

          const deleteButton = document.createElement("button");
          deleteButton.type = "button";
          deleteButton.className = "scene-item-button";
          deleteButton.textContent = "Delete";
          deleteButton.title = "Delete this light.";
          deleteButton.setAttribute("aria-label", `Delete light ${light.name}`);
          deleteButton.addEventListener("click", () => this.removeLight(light.id));

          row.append(mainButton, toggleButton, deleteButton);
          this.dom.lightList.append(row);
        });
      }

      syncLightListIntensity(light) {
        const row = Array.from(this.dom.lightList?.children ?? [])
          .find((entry) => entry.dataset.lightId === light.id);
        const meta = row?.querySelector(".scene-item-meta");
        if (meta) {
          meta.textContent = `${light.visible ? "On" : "Off"} / I ${formatNumber(light.intensity, light.intensity < 10 ? 2 : 1)}`;
        }
      }

      addPointLight() {
        const type = this.dom.lightTypeSelect.value;
        const light = this.createLightRecord(type);
        light.position.copy(this.camera.position);
        if (type !== 'point') light.rotation.copy(this.camera.rotation);
        this.updateLightVisual(light);
        this.sceneLights.push(light);
        this.selectLight(light.id, false);
        this.syncLightList();
        this.refreshLightingModel({ forceModifierRebuild: true, geometryChanged: false });
        this.updateStatus(`Added ${light.name}`);
      }

      toggleLightVisibility(lightId) {
        const light = this.sceneLights.find((entry) => entry.id === lightId);
        if (!light) {
          return;
        }
        light.visible = !light.visible;
        this.updateLightVisual(light);
        this.syncLightList();
        this.syncTransformGizmo();
        this.refreshLightingModel({ geometryChanged: false });
        this.updateStatus(`${light.name} ${light.visible ? "shown" : "hidden"}`);
      }

      removeLight(lightId) {
        const index = this.sceneLights.findIndex((entry) => entry.id === lightId);
        if (index < 0) {
          return;
        }
        const [light] = this.sceneLights.splice(index, 1);
        this.lightSceneRoot.remove(light.root);
        light.root.traverse?.((child) => {
          child.geometry?.dispose?.();
          child.material?.dispose?.();
        });
        const wasSelected = light.id === this.selectedLightId;
        if (wasSelected) {
          const nextLight = this.sceneLights[index] || this.sceneLights[index - 1] || null;
          this.selectedLightId = nextLight?.id ?? null;
        }
        this.syncSelectedLightControls(true);
        this.syncLightList();
        this.syncTransformGizmo();
        this.updateTransformGizmoButtons();
        this.refreshLightingModel({ forceModifierRebuild: true, geometryChanged: false });
        this.updateStatus(`Removed ${light.name}`);
      }

      applySelectedLightIntensity(updateStatus = true, syncInput = true) {
        const light = this.getSelectedLight();
        const intensity = clampNumber(this.state.lightIntensity, LIGHT_INTENSITY_LIMITS);
        this.state.lightIntensity = intensity;
        if (this.dom.lightIntensityRange) {
          this.dom.lightIntensityRange.value = String(Math.min(intensity, 100));
        }
        if (syncInput && this.dom.lightIntensityInput) {
          this.dom.lightIntensityInput.value = intensity.toFixed(intensity < 10 ? 2 : 1);
        }
        if (!light) {
          return;
        }
        light.intensity = intensity;
        this.updateLightVisual(light);
        // Preserve pressed/focused list buttons when an input blur commits.
        this.syncLightListIntensity(light);
        this.refreshLightingModel({ occlusionChanged: false });
        if (updateStatus) {
          this.updateStatus(`${light.name} intensity updated`);
        }
      }

      applySelectedLightHelperScale(updateStatus = true, syncInput = true) {
        const light = this.getSelectedLight();
        const helperScale = clampNumber(this.state.lightHelperScale, LIGHT_HELPER_SCALE_LIMITS);
        this.state.lightHelperScale = helperScale;
        if (this.dom.lightHelperScaleRange) {
          this.dom.lightHelperScaleRange.value = String(helperScale);
        }
        if (syncInput && this.dom.lightHelperScaleInput) {
          this.dom.lightHelperScaleInput.value = formatNumber(helperScale, 2);
        }
        if (!light) {
          return;
        }
        light.helperScale = helperScale;
        this.updateLightVisual(light);
        this.invalidateRender();
        if (updateStatus) {
          this.updateStatus(`${light.name} helper size updated`);
        }
      }

      setSelectedLightHelperScale(value, { commit = true, syncInput = true } = {}) {
        this.state.lightHelperScale = commit ? clampNumber(value, LIGHT_HELPER_SCALE_LIMITS) : Number(value);
        if (!Number.isFinite(this.state.lightHelperScale)) {
          return;
        }
        this.applySelectedLightHelperScale(true, syncInput);
        if (commit) {
          this.finishDeferredInteraction();
        } else {
          this.startDeferredInteraction();
        }
      }

      setSelectedLightIntensity(value, { commit = true, syncInput = true } = {}) {
        this.state.lightIntensity = commit ? clampNumber(value, LIGHT_INTENSITY_LIMITS) : Number(value);
        this.applySelectedLightIntensity(true, syncInput);
        if (commit) {
          this.finishDeferredInteraction();
        } else {
          this.startDeferredInteraction();
        }
      }

      applySelectedLightColor(commit = false) {
        const light = this.getSelectedLight();
        const color = clampLightColor({
          r: commit ? clampNumber(this.dom.lightRInput?.value ?? this.state.lightR, LIGHT_COLOR_COMPONENT_LIMITS) : this.dom.lightRInput?.value,
          g: commit ? clampNumber(this.dom.lightGInput?.value ?? this.state.lightG, LIGHT_COLOR_COMPONENT_LIMITS) : this.dom.lightGInput?.value,
          b: commit ? clampNumber(this.dom.lightBInput?.value ?? this.state.lightB, LIGHT_COLOR_COMPONENT_LIMITS) : this.dom.lightBInput?.value,
        });
        this.state.lightR = color.r;
        this.state.lightG = color.g;
        this.state.lightB = color.b;
        if (light) {
          light.color = { ...color };
          this.updateLightVisual(light);
          this.refreshLightingModel({ occlusionChanged: false });
        }
        if (commit) {
          this.syncSelectedLightControls(true);
          this.finishDeferredInteraction();
        } else {
          this.startDeferredInteraction();
        }
      }

      applySelectedLightPosition(commit = false) {
        const light = this.getSelectedLight();
        const xRaw = this.dom.lightXInput?.value?.trim() ?? "0";
        const yRaw = this.dom.lightYInput?.value?.trim() ?? "0";
        const zRaw = this.dom.lightZInput?.value?.trim() ?? "0";
        this.state.lightX = commit
          ? clampNumber(xRaw, LIGHT_POSITION_LIMITS)
          : (Number.isFinite(Number(xRaw)) ? Number(xRaw) : this.state.lightX);
        this.state.lightY = commit
          ? clampNumber(yRaw, LIGHT_POSITION_LIMITS)
          : (Number.isFinite(Number(yRaw)) ? Number(yRaw) : this.state.lightY);
        this.state.lightZ = commit
          ? clampNumber(zRaw, LIGHT_POSITION_LIMITS)
          : (Number.isFinite(Number(zRaw)) ? Number(zRaw) : this.state.lightZ);
        if (light) {
          light.position.set(this.state.lightX, this.state.lightY, this.state.lightZ);
          this.updateLightVisual(light);
          if (this.transformControls.object === light.root) {
            this.transformControls.attach(light.root);
          }
          this.refreshLightingModel({ geometryChanged: false });
          if (commit) {
            this.finishDeferredInteraction();
          } else {
            this.startDeferredInteraction();
          }
        }
        if (commit) {
          this.syncSelectedLightControls(true);
        }
      }

      applySelectedLightShape(commit = false) {
        const light = this.getSelectedLight();
        if (!light) return;
        ['x','y','z'].forEach(axis => {
          const value = Number(this.dom[`lightR${axis}Input`].value);
          if (Number.isFinite(value)) light.rotation[axis] = THREE.MathUtils.degToRad(Math.max(-360, Math.min(360, value)));
        });
        for (const key of ['width','height']) {
          const value = Number(this.dom[`light${key[0].toUpperCase()+key.slice(1)}Input`].value);
          if (Number.isFinite(value)) light[key] = Math.max(0.001, Math.min(10000, value));
        }
        this.updateLightVisual(light);
        this.refreshLightingModel({ geometryChanged: false });
        if (commit) { this.syncSelectedLightControls(true); this.finishDeferredInteraction(); }
        else this.startDeferredInteraction();
      }

      getLightSamples() {
        return expandLightSamples(this.sceneLights);
      }

      collectLightOccluderSamples() {
        const visibleItems = this.sceneItems.filter((item) => item.visible && item.mesh);
        if (!visibleItems.length) {
          return [];
        }
        const perItemBudget = Math.max(1, Math.floor(LIGHT_OCCLUDER_LIMIT / visibleItems.length));
        const itemSamples = [];
        visibleItems.forEach((item) => {
          const sourceEntries = item.hoverEntries?.length
            ? item.hoverEntries
            : (this.createMeshHoverEntries(item, perItemBudget * 12) || []);
          if (!sourceEntries.length) {
            return;
          }
          const step = Math.max(1, Math.ceil(sourceEntries.length / perItemBudget));
          const samples = [];
          for (let index = 0; index < sourceEntries.length && samples.length < LIGHT_OCCLUDER_LIMIT; index += step) {
            const entry = sourceEntries[index];
            const radius = Math.max(
              Number(entry.scale?.x ?? 0.05) || 0.05,
              Number(entry.scale?.y ?? 0.05) || 0.05,
              Number(entry.scale?.z ?? 0.05) || 0.05,
            );
            samples.push({
              baseLinearRgb: toLinearRgbArray(entry.color),
              itemId: item.id,
              localNormal: entry.localNormal?.clone?.() ?? null,
              localPosition: entry.position.clone(),
              ordinal: index,
              opacity: THREE.MathUtils.clamp(Number(entry.alpha ?? 1) || 0, 0, 1),
              radius,
              sourceSampleCount: sourceEntries.length,
            });
            if (samples.length >= perItemBudget) {
              break;
            }
          }
          if (samples.length) {
            itemSamples.push(samples);
          }
        });
        // Interleave scene items so a later occluder (for example a Cube cast
        // onto a previously loaded target) is represented in the fixed GPU set.
        const samples = [];
        for (let sampleIndex = 0; samples.length < LIGHT_OCCLUDER_LIMIT; sampleIndex += 1) {
          let added = false;
          itemSamples.forEach((entries) => {
            if (samples.length < LIGHT_OCCLUDER_LIMIT && entries[sampleIndex]) {
              samples.push(entries[sampleIndex]);
              added = true;
            }
          });
          if (!added) {
            break;
          }
        }
        return samples;
      }

      syncLightingRuntimeState() {
        this.syncVisibleSceneItemTransforms();
        this.lightSceneRoot.updateMatrixWorld(true);
        this.sceneLights.forEach(light => {
          light.root.updateWorldMatrix(true, false);
          light.root.getWorldPosition(light.position);
        });
        const activeLights = this.getLightSamples();
        this.runtimeLightSamples = activeLights;
        this.activeLightCount = activeLights.length;
        this.ensureDynoHandleArray(this.lightHandles.types, this.activeLightCount,
          index => dynoFloat(0, `viewerLightType${index}`));
        this.ensureDynoHandleArray(this.lightHandles.directions, this.activeLightCount,
          index => dynoVec3(new THREE.Vector3(0,0,-1), `viewerLightDirection${index}`));
        this.ensureDynoHandleArray(
          this.lightHandles.positions,
          this.activeLightCount,
          (index) => dynoVec3(new THREE.Vector3(), `viewerLightPosition${index}`),
        );
        this.ensureDynoHandleArray(
          this.lightHandles.intensities,
          this.activeLightCount,
          (index) => dynoFloat(0, `viewerLightIntensity${index}`),
        );
        this.ensureDynoHandleArray(
          this.lightHandles.colorR,
          this.activeLightCount,
          (index) => dynoFloat(DEFAULT_LIGHT_COLOR.r, `viewerLightColorR${index}`),
        );
        this.ensureDynoHandleArray(
          this.lightHandles.colorG,
          this.activeLightCount,
          (index) => dynoFloat(DEFAULT_LIGHT_COLOR.g, `viewerLightColorG${index}`),
        );
        this.ensureDynoHandleArray(
          this.lightHandles.colorB,
          this.activeLightCount,
          (index) => dynoFloat(DEFAULT_LIGHT_COLOR.b, `viewerLightColorB${index}`),
        );
        const lightWorldPosition = new THREE.Vector3();
        activeLights.forEach((light, index) => {
          lightWorldPosition.fromArray(lightVector(light.position));
          this.lightHandles.types[index].value = lightTypeCode(light);
          this.lightHandles.directions[index].value.fromArray(lightVector(light.direction));
          const lightColor = clampLightColor(light.color ?? DEFAULT_LIGHT_COLOR);
          this.lightHandles.positions[index].value.copy(lightWorldPosition);
          this.lightHandles.intensities[index].value = light.intensity;
          this.lightHandles.colorR[index].value = lightColor.r;
          this.lightHandles.colorG[index].value = lightColor.g;
          this.lightHandles.colorB[index].value = lightColor.b;
        });
        const needsLegacyCandidates = this.state.legacySampledShadow || this.state.oneBouncePreview;
        this.lightOccluderSamples = needsLegacyCandidates ? this.collectLightOccluderSamples() : [];
        const worldScale = new THREE.Vector3();
        const worldCandidates = this.lightOccluderSamples.flatMap((sample) => {
          const item = this.getSceneItemById(sample.itemId);
          if (!item?.mesh) {
            return [];
          }
          item.mesh.updateMatrixWorld(true);
          worldScale.setFromMatrixScale(item.mesh.matrixWorld);
          const radiusScale = Math.max(
            Math.abs(worldScale.x),
            Math.abs(worldScale.y),
            Math.abs(worldScale.z),
          );
          const itemOpacity = THREE.MathUtils.clamp(Number(item.settings?.opacity ?? 1) || 0, 0, 1);
          const sampleOpacity = THREE.MathUtils.clamp(Number(sample.opacity) || 0, 0, 1);
          if (!(itemOpacity > 0) || !(sampleOpacity > 0)) {
            return [];
          }
          const surfaceRadius = Math.max((Number(sample.radius) || 0) * radiusScale, 0);
          const beautyExposureScale = this.getBeautyExposureScaleForItem(item);
          return [{
            baseLinearRgb: sample.baseLinearRgb.map(
              (value) => Math.max((Number(value) || 0) * beautyExposureScale, 0),
            ),
            hasAuthoredNormal: item.hasAuthoredSplatNormals,
            itemId: sample.itemId,
            opacity: sampleOpacity * itemOpacity,
            normal: this.getSampleWorldNormal(item, sample),
            ordinal: sample.ordinal,
            position: sample.localPosition.clone().applyMatrix4(item.mesh.matrixWorld),
            radius: surfaceRadius,
            sourceSampleCount: sample.sourceSampleCount,
            stableId: `${sample.itemId}:${sample.ordinal}`,
            surfaceRadius,
          }];
        });
        const slotCount = Math.min(LIGHT_SHADOW_GPU_SLOT_LIMIT, worldCandidates.length);
        const selectedCandidates = Array.from({ length: slotCount }, (_, slotIndex) => {
          const candidateIndex = Math.min(
            Math.floor(((slotIndex + 0.5) * worldCandidates.length) / slotCount),
            worldCandidates.length - 1,
          );
          return worldCandidates[candidateIndex];
        });
        const selectedCountByItem = new Map();
        selectedCandidates.forEach((candidate) => {
          selectedCountByItem.set(
            candidate.itemId,
            (selectedCountByItem.get(candidate.itemId) || 0) + 1,
          );
        });
        this.runtimeLightOccluders = this.state.legacySampledShadow
          ? selectedCandidates.map((candidate) => ({
            ...candidate,
            radius: computeSampledGaussianProxyRadius({
              selectedSampleCount: selectedCountByItem.get(candidate.itemId),
              sourceSampleCount: candidate.sourceSampleCount,
              worldRadius: candidate.radius,
            }),
          }))
          : [];
        this.activeOccluderCount = this.runtimeLightOccluders.length;
        this.ensureDynoHandleArray(
          this.lightHandles.occluderPositions,
          this.activeOccluderCount,
          (index) => dynoVec3(new THREE.Vector3(), `viewerLightOccluderPosition${index}`),
        );
        this.ensureDynoHandleArray(
          this.lightHandles.occluderRadii,
          this.activeOccluderCount,
          (index) => dynoFloat(0, `viewerLightOccluderRadius${index}`),
        );
        this.ensureDynoHandleArray(
          this.lightHandles.occluderOpacities,
          this.activeOccluderCount,
          (index) => dynoFloat(0, `viewerLightOccluderOpacity${index}`),
        );
        this.runtimeLightOccluders.forEach((occluder, index) => {
          this.lightHandles.occluderPositions[index].value.copy(occluder.position);
          this.lightHandles.occluderRadii[index].value = occluder.radius;
          this.lightHandles.occluderOpacities[index].value = occluder.opacity;
        });
        const firstVisibleLight = activeLights[0] ?? null;
        const vplCandidates = selectedCandidates.map((candidate) => ({
          ...candidate,
          visibility: firstVisibleLight
            ? this.evaluateLightTransmission(firstVisibleLight.position, candidate.position, candidate.itemId)
            : 0,
        }));
        this.runtimeOneBounceVpls = selectOneBounceVpls({
          candidates: vplCandidates,
          enabled: this.state.oneBouncePreview,
          light: firstVisibleLight,
        });
        this.activeOneBounceVplCount = this.runtimeOneBounceVpls.length;
        for (let vplIndex = 0; vplIndex < ONE_BOUNCE_VPL_LIMIT; vplIndex += 1) {
          const vpl = this.runtimeOneBounceVpls[vplIndex];
          const position = vpl?.position ?? [0, 0, 0];
          const normal = vpl?.normal ?? [0, 0, 1];
          const flux = vpl?.flux ?? [0, 0, 0];
          this.lightHandles.oneBouncePositions[vplIndex].value.set(position[0], position[1], position[2]);
          this.lightHandles.oneBounceNormals[vplIndex].value.set(normal[0], normal[1], normal[2]);
          this.lightHandles.oneBounceRadii[vplIndex].value = vpl?.radius ?? 0;
          this.lightHandles.oneBounceFluxR[vplIndex].value = flux[0];
          this.lightHandles.oneBounceFluxG[vplIndex].value = flux[1];
          this.lightHandles.oneBounceFluxB[vplIndex].value = flux[2];
        }
      }

      refreshLightingModel({ forceModifierRebuild = false, occlusionChanged = true, geometryChanged = true } = {}) {
        if (this.sceneLights.some(light => light.visible && light.type !== 'point')) {
          this.state.legacySampledShadow = false;
          this.state.oneBouncePreview = false;
          this.syncLegacySampledShadowUi();
          this.syncOneBouncePreviewUi();
        }
        this.markStaticBakeStale("Light, opacity, transform, or visibility changed");
        if (occlusionChanged) this.invalidateLightOcclusion("Light or geometry changed", { geometryChanged });
        const previousLightCount = this.activeLightCount;
        const previousOccluderCount = this.activeOccluderCount;
        this.syncLightingRuntimeState();
        this.syncStaticBakeUi();
        const needsRebuild = forceModifierRebuild
          || previousLightCount !== this.activeLightCount
          || previousOccluderCount !== this.activeOccluderCount;
        if (needsRebuild) {
          this.applyRenderMode(false);
          this.queueSparkSceneUpdate();
          this.refreshActiveBackendSnapshot("Lighting updated", { appearanceOnly: !geometryChanged || !occlusionChanged });
          return;
        }
        if (this.hoverPointer) {
          this.updateHoverReadout();
        }
        this.renderPickedColors();
        this.invalidateRender();
        this.forceVisualRefresh(2);
        this.queueSparkSceneUpdate();
        this.refreshActiveBackendSnapshot("Lighting updated", { appearanceOnly: !geometryChanged || !occlusionChanged });
      }

      getSceneExposureScale() {
        return this.getGlobalExposureScale();
      }

      getItemExposureScale(item) {
        return this.getRenderModeForItem(item) === "beauty"
          ? this.getBeautyExposureScaleForItem(item)
          : 1;
      }

      getSceneItemById(itemId) {
        return this.sceneItems.find((item) => item.id === itemId) || null;
      }

      setHoverChip(itemText, colorText) {
        if (this.dom.hoverChipItem && this.dom.hoverChipColor) {
          this.dom.hoverChipItem.textContent = `Item ${itemText}`;
          this.dom.hoverChipColor.textContent = `Color ${colorText}`;
          return;
        }
        this.hoverReadout = `Item ${itemText} | Color ${colorText}`;
        if (this.dom.hoverChip) {
          this.dom.hoverChip.textContent = this.hoverReadout;
        }
      }

      syncColorPickButton() {
        if (!this.dom.pickColorButton) {
          return;
        }
        this.dom.pickColorButton.classList.toggle("is-active", this.isColorPickMode);
        this.dom.pickColorButton.textContent = this.isColorPickMode ? "Click In View" : "Pick Hovered";
        this.dom.stage?.classList.toggle("is-picking", this.isColorPickMode);
      }

      startColorPickMode() {
        this.setViewportEditingMode("color");
        this.updateStatus("Color picker active. Left-click the 3D view to confirm.");
      }

      stopColorPickMode() {
        this.isColorPickMode = false;
        this.syncColorPickButton();
      }

      setViewportEditingMode(mode) {
        // One left-click must belong to one tool. Finish any stroke before
        // changing ownership so its geometry changes keep their undo entry.
        this.endBrushStroke();
        this.brushEnabled = mode === "brush";
        this.alignPickMode = mode === "align";
        this.isColorPickMode = mode === "color";
        this.syncBrushUi(false);
        this.syncAlignUi();
        this.syncColorPickButton();
      }

      getSplatLocalNormal(splat) {
        const scales = splat?.scales ?? splat?.scale;
        const scaleX = Number(scales?.x ?? 0) || 0;
        const scaleY = Number(scales?.y ?? 0) || 0;
        const scaleZ = Number(scales?.z ?? 0) || 0;
        const normal = new THREE.Vector3();
        if (scaleZ <= scaleX && scaleZ <= scaleY) {
          normal.set(0, 0, 1);
        } else if (scaleY <= scaleX) {
          normal.set(0, 1, 0);
        } else {
          normal.set(1, 0, 0);
        }
        return splat?.quaternion
          ? normal.applyQuaternion(splat.quaternion).normalize()
          : normal;
      }

      createMeshHoverEntries(item, maxEntries = 4096) {
        const packedSplats = item?.mesh?.packedSplats;
        const count = Number(item?.mesh?.numSplats ?? packedSplats?.numSplats ?? 0);
        if (!packedSplats || !count) {
          return null;
        }
        const entries = [];
        const step = Math.max(1, Math.floor(count / Math.max(maxEntries, 1)));
        for (let index = 0; index < count; index += step) {
          const splat = packedSplats.getSplat
            ? packedSplats.getSplat(index)
            : unpackSplat(packedSplats.packedArray, index, item.mesh.packedSplats?.splatEncoding);
          const center = splat?.center ?? splat?.position;
          const scales = splat?.scales ?? splat?.scale;
          if (!center) {
            continue;
          }
          entries.push({
            alpha: Number(splat.opacity ?? splat.alpha ?? splat.rgba?.w ?? splat.rgba?.a ?? 1) || 0,
            color: sourceColorToLinear(splat.color ?? splat.rgb ?? splat.rgba, item.sourceColorSpace),
            label: `Splat ${index + 1}`,
            localNormal: this.getSplatLocalNormal(splat),
            position: new THREE.Vector3(center.x, center.y, center.z),
            scale: new THREE.Vector3(
              Number(scales?.x ?? 0.05) || 0.05,
              Number(scales?.y ?? 0.05) || 0.05,
              Number(scales?.z ?? 0.05) || 0.05,
            ),
            splatIndex: index,
          });
        }
        return entries;
      }

      getVisibleMeshHitsFromPointer(pointer = this.hoverPointer) {
        if (!pointer) {
          return [];
        }
        this.pointer.set(pointer.x, pointer.y);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        return this.raycaster.intersectObjects(
          this.sceneItems.filter((item) => item.visible && item.mesh).map((item) => item.mesh),
          true,
        );
      }

      getTopHoverHit(pointer = this.hoverPointer) {
        const hits = this.getVisibleMeshHitsFromPointer(pointer);
        if (!hits.length) {
          return null;
        }
        hits.sort((left, right) => left.distance - right.distance);
        const hit = hits[0];
        const sceneItemId = hit.object?.userData?.sceneItemId ?? hit.object?.parent?.userData?.sceneItemId;
        if (!sceneItemId) {
          return null;
        }
        const sceneItem = this.getSceneItemById(sceneItemId);
        if (!sceneItem) {
          return null;
        }
        return { hit, sceneItem };
      }

      resolvePrimitiveHoverSample(item, worldPoint) {
        if (!item?.hoverEntries?.length || !item.mesh) {
          return null;
        }
        const localPoint = worldPoint
          .clone()
          .applyMatrix4(item.mesh.matrixWorld.clone().invert());
        let bestEntry = null;
        let bestDistance = Infinity;
        item.hoverEntries.forEach((entry, index) => {
          const distanceSq = localPoint.distanceToSquared(entry.position);
          if (distanceSq < bestDistance) {
            bestDistance = distanceSq;
            bestEntry = { entry, index };
          }
        });
        if (!bestEntry) {
          return null;
        }
        return {
          alpha: Number(bestEntry.entry.alpha ?? 1) || 0,
          baseLinearRgb: toLinearRgbArray(bestEntry.entry.color),
          itemId: item.id,
          label: bestEntry.entry.label || `Splat ${bestEntry.index + 1}`,
          localNormal: bestEntry.entry.localNormal?.clone?.(),
          localPosition: bestEntry.entry.position.clone(),
          splatIndex: bestEntry.entry.splatIndex ?? bestEntry.index,
        };
      }

      resolvePrimitivePointerSample(item, pointer) {
        if (!item?.hoverEntries?.length || !item.mesh || !pointer) {
          return null;
        }
        const worldPosition = new THREE.Vector3();
        const viewPosition = new THREE.Vector3();
        const ndcPosition = new THREE.Vector3();
        let bestEntry = null;
        let bestDistance = Infinity;
        let bestDepth = Infinity;
        item.hoverEntries.forEach((entry, index) => {
          worldPosition.copy(entry.position).applyMatrix4(item.mesh.matrixWorld);
          viewPosition.copy(worldPosition).applyMatrix4(this.camera.matrixWorldInverse);
          if (viewPosition.z >= 0) {
            return;
          }
          ndcPosition.copy(worldPosition).project(this.camera);
          const distanceSq = ((ndcPosition.x - pointer.x) ** 2) + ((ndcPosition.y - pointer.y) ** 2);
          const depth = -viewPosition.z;
          if (distanceSq < bestDistance - 1e-8 || (Math.abs(distanceSq - bestDistance) <= 1e-8 && depth < bestDepth)) {
            bestDistance = distanceSq;
            bestDepth = depth;
            bestEntry = { entry, index };
          }
        });
        if (!bestEntry) {
          return null;
        }
        return {
          alpha: Number(bestEntry.entry.alpha ?? 1) || 0,
          baseLinearRgb: toLinearRgbArray(bestEntry.entry.color),
          itemId: item.id,
          label: bestEntry.entry.label || `Splat ${bestEntry.index + 1}`,
          localNormal: bestEntry.entry.localNormal?.clone?.(),
          localPosition: bestEntry.entry.position.clone(),
          screenDistanceSq: bestDistance,
          splatIndex: bestEntry.entry.splatIndex ?? bestEntry.index,
          viewDepth: bestDepth,
        };
      }

      resolvePackedHoverSample(item, worldPoint) {
        const packedSplats = item?.mesh?.packedSplats;
        const count = Number(item?.mesh?.numSplats ?? packedSplats?.numSplats ?? 0);
        if (!packedSplats || !count) {
          return null;
        }
        const inverseMatrix = item.mesh.matrixWorld.clone().invert();
        const localPoint = worldPoint.clone().applyMatrix4(inverseMatrix);
        let bestIndex = -1;
        let bestSplat = null;
        let bestDistance = Infinity;
        for (let index = 0; index < count; index += 1) {
          const splat = packedSplats.getSplat
            ? packedSplats.getSplat(index)
            : unpackSplat(packedSplats.packedArray, index, item.mesh.packedSplats?.splatEncoding);
          const center = splat?.center ?? splat?.position;
          if (!center) {
            continue;
          }
          const distanceSq = localPoint.distanceToSquared(
            new THREE.Vector3(center.x, center.y, center.z),
          );
          if (distanceSq < bestDistance) {
            bestDistance = distanceSq;
            bestIndex = index;
            bestSplat = splat;
          }
        }
        if (!bestSplat || bestIndex < 0) {
          return null;
        }
        // Public decoders reuse a scratch object; fetch the winner again
        // after scanning instead of retaining the last decoded splat.
        bestSplat = this.getPackedSplatAt(item, bestIndex);
        return {
          alpha: Number(bestSplat.opacity ?? bestSplat.alpha ?? bestSplat.rgba?.w ?? bestSplat.rgba?.a ?? 1) || 0,
          baseLinearRgb: sourceColorToLinear(bestSplat.color ?? bestSplat.rgb ?? bestSplat.rgba, item.sourceColorSpace),
          itemId: item.id,
          label: `Splat ${bestIndex + 1}`,
          localNormal: this.getSplatLocalNormal(bestSplat),
          localPosition: new THREE.Vector3(
            bestSplat.center?.x ?? bestSplat.position?.x ?? 0,
            bestSplat.center?.y ?? bestSplat.position?.y ?? 0,
            bestSplat.center?.z ?? bestSplat.position?.z ?? 0,
          ),
          splatIndex: bestIndex,
        };
      }

      resolvePackedPointerSample(item, pointer) {
        const packedSplats = item?.mesh?.packedSplats;
        const count = Number(item?.mesh?.numSplats ?? packedSplats?.numSplats ?? 0);
        if (!packedSplats || !count || !pointer) {
          return null;
        }
        const worldPosition = new THREE.Vector3();
        const viewPosition = new THREE.Vector3();
        const ndcPosition = new THREE.Vector3();
        let bestIndex = -1;
        let bestSplat = null;
        let bestDistance = Infinity;
        let bestDepth = Infinity;
        for (let index = 0; index < count; index += 1) {
          const splat = packedSplats.getSplat
            ? packedSplats.getSplat(index)
            : unpackSplat(packedSplats.packedArray, index, item.mesh.packedSplats?.splatEncoding);
          const center = splat?.center ?? splat?.position;
          if (!center) {
            continue;
          }
          worldPosition.set(center.x, center.y, center.z).applyMatrix4(item.mesh.matrixWorld);
          viewPosition.copy(worldPosition).applyMatrix4(this.camera.matrixWorldInverse);
          if (viewPosition.z >= 0) {
            continue;
          }
          ndcPosition.copy(worldPosition).project(this.camera);
          const distanceSq = ((ndcPosition.x - pointer.x) ** 2) + ((ndcPosition.y - pointer.y) ** 2);
          const depth = -viewPosition.z;
          if (distanceSq < bestDistance - 1e-8 || (Math.abs(distanceSq - bestDistance) <= 1e-8 && depth < bestDepth)) {
            bestDistance = distanceSq;
            bestDepth = depth;
            bestIndex = index;
            bestSplat = splat;
          }
        }
        if (!bestSplat || bestIndex < 0) {
          return null;
        }
        bestSplat = this.getPackedSplatAt(item, bestIndex);
        return {
          alpha: Number(bestSplat.opacity ?? bestSplat.alpha ?? bestSplat.rgba?.w ?? bestSplat.rgba?.a ?? 1) || 0,
          baseLinearRgb: sourceColorToLinear(bestSplat.color ?? bestSplat.rgb ?? bestSplat.rgba, item.sourceColorSpace),
          itemId: item.id,
          label: `Splat ${bestIndex + 1}`,
          localNormal: this.getSplatLocalNormal(bestSplat),
          localPosition: new THREE.Vector3(
            bestSplat.center?.x ?? bestSplat.position?.x ?? 0,
            bestSplat.center?.y ?? bestSplat.position?.y ?? 0,
            bestSplat.center?.z ?? bestSplat.position?.z ?? 0,
          ),
          screenDistanceSq: bestDistance,
          splatIndex: bestIndex,
          viewDepth: bestDepth,
        };
      }

      resolveColorSampleFromHit(item, worldPoint) {
        if (!item?.mesh || !worldPoint) {
          return null;
        }
        return this.resolvePrimitiveHoverSample(item, worldPoint)
          ?? this.resolvePackedHoverSample(item, worldPoint);
      }

      resolveColorSampleFromPointer(pointer) {
        if (!pointer) {
          return null;
        }
        let bestSample = null;
        this.sceneItems.forEach((item) => {
          if (!item.visible || !item.mesh) {
            return;
          }
          const sample = item.hoverEntries?.length
            ? this.resolvePrimitivePointerSample(item, pointer)
            : this.resolvePackedPointerSample(item, pointer);
          if (!sample) {
            return;
          }
          if (
            !bestSample
            || sample.screenDistanceSq < bestSample.screenDistanceSq - 1e-8
            || (
              Math.abs(sample.screenDistanceSq - bestSample.screenDistanceSq) <= 1e-8
              && sample.viewDepth < bestSample.viewDepth
            )
          ) {
            bestSample = sample;
          }
        });
        return bestSample;
      }

      resolveCurrentPickSample() {
        const liveHit = this.getTopHoverHit();
        if (liveHit) {
          this.lastHoverHit = {
            itemId: liveHit.sceneItem.id,
            point: liveHit.hit.point.clone(),
          };
          return this.resolveColorSampleFromHit(liveHit.sceneItem, liveHit.hit.point);
        }
        if (!this.lastHoverHit) {
          return null;
        }
        const item = this.getSceneItemById(this.lastHoverHit.itemId);
        if (!item?.mesh) {
          return null;
        }
        return this.resolveColorSampleFromHit(item, this.lastHoverHit.point);
      }

      getSampleWorldPosition(item, sample) {
        if (!item?.mesh || !sample?.localPosition) {
          return null;
        }
        return sample.localPosition.clone().applyMatrix4(item.mesh.matrixWorld);
      }

      getSampleWorldNormal(item, sample) {
        if (!item?.mesh || !sample?.localPosition) {
          return null;
        }
        let localNormal = sample.localNormal?.clone?.() ?? null;
        const authoredNormal = item.hasAuthoredSplatNormals && Number.isInteger(sample.splatIndex)
          ? item.authoredNormalEntries?.[sample.splatIndex]?.normal : null;
        if (authoredNormal) {
          localNormal = authoredNormal.clone();
        } else if (item.hasAuthoredSplatNormals) {
          let closestDistanceSq = Infinity;
          item.authoredNormalEntries?.forEach((entry) => {
            if (!entry?.normal || !entry?.position) {
              return;
            }
            const distanceSq = sample.localPosition.distanceToSquared(entry.position);
            if (distanceSq < closestDistanceSq) {
              closestDistanceSq = distanceSq;
              localNormal = entry.normal.clone();
            }
          });
        }
        return localNormal?.transformDirection(item.mesh.matrixWorld) ?? null;
      }

      evaluateLightTransmission(lightPosition, targetPosition, sourceItemId = null) {
        // Keep same-item samples: endpoint bias rejects adjacent receiver
        // splats while samples farther along the segment can self-shadow.
        void sourceItemId;
        return evaluateSampledLightTransmission({
          lightPosition,
          occluders: this.runtimeLightOccluders,
          receiverPosition: targetPosition,
        });
      }

      getCachedLightTransmission(item, sample, lightId) {
        const cache = item.lightOcclusion;
        if (!cache?.enabled.value || !Number.isInteger(sample.splatIndex)) return null;
        const lightIndex = cache.lightIds.indexOf(lightId);
        if (lightIndex < 0 || sample.splatIndex < 0 || sample.splatIndex >= cache.count.value) return null;
        return cache.data[sample.splatIndex * cache.lightIds.length + lightIndex];
      }

      getDisplayLinearColorForSample(item, sample, appearanceContext = null) {
        if (!item || !sample) {
          return [0, 0, 0];
        }
        const itemMode = this.getRenderModeForItem(item);
        const splatExposureScale = itemMode === "beauty" ? this.getBeautyExposureScaleForItem(item) : 1;
        const toneCurve = item.settings?.toneCurve ?? buildToneCurveState();
        const linear = sample.baseLinearRgb.map((value) => Math.max(value * splatExposureScale, 0));
        if (itemMode !== "beauty" || !this.sceneLights.length || this.staticBakeApplied) {
          return applyToneCurveToLinearRgb(linear, toneCurve);
        }
        const worldPosition = this.getSampleWorldPosition(item, sample);
        const worldNormal = this.getSampleWorldNormal(item, sample);
        if (!worldPosition || !worldNormal) {
          return applyToneCurveToLinearRgb(linear, toneCurve);
        }
        const normalPolicy = item.hasAuthoredSplatNormals
          ? DIRECT_LIGHT_NORMAL_POLICY.AUTHORED_ONE_SIDED
          : DIRECT_LIGHT_NORMAL_POLICY.IMPORTED_COVARIANCE_FACE_FORWARD;
        const cameraPosition = appearanceContext?.cameraPosition
          ?? this.camera.getWorldPosition(new THREE.Vector3());
        const receiverNormal = orientDirectLightNormal({
          cameraPosition,
          normal: worldNormal,
          normalPolicy,
          position: worldPosition,
        });
        let firstVisibleLight = true;
        const directLinear = applyDirectLighting({
          baseLinearRgb: linear,
          lights: (this.runtimeLightSamples ?? this.getLightSamples()).map((light) => {
            const isFirstVisibleLight = light.visible && firstVisibleLight;
            if (isFirstVisibleLight) {
              firstVisibleLight = false;
            }
            return {
              type: light.type, direction: light.direction,
              color: light.color,
              intensity: light.intensity,
              position: light.position,
              visibility: (this.getCachedLightTransmission(item, sample, light.id) ?? 1) * (isFirstVisibleLight
                ? this.evaluateLightTransmission(light.position, worldPosition, item.id)
                : 1),
              visible: light.visible,
            };
          }),
          cameraPosition,
          normal: worldNormal,
          normalPolicy,
          position: worldPosition,
        });
        const directAndBounceLinear = applyOneBouncePreview({
          baseLinearRgb: linear,
          enabled: this.state.oneBouncePreview,
          normal: receiverNormal,
          position: worldPosition,
          vpls: this.runtimeOneBounceVpls,
        }).map((value, index) => directLinear[index] + (value - linear[index]));
        return applyToneCurveToLinearRgb(directAndBounceLinear, toneCurve);
      }

      getPickedColorDisplay(entry) {
        const item = this.getSceneItemById(entry.itemId);
        if (!item) {
          return null;
        }
        const displayLinear = this.getDisplayLinearColorForSample(item, entry);
        const displayAlpha = Math.max(entry.alpha * (item.settings.opacity ?? 1), 0);
        return {
          alpha: displayAlpha,
          item,
          linear: displayLinear,
          srgb: linearRgbToSrgb8(displayLinear),
        };
      }

      renderPickedColors() {
        if (!this.dom.pickedColorsList || !this.dom.pickedColorsEmpty) {
          return;
        }
        this.dom.pickedColorsList.replaceChildren();
        const validEntries = this.pickedColors
          .map((entry) => ({ entry, display: this.getPickedColorDisplay(entry) }))
          .filter(({ display }) => display);
        this.dom.pickedColorsEmpty.hidden = validEntries.length > 0;
        validEntries.forEach(({ entry, display }) => {
          const row = document.createElement("div");
          row.className = "picked-color-row";

          const swatch = document.createElement("div");
          swatch.className = "picked-color-swatch";
          swatch.style.background = `rgb(${display.srgb[0]}, ${display.srgb[1]}, ${display.srgb[2]})`;

          const body = document.createElement("div");
          body.className = "picked-color-body";

          const title = document.createElement("p");
          title.className = "picked-color-title";
          title.textContent = `${display.item.modelMeta.name} / ${entry.label}`;

          const meta = document.createElement("p");
          meta.className = "picked-color-meta";
          meta.textContent =
            `sRGB ${formatSrgbColor(display.linear)}\n` +
            `linear ${formatLinearColor(display.linear)}\n` +
            `alpha ${display.alpha.toFixed(display.alpha < 10 ? 2 : 1)}`;

          body.append(title, meta);

          const removeButton = document.createElement("button");
          removeButton.type = "button";
          removeButton.className = "scene-item-button";
          removeButton.textContent = "Remove";
          removeButton.title = "Remove this picked color.";
          removeButton.addEventListener("click", () => this.removePickedColor(entry.id));

          row.append(swatch, body, removeButton);
          this.dom.pickedColorsList.append(row);
        });
      }

      removePickedColor(entryId) {
        this.pickedColors = this.pickedColors.filter((entry) => entry.id !== entryId);
        this.renderPickedColors();
      }

      removePickedColorsForItem(itemId) {
        const previousLength = this.pickedColors.length;
        this.pickedColors = this.pickedColors.filter((entry) => entry.itemId !== itemId);
        if (this.pickedColors.length !== previousLength) {
          this.renderPickedColors();
        }
      }

      clearPickedColors() {
        this.pickedColors = [];
        this.renderPickedColors();
        this.updateStatus("Cleared picked splat colors");
      }

      syncLutUi() {
        const hasLut = Boolean(this.state.loadedLut);
        const hasSelectedItem = Boolean(this.getSelectedItem());
        if (this.dom.lutApplySelectedButton) {
          this.dom.lutApplySelectedButton.disabled = !hasLut || !hasSelectedItem;
        }
        if (this.dom.lutStatus) {
          const inputSpace = this.dom.lutInputColorSpaceSelect?.selectedOptions?.[0]?.textContent ?? "Linear sRGB";
          const outputSpace = this.dom.lutOutputColorSpaceSelect?.selectedOptions?.[0]?.textContent ?? "Linear sRGB";
          this.dom.lutStatus.textContent = hasLut
            ? `Loaded ${summarizeCubeLut(this.state.loadedLut)}. Workspace is linear sRGB; before LUT: ${inputSpace}, after LUT: ${outputSpace}.`
            : "No LUT loaded.";
        }
      }

      async loadLutFile(file) {
        if (!file) {
          return;
        }
        try {
          const text = await file.text();
          this.state.loadedLut = parseCubeLut(text);
          this.state.loadedLutName = file.name || this.state.loadedLut.title || "LUT";
          this.syncLutUi();
          this.updateStatus(`Loaded LUT ${this.state.loadedLutName}`);
        } catch (error) {
          this.state.loadedLut = null;
          this.state.loadedLutName = "";
          this.syncLutUi();
          this.updateStatus(error instanceof Error ? error.message : "Failed to load LUT");
        } finally {
          if (this.dom.lutFileInput) {
            this.dom.lutFileInput.value = "";
          }
        }
      }

      markSplatStorageNeedsUpdate(splats) {
        if (!splats) {
          return;
        }
        splats.needsUpdate = true;
        splats.source?.image && (splats.source.needsUpdate = true);
        if (Array.isArray(splats.textures)) {
          splats.textures.forEach((texture) => {
            if (texture) {
              texture.needsUpdate = true;
            }
          });
        }
        splats.updateTextures?.();
        splats.disposeLodSplats?.();
      }

      applyLoadedLutToSelectedSplat() {
        if (this.staticBakeApplied || this.staticBakeApplying) {
          if (this.staticBakeApplying) this.markStaticBakeStale("LUT appearance edit requested");
          this.updateStatus("Clear / Restore the static bake before applying a LUT");
          return;
        }
        const lut = this.state.loadedLut;
        const item = this.getSelectedItem();
        const splats = item?.mesh?.splats ?? item?.mesh?.extSplats ?? item?.mesh?.packedSplats;
        const count = Number(splats?.numSplats ?? item?.mesh?.numSplats ?? 0);
        if (!lut) {
          this.updateStatus("Load a 3D .cube LUT first");
          return;
        }
        if (!item || !splats?.getSplat || !splats?.setSplat || !count) {
          this.updateStatus("No editable selected splat item is available");
          return;
        }
        const inputColorSpace = this.dom.lutInputColorSpaceSelect?.value ?? "linear-srgb";
        const outputColorSpace = this.dom.lutOutputColorSpaceSelect?.value ?? "linear-srgb";
        const color = new THREE.Color();
        let changed = 0;
        for (let index = 0; index < count; index += 1) {
          const splat = splats.getSplat(index);
          const baseLinear = sourceColorToLinear(splat.color ?? splat.rgb ?? splat.rgba, item.sourceColorSpace);
          const nextLinear = applyCubeLutToLinearRgb(baseLinear, lut, { inputColorSpace, outputColorSpace });
          color.setRGB(...linearColorToSource(nextLinear, item.sourceColorSpace));
          splats.setSplat(index, splat.center, splat.scales, splat.quaternion, splat.opacity, color);
          changed += 1;
        }
        this.markSplatStorageNeedsUpdate(splats);
        item.mesh.updateGenerator?.();
        item.hoverEntries = this.createMeshHoverEntries(item);
        this.renderPickedColors();
        if (this.hoverPointer) {
          this.updateHoverReadout();
        }
        this.invalidateRender();
        this.forceVisualRefresh(3);
        this.queueSparkSceneUpdate();
        this.refreshActiveBackendSnapshot("LUT applied");
        this.updateStatus(`Applied ${summarizeCubeLut(lut)} to ${changed.toLocaleString()} splats in ${item.modelMeta.name}`);
      }

      pickHoveredColor({ fromPointerClick = false } = {}) {
        const sample = this.resolveCurrentPickSample()
          ?? this.resolveColorSampleFromPointer(this.hoverPointer ?? this.lastHoverPointer);
        if (!sample) {
          if (fromPointerClick) {
            this.stopColorPickMode();
          }
          this.updateStatus("No hovered splat is available to pick");
          return;
        }
        const existing = this.pickedColors.find((entry) =>
          entry.itemId === sample.itemId
            && entry.splatIndex === sample.splatIndex
            && entry.label === sample.label);
        if (existing) {
          this.pickedColors = [existing, ...this.pickedColors.filter((entry) => entry.id !== existing.id)];
          this.renderPickedColors();
          if (fromPointerClick) {
            this.stopColorPickMode();
          }
          this.updateStatus(`Updated picked color from ${existing.label}`);
          return;
        }
        this.pickedColors.unshift({
          alpha: sample.alpha,
          baseLinearRgb: sample.baseLinearRgb.slice(),
          id: `picked-color-${++this.pickedColorSerial}`,
          itemId: sample.itemId,
          label: sample.label,
          localNormal: sample.localNormal?.clone?.() ?? null,
          localPosition: sample.localPosition?.clone?.() ?? null,
          splatIndex: sample.splatIndex,
        });
        this.renderPickedColors();
        if (fromPointerClick) {
          this.stopColorPickMode();
        }
        this.updateStatus(`Picked ${sample.label}`);
      }

      bindCommitInputs(inputs, onChange) {
        inputs.filter(Boolean).forEach((input) => {
          input.addEventListener("input", () => onChange(false));
          input.addEventListener("blur", () => onChange(true));
          input.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            input.blur();
          });
        });
      }

      bindNumberPair({ input, range, limits, onChange }) {
        // A wrapping label names only its first control. Name both members of
        // a slider/input pair from the same live label, including mode changes.
        const label = input?.closest(".field")?.querySelector(":scope > span");
        if (label && input.id) {
          label.id ||= `${input.id}-label`;
          input.setAttribute("aria-labelledby", label.id);
          range?.setAttribute("aria-labelledby", label.id);
        }
        const getLimits = () => (typeof limits === "function" ? limits() : limits);
        range?.addEventListener("input", (event) => onChange(event.target.value, {
          commit: false,
          limits: getLimits(),
          syncInput: true,
        }));
        range?.addEventListener("change", (event) => onChange(event.target.value, {
          commit: true,
          limits: getLimits(),
          syncInput: true,
        }));
        input?.addEventListener("input", (event) => {
          const rawValue = event.target.value.trim();
          if (isIntermediateNumericInput(rawValue)) {
            return;
          }
          const parsed = Number(rawValue);
          if (!Number.isFinite(parsed)) {
            return;
          }
          onChange(parsed, {
            commit: false,
            limits: getLimits(),
            syncInput: false,
          });
        });
        input?.addEventListener("blur", (event) => onChange(event.target.value, {
          commit: true,
          limits: getLimits(),
          syncInput: true,
        }));
        input?.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            // Blur owns the commit; invoking it here too doubles downstream work.
            event.target.blur();
          }
        });
      }

      commitActiveField() {
        const active = document.activeElement;
        if (!active || active === document.body) {
          return;
        }
        if (active === this.dom.fileInput) {
          return;
        }
        if (active instanceof HTMLElement && active.matches("input, select, textarea")) {
          active.blur();
        }
      }

      applyBackground() {
        this.renderer.setClearColor(BACKGROUNDS[this.state.background] || BACKGROUNDS.graphite);
        this.renderActiveBackendFrame();
        this.invalidateRender();
      }

      applyOpacity(updateChip = true, syncInput = true) {
        const opacity = clampNumber(this.state.opacity, OPACITY_LIMITS);
        this.state.opacity = opacity;
        if (this.dom.opacityRange) {
          this.dom.opacityRange.value = String(Math.min(opacity, 2));
        }
        if (syncInput) {
          this.dom.opacityInput.value = opacity.toFixed(2);
        }
        const item = this.getSelectedItem();
        if (item) {
          item.settings.opacity = opacity;
          if (item.mesh) {
            item.mesh.opacity = opacity;
          }
          this.modelMeta = item.modelMeta;
        }
        if (updateChip) {
          this.updateRenderChip("Opacity updated");
        }
        this.refreshLightingModel();
        this.refreshActiveBackendSnapshot("Opacity updated");
        this.renderPickedColors();
        this.invalidateRender();
      }

      setOpacity(value, { commit = true, syncInput = true } = {}) {
        this.state.opacity = commit ? clampNumber(value, OPACITY_LIMITS) : Number(value);
        this.applyOpacity(true, syncInput);
        if (commit) {
          this.finishDeferredInteraction();
        } else {
          this.startDeferredInteraction();
        }
      }

      applyFalloff(updateChip = true, syncInput = true) {
        this.markStaticBakeStale("Appearance falloff changed");
        const falloff = clampNumber(this.state.falloff, FALLOFF_LIMITS);
        this.state.falloff = falloff;
        if (this.dom.falloffRange) {
          this.dom.falloffRange.value = String(falloff);
        }
        if (syncInput) {
          this.dom.falloffInput.value = falloff.toFixed(2);
        }
        this.spark.falloff = falloff;
        if (this.sparkSettings) {
          this.sparkSettings.falloff = falloff;
          const input = document.getElementById("renderer-spark-falloff");
          if (input) input.value = String(falloff);
        }
        const item = this.getSelectedItem();
        this.sceneItems.forEach((sceneItem) => {
          sceneItem.settings.falloff = falloff;
        });
        if (item) {
          this.modelMeta = item.modelMeta;
        }
        if (updateChip) {
          this.updateRenderChip("Falloff updated");
        }
        this.renderPickedColors();
        this.invalidateRender();
      }

      setFalloff(value, { commit = true, syncInput = true } = {}) {
        this.state.falloff = commit ? clampNumber(value, FALLOFF_LIMITS) : Number(value);
        this.applyFalloff(true, syncInput);
        if (commit) {
          this.finishDeferredInteraction();
        } else {
          this.startDeferredInteraction();
        }
      }

      triggerBrowserDownload(fileName, buffer) {
        const blob = new Blob([buffer], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        anchor.style.display = "none";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      async writeFileToDirectory(directoryHandle, fileName, buffer) {
        const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(new Uint8Array(buffer));
        await writable.close();
      }

      getPackedSplatCount(item) {
        return Number(item?.mesh?.numSplats ?? item?.mesh?.packedSplats?.numSplats ?? 0);
      }

      getPackedSplatAt(item, index) {
        const packedSplats = item?.mesh?.packedSplats;
        if (!packedSplats) {
          return null;
        }
        return packedSplats.getSplat
          ? packedSplats.getSplat(index)
          : unpackSplat(packedSplats.packedArray, index, item.mesh.packedSplats?.splatEncoding);
      }

      cloneSplatGeometryState(splat) {
        const center = splat?.center ?? splat?.position;
        const scales = splat?.scales ?? splat?.scale;
        if (!center || !scales) {
          return null;
        }
        return {
          center: new THREE.Vector3(
            Number(center.x ?? center[0] ?? 0) || 0,
            Number(center.y ?? center[1] ?? 0) || 0,
            Number(center.z ?? center[2] ?? 0) || 0,
          ),
          scales: new THREE.Vector3(
            Math.max(Number(scales.x ?? scales[0] ?? 0.0001) || 0.0001, 0.0001),
            Math.max(Number(scales.y ?? scales[1] ?? 0.0001) || 0.0001, 0.0001),
            Math.max(Number(scales.z ?? scales[2] ?? 0.0001) || 0.0001, 0.0001),
          ),
        };
      }

      getEditableSplatStorage(item) {
        return item?.mesh?.splats ?? item?.mesh?.extSplats ?? item?.mesh?.packedSplats ?? null;
      }

      writeSplatGeometry(item, index, center, scales, sourceSplat = this.getPackedSplatAt(item, index)) {
        if (this.staticBakeApplied || this.staticBakeApplying) {
          if (this.staticBakeApplying) this.markStaticBakeStale("Splat geometry edit requested");
          this.updateStatus("Clear / Restore the static bake before editing splat geometry");
          return false;
        }
        const splats = this.getEditableSplatStorage(item);
        if (!item?.mesh || !splats || !sourceSplat || !center || !scales) {
          return false;
        }
        if (splats.getSplat && splats.setSplat) {
          const colorArray = toLinearRgbArray(sourceSplat.color ?? sourceSplat.rgb ?? sourceSplat.rgba);
          const color = new THREE.Color(colorArray[0], colorArray[1], colorArray[2]);
          const alpha = Number(sourceSplat.opacity ?? sourceSplat.alpha ?? sourceSplat.rgba?.w ?? sourceSplat.rgba?.a ?? 1) || 0;
          splats.setSplat(index, center, scales, this.getSplatQuaternion(sourceSplat), alpha, color);
          return true;
        }
        const packedSplats = item.mesh.packedSplats;
        const packedArray = packedSplats?.packedArray;
        if (packedArray && setPackedSplatCenter && setPackedSplatScales) {
          setPackedSplatCenter(packedArray, index, center.x, center.y, center.z);
          setPackedSplatScales(packedArray, index, scales.x, scales.y, scales.z, packedSplats.splatEncoding);
          return true;
        }
        return false;
      }

      setBrushRadius(value, { commit = true, syncInput = true } = {}) {
        this.state.brushRadius = commit ? clampNumber(value, BRUSH_RADIUS_LIMITS) : Number(value);
        this.syncBrushUi(syncInput);
        this.refreshBrushOverlay();
      }

      setBrushStrength(value, { commit = true, syncInput = true } = {}) {
        this.state.brushStrength = commit ? clampNumber(value, BRUSH_STRENGTH_LIMITS) : Number(value);
        this.syncBrushUi(syncInput);
        this.refreshBrushOverlay();
      }

      setBrushScale(value, { commit = true, syncInput = true } = {}) {
        this.state.brushScale = commit ? clampNumber(value, BRUSH_SCALE_LIMITS) : Number(value);
        this.syncBrushUi(syncInput);
        this.refreshBrushOverlay();
      }

      setBrushDepthLimit(value, { commit = true, syncInput = true } = {}) {
        this.state.brushDepthLimit = commit ? clampNumber(value, BRUSH_DEPTH_LIMITS) : Number(value);
        this.syncBrushUi(syncInput);
        this.refreshBrushOverlay();
      }

      setBrushUndoLimit(value, { commit = true, syncInput = true } = {}) {
        const nextLimit = commit
          ? Math.round(clampNumber(value, BRUSH_UNDO_LIMITS))
          : Math.max(BRUSH_UNDO_LIMITS.min, Math.round(Number(value) || this.state.brushUndoLimit));
        this.state.brushUndoLimit = nextLimit;
        this.trimBrushUndoStack();
        this.syncBrushUi(syncInput);
      }

      resetBrushSettings() {
        Object.assign(this.state, DEFAULT_BRUSH_SETTINGS);
        this.syncBrushUi(true);
        this.refreshBrushOverlay();
        this.updateStatus("Brush settings reset");
      }

      getBrushModeLabel() {
        if (this.state.brushMode === "standard") {
          return "Standard";
        }
        if (this.state.brushMode === "scale") {
          return "Scale";
        }
        return "Move";
      }

      trimBrushUndoStack() {
        const limit = Math.round(clampNumber(this.state.brushUndoLimit, BRUSH_UNDO_LIMITS));
        this.brushUndoStack = (this.brushUndoStack ?? []).slice(-limit);
        this.lastBrushUndo = this.brushUndoStack[this.brushUndoStack.length - 1] ?? null;
      }

      syncBrushUi(syncInput = true) {
        const item = this.getSelectedItem();
        const viewportEditingAvailable = this.isSparkViewportEditingAvailable();
        const editable = Boolean(viewportEditingAvailable && item?.mesh && this.getEditableSplatStorage(item));
        if (!editable) {
          this.brushEnabled = false;
          this.brushStroke = null;
        }
        if (this.dom.brushModeSelect) {
          this.dom.brushModeSelect.value = this.state.brushMode;
        }
        if (this.dom.brushRadiusRange) {
          this.dom.brushRadiusRange.value = String(Math.min(clampNumber(this.state.brushRadius, BRUSH_RADIUS_LIMITS), 5));
        }
        if (syncInput && this.dom.brushRadiusInput) {
          this.dom.brushRadiusInput.value = formatNumber(this.state.brushRadius, this.state.brushRadius < 1 ? 2 : 1);
        }
        if (this.dom.brushStrengthRange) {
          this.dom.brushStrengthRange.value = String(THREE.MathUtils.clamp(clampNumber(this.state.brushStrength, BRUSH_STRENGTH_LIMITS), -2, 2));
        }
        if (syncInput && this.dom.brushStrengthInput) {
          this.dom.brushStrengthInput.value = formatNumber(this.state.brushStrength, 2);
        }
        if (this.dom.brushRelativeCheckbox) {
          this.dom.brushRelativeCheckbox.checked = Boolean(this.state.brushRelativeToSplatSize);
        }
        if (this.dom.brushDepthRange) {
          this.dom.brushDepthRange.value = String(Math.min(clampNumber(this.state.brushDepthLimit, BRUSH_DEPTH_LIMITS), 5));
        }
        if (syncInput && this.dom.brushDepthInput) {
          this.dom.brushDepthInput.value = formatNumber(this.state.brushDepthLimit, this.state.brushDepthLimit < 1 ? 2 : 1);
        }
        if (this.dom.brushScaleRange) {
          this.dom.brushScaleRange.value = String(Math.min(clampNumber(this.state.brushScale, BRUSH_SCALE_LIMITS), 2));
        }
        if (syncInput && this.dom.brushScaleInput) {
          this.dom.brushScaleInput.value = formatNumber(this.state.brushScale, 2);
        }
        if (this.dom.brushUndoLimitRange) {
          this.dom.brushUndoLimitRange.value = String(Math.round(clampNumber(this.state.brushUndoLimit, BRUSH_UNDO_LIMITS)));
        }
        if (syncInput && this.dom.brushUndoLimitInput) {
          this.dom.brushUndoLimitInput.value = String(Math.round(clampNumber(this.state.brushUndoLimit, BRUSH_UNDO_LIMITS)));
        }
        if (this.dom.brushToggleButton) {
          this.dom.brushToggleButton.disabled = !editable;
          this.dom.brushToggleButton.classList.toggle("is-active", this.brushEnabled);
          this.dom.brushToggleButton.textContent = this.brushEnabled ? "Brush On" : "Brush Off";
        }
        if (this.dom.brushUndoButton) {
          this.dom.brushUndoButton.disabled = !this.brushUndoStack?.length;
          this.dom.brushUndoButton.textContent = this.brushUndoStack?.length
            ? `Undo Stroke (${this.brushUndoStack.length})`
            : "Undo Stroke";
        }
        this.setSectionDisabled(this.dom.brushControlsSection, !editable, [
          this.dom.brushToggleButton,
          this.dom.brushUndoButton,
          this.dom.brushResetButton,
        ]);
        if (this.dom.brushStatus) {
          this.dom.brushStatus.textContent = !viewportEditingAvailable
            ? "Brush viewport editing is available in Spark."
            : editable
            ? (this.brushEnabled
              ? `${this.getBrushModeLabel()} brush active. Move changes position only, Standard pushes along camera Z, Scale changes size only.`
              : "Brush is off. Enable it, then left-drag in the viewport.")
            : "Select a splat item before brushing.";
        }
        this.dom.stage?.classList.toggle("is-brushing", this.brushEnabled);
        if (!this.brushEnabled || !editable) {
          this.hideBrushOverlay();
        }
      }

      toggleBrushEditing() {
        if (!this.isSparkViewportEditingAvailable()) {
          this.updateStatus("Switch to Spark to use the viewport brush");
          this.syncBrushUi(true);
          return;
        }
        const item = this.getSelectedItem();
        if (!item?.mesh || !this.getEditableSplatStorage(item)) {
          this.updateStatus("Select an editable splat item before brushing");
          this.syncBrushUi(true);
          return;
        }
        this.setViewportEditingMode(this.brushEnabled ? null : "brush");
        this.updateStatus(this.brushEnabled ? "Brush editing enabled" : "Brush editing disabled");
      }

      getBrushPointer(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        return {
          x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
          y: -(((event.clientY - rect.top) / rect.height) * 2 - 1),
        };
      }

      getBrushHit(event) {
        const pointer = this.getBrushPointer(event);
        this.hoverPointer = pointer;
        this.lastHoverPointer = { ...pointer };
        const liveHit = this.getTopHoverHit(pointer);
        if (liveHit) {
          const sample = this.resolveColorSampleFromHit(liveHit.sceneItem, liveHit.hit.point);
          if (sample) {
            return { item: liveHit.sceneItem, sample, worldPoint: liveHit.hit.point.clone() };
          }
        }
        const sample = this.resolveColorSampleFromPointer(pointer);
        const item = sample ? this.getSceneItemById(sample.itemId) : null;
        return item && sample ? { item, sample, worldPoint: this.getSampleWorldPosition(item, sample) } : null;
      }

      createBrushRing(color, opacity = 1) {
        const points = [];
        for (let index = 0; index <= BRUSH_OVERLAY_SEGMENTS; index += 1) {
          const angle = (index / BRUSH_OVERLAY_SEGMENTS) * Math.PI * 2;
          points.push(new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0));
        }
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({
          color,
          depthTest: false,
          depthWrite: false,
          opacity,
          transparent: true,
          toneMapped: false,
        });
        const line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        line.renderOrder = 1000;
        return line;
      }

      createBrushOverlay() {
        if (this.brushOverlayGroup) {
          return;
        }
        this.brushOverlayGroup = new THREE.Group();
        this.brushOverlayGroup.name = "Brush Influence Overlay";
        this.brushOverlayGroup.visible = false;
        this.brushRadiusRing = this.createBrushRing(0xffffff, 0.92);
        this.brushInfluenceRing = this.createBrushRing(0x65d6ff, 0.72);
        this.brushDepthFrontRing = this.createBrushRing(0xffc857, 0.46);
        this.brushDepthBackRing = this.createBrushRing(0xff7a59, 0.46);
        const influenceGeometry = new THREE.BufferGeometry();
        influenceGeometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(BRUSH_OVERLAY_POINT_LIMIT * 3), 3));
        influenceGeometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(BRUSH_OVERLAY_POINT_LIMIT * 3), 3));
        influenceGeometry.setAttribute("size", new THREE.Float32BufferAttribute(new Float32Array(BRUSH_OVERLAY_POINT_LIMIT), 1));
        influenceGeometry.setDrawRange(0, 0);
        this.brushInfluencePoints = new THREE.Points(
          influenceGeometry,
          new THREE.ShaderMaterial({
            depthTest: false,
            depthWrite: false,
            transparent: true,
            toneMapped: false,
            uniforms: { opacity: { value: 0.34 } },
            vertexColors: true,
            // ShaderMaterial injects the color attribute when vertex colors are enabled.
            vertexShader: `
              attribute float size;
              varying vec3 vColor;
              void main() {
                vColor = color;
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = clamp(size * (320.0 / max(-mvPosition.z, 0.001)), 2.0, 22.0);
                gl_Position = projectionMatrix * mvPosition;
              }
            `,
            fragmentShader: `
              uniform float opacity;
              varying vec3 vColor;
              void main() {
                vec2 delta = gl_PointCoord - vec2(0.5);
                float distanceFromCenter = length(delta);
                if (distanceFromCenter > 0.5) {
                  discard;
                }
                float edge = 1.0 - smoothstep(0.32, 0.5, distanceFromCenter);
                gl_FragColor = vec4(vColor, opacity * edge);
              }
            `,
          }),
        );
        this.brushInfluencePoints.frustumCulled = false;
        this.brushInfluencePoints.renderOrder = 1001;
        this.brushOverlayGroup.add(
          this.brushDepthBackRing,
          this.brushDepthFrontRing,
          this.brushInfluenceRing,
          this.brushRadiusRing,
          this.brushInfluencePoints,
        );
        this.scene.add(this.brushOverlayGroup);
      }

      hideBrushOverlay() {
        if (this.brushOverlayGroup) {
          this.brushOverlayGroup.visible = false;
        }
        this.lastBrushHit = null;
        this.invalidateRender();
      }

      getBrushWorldScale(item) {
        if (!item?.mesh) {
          return 1;
        }
        const worldScale = new THREE.Vector3();
        item.modelRoot?.updateMatrixWorld(true);
        item.rotationPivot?.updateMatrixWorld(true);
        item.mesh.updateMatrixWorld(true);
        item.mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), worldScale);
        return Math.max((Math.abs(worldScale.x) + Math.abs(worldScale.y) + Math.abs(worldScale.z)) / 3, 0.0001);
      }

      getBrushRadiusWorld(item) {
        return clampNumber(this.state.brushRadius, BRUSH_RADIUS_LIMITS) * this.getBrushWorldScale(item);
      }

      worldDistanceToLocalDistance(item, worldDistance) {
        return Number(worldDistance) / this.getBrushWorldScale(item);
      }

      localDistanceToWorldDistance(item, localDistance) {
        return Number(localDistance) * this.getBrushWorldScale(item);
      }

      getSplatAverageScale(geometry) {
        return Math.max((geometry.scales.x + geometry.scales.y + geometry.scales.z) / 3, 0.0001);
      }

      getSplatAverageScaleWorld(item, geometry) {
        return this.localDistanceToWorldDistance(item, this.getSplatAverageScale(geometry));
      }

      positionBrushRing(ring, centerWorld, radiusWorld, depthOffsetWorld = 0) {
        if (!ring || !centerWorld) {
          return;
        }
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward).normalize();
        ring.position.copy(centerWorld).addScaledVector(forward, depthOffsetWorld);
        ring.quaternion.copy(this.camera.quaternion);
        ring.scale.setScalar(Math.max(radiusWorld, 0.0001));
        ring.visible = radiusWorld > 0;
      }

      updateBrushOverlay(hit, { invalidate = true } = {}) {
        this.createBrushOverlay();
        if (!this.brushEnabled || !hit?.item || !hit.worldPoint) {
          this.hideBrushOverlay();
          return;
        }
        const depthLimit = clampNumber(this.state.brushDepthLimit, BRUSH_DEPTH_LIMITS);
        const worldScale = this.getBrushWorldScale(hit.item);
        const radiusWorld = this.getBrushRadiusWorld(hit.item);
        const depthWorld = depthLimit * worldScale;
        this.brushOverlayGroup.visible = true;
        this.positionBrushRing(this.brushRadiusRing, hit.worldPoint, radiusWorld, 0);
        this.positionBrushRing(this.brushInfluenceRing, hit.worldPoint, radiusWorld * 0.5, 0);
        this.positionBrushRing(this.brushDepthFrontRing, hit.worldPoint, radiusWorld, -depthWorld);
        this.positionBrushRing(this.brushDepthBackRing, hit.worldPoint, radiusWorld, depthWorld);
        this.brushDepthFrontRing.visible = depthWorld > 0;
        this.brushDepthBackRing.visible = depthWorld > 0;
        this.updateBrushInfluencePointOverlay(hit);
        this.lastBrushHit = hit;
        if (invalidate) {
          this.invalidateRender();
        }
      }

      updateBrushOverlayFromEvent(event) {
        const hit = this.getBrushHit(event);
        if (!hit?.item || hit.item.id !== this.selectedSceneItemId) {
          this.hideBrushOverlay();
          return;
        }
        this.updateBrushOverlay(hit);
      }

      refreshBrushOverlay() {
        if (this.brushEnabled && this.lastBrushHit) {
          this.updateBrushOverlay(this.lastBrushHit);
        }
      }

      getBrushDepthLimitWorld(item) {
        return clampNumber(this.state.brushDepthLimit, BRUSH_DEPTH_LIMITS) * this.getBrushWorldScale(item);
      }

      getBrushInfluenceFalloff(center, radius, localCenter) {
        const distance = localCenter.distanceTo(center);
        if (radius <= 0 || distance > radius) {
          return 0;
        }
        return (1 - (distance / radius)) ** 2;
      }

      getBrushInfluenceFalloffWorld(item, centerWorld, radiusWorld, localCenter, targetWorld = new THREE.Vector3()) {
        if (!item?.mesh || !centerWorld || radiusWorld <= 0) {
          return 0;
        }
        targetWorld.copy(localCenter).applyMatrix4(item.mesh.matrixWorld);
        const distanceWorld = targetWorld.distanceTo(centerWorld);
        if (distanceWorld > radiusWorld) {
          return 0;
        }
        return (1 - (distanceWorld / radiusWorld)) ** 2;
      }

      updateBrushInfluencePointOverlay(hit) {
        if (!this.brushInfluencePoints || !hit?.item || !hit.sample) {
          return;
        }
        const item = hit.item;
        const count = this.getPackedSplatCount(item);
        const center = hit.sample.localPosition.clone();
        const radiusWorld = this.getBrushRadiusWorld(item);
        const centerWorld = hit.worldPoint ?? center.clone().applyMatrix4(item.mesh.matrixWorld);
        const centerViewZ = centerWorld.clone().applyMatrix4(this.camera.matrixWorldInverse).z;
        const depthLimitWorld = this.getBrushDepthLimitWorld(item);
        const positions = this.brushInfluencePoints.geometry.getAttribute("position");
        const colors = this.brushInfluencePoints.geometry.getAttribute("color");
        const sizes = this.brushInfluencePoints.geometry.getAttribute("size");
        const stepSize = Math.max(1, Math.ceil((count || 1) / BRUSH_OVERLAY_POINT_LIMIT));
        let pointIndex = 0;
        const worldPosition = new THREE.Vector3();
        const falloffWorldPosition = new THREE.Vector3();
        for (let index = 0; index < count && pointIndex < BRUSH_OVERLAY_POINT_LIMIT; index += stepSize) {
          const splat = this.getPackedSplatAt(item, index);
          const geometry = this.cloneSplatGeometryState(splat);
          if (!geometry) {
            continue;
          }
          const falloff = this.getBrushInfluenceFalloffWorld(
            item,
            centerWorld,
            radiusWorld,
            geometry.center,
            falloffWorldPosition,
          );
          if (falloff <= 0) {
            continue;
          }
          const passesDepth = this.isSplatWithinBrushDepth(item, centerViewZ, geometry.center, depthLimitWorld);
          worldPosition.copy(geometry.center).applyMatrix4(item.mesh.matrixWorld);
          positions.setXYZ(pointIndex, worldPosition.x, worldPosition.y, worldPosition.z);
          sizes.setX(pointIndex, THREE.MathUtils.clamp(this.getSplatAverageScaleWorld(item, geometry) * (0.9 + falloff * 1.4), 0.006, Math.max(radiusWorld * 0.28, 0.008)));
          if (passesDepth) {
            const scalePull = Math.abs(clampNumber(this.state.brushScale, BRUSH_SCALE_LIMITS) - 1);
            colors.setXYZ(pointIndex, 0.1 + falloff * 0.25 + scalePull * 0.12, 0.76, 1);
          } else {
            colors.setXYZ(pointIndex, 1, 0.32 + falloff * 0.2, 0.08);
          }
          pointIndex += 1;
        }
        positions.needsUpdate = true;
        colors.needsUpdate = true;
        sizes.needsUpdate = true;
        this.brushInfluencePoints.geometry.setDrawRange(0, pointIndex);
        this.brushInfluencePoints.visible = pointIndex > 0;
      }

      isSplatWithinBrushDepth(item, centerViewZ, localCenter, depthLimitWorld) {
        if (depthLimitWorld <= 0) {
          return true;
        }
        const viewPosition = localCenter
          .clone()
          .applyMatrix4(item.mesh.matrixWorld)
          .applyMatrix4(this.camera.matrixWorldInverse);
        return Math.abs(viewPosition.z - centerViewZ) <= depthLimitWorld;
      }

      startBrushStroke(event) {
        const hit = this.getBrushHit(event);
        if (!hit?.item || !hit.sample) {
          this.updateStatus("Brush missed the visible splat");
          return;
        }
        if (hit.item.id !== this.selectedSceneItemId) {
          this.selectSceneItem(hit.item.id, false);
        }
        this.brushStroke = {
          changes: new Map(),
          itemId: hit.item.id,
          lastClientX: event.clientX,
          lastClientY: event.clientY,
          startCenter: hit.sample.localPosition.clone(),
          startWorldPoint: hit.worldPoint?.clone() ?? null,
          startViewZ: hit.worldPoint
            ? hit.worldPoint.clone().applyMatrix4(this.camera.matrixWorldInverse).z
            : hit.sample.localPosition.clone().applyMatrix4(hit.item.mesh.matrixWorld).applyMatrix4(this.camera.matrixWorldInverse).z,
          touched: 0,
        };
        this.updateBrushOverlay(hit);
        this.applyBrushAtHit(hit, { dx: 0, dy: 0, invert: event.shiftKey });
        this.renderer.domElement.setPointerCapture?.(event.pointerId);
      }

      continueBrushStroke(event) {
        if (!this.brushStroke) {
          return;
        }
        const hit = this.getBrushHit(event);
        if (!hit?.item || hit.item.id !== this.brushStroke.itemId) {
          return;
        }
        const dx = event.clientX - this.brushStroke.lastClientX;
        const dy = event.clientY - this.brushStroke.lastClientY;
        this.brushStroke.lastClientX = event.clientX;
        this.brushStroke.lastClientY = event.clientY;
        this.applyBrushAtHit(hit, { dx, dy, invert: event.shiftKey });
      }

      endBrushStroke() {
        if (!this.brushStroke) {
          return;
        }
        const item = this.getSceneItemById(this.brushStroke.itemId);
        const changes = [...this.brushStroke.changes.entries()].map(([index, snapshot]) => ({ index, ...snapshot }));
        if (item && changes.length) {
          this.brushUndoStack.push({ itemId: item.id, changes });
          this.trimBrushUndoStack();
        }
        const touched = this.brushStroke.touched;
        this.brushStroke = null;
        this.syncBrushUi(false);
        if (item && touched) {
          this.refreshActiveBackendSnapshot("Brush stroke completed");
          this.updateStatus(`Brush stroke edited ${touched.toLocaleString()} splats in ${item.modelMeta.name}`);
        }
      }

      getBrushMoveVector(item, dx, dy, referenceScale = null) {
        void dx;
        void dy;
        void referenceScale;
        const stroke = this.brushStroke;
        if (!item?.mesh || !stroke?.startCenter || !this.lastBrushHit?.sample?.localPosition) {
          return new THREE.Vector3();
        }
        return this.lastBrushHit.sample.localPosition.clone().sub(stroke.startCenter);
      }

      getStandardBrushDirection(item) {
        const direction = new THREE.Vector3();
        this.camera.getWorldDirection(direction).normalize();
        direction.transformDirection(item.mesh.matrixWorld.clone().invert());
        if (direction.lengthSq() < 1e-12) {
          return new THREE.Vector3(0, 0, -1);
        }
        return direction.normalize();
      }

      applyBrushAtHit(hit, { dx = 0, dy = 0, invert = false } = {}) {
        const item = hit.item;
        const count = this.getPackedSplatCount(item);
        const radius = clampNumber(this.state.brushRadius, BRUSH_RADIUS_LIMITS);
        const strength = clampNumber(this.state.brushStrength, BRUSH_STRENGTH_LIMITS);
        const scaleBias = clampNumber(this.state.brushScale, BRUSH_SCALE_LIMITS);
        const mode = ["move", "standard", "scale"].includes(this.state.brushMode) ? this.state.brushMode : "move";
        const editsScale = mode === "scale" && Math.abs(scaleBias - 1) > 1e-4;
        if (
          !count
          || radius <= 0
          || (mode === "standard" && Math.abs(strength) < 1e-8)
          || (mode === "scale" && !editsScale)
        ) {
          return;
        }
        const center = hit.sample.localPosition.clone();
        const centerWorld = hit.worldPoint ?? center.clone().applyMatrix4(item.mesh.matrixWorld);
        const brushCenterWorld = mode === "move" && this.brushStroke?.startWorldPoint
          ? this.brushStroke.startWorldPoint.clone()
          : centerWorld;
        const radiusWorld = this.getBrushRadiusWorld(item);
        const centerViewZ = mode === "move" && Number.isFinite(this.brushStroke?.startViewZ)
          ? this.brushStroke.startViewZ
          : centerWorld.clone().applyMatrix4(this.camera.matrixWorldInverse).z;
        const depthLimitWorld = this.getBrushDepthLimitWorld(item);
        const moveVector = mode === "move"
          ? this.getBrushMoveVector(item, dx, dy)
          : new THREE.Vector3();
        const standardDirection = mode === "standard" ? this.getStandardBrushDirection(item) : new THREE.Vector3();
        const standardSign = invert ? -1 : 1;
        const referenceWorldPosition = new THREE.Vector3();
        let changed = 0;
        for (let index = 0; index < count; index += 1) {
          const splat = this.getPackedSplatAt(item, index);
          const geometry = this.cloneSplatGeometryState(splat);
          if (!geometry) {
            continue;
          }
          const snapshot = this.brushStroke.changes.get(index);
          const referenceCenter = mode === "move" && snapshot?.center ? snapshot.center : geometry.center;
          referenceWorldPosition.copy(referenceCenter).applyMatrix4(item.mesh.matrixWorld);
          const distanceWorld = referenceWorldPosition.distanceTo(brushCenterWorld);
          if (distanceWorld > radiusWorld || !this.isSplatWithinBrushDepth(item, centerViewZ, referenceCenter, depthLimitWorld)) {
            continue;
          }
          const falloff = (1 - (distanceWorld / radiusWorld)) ** 2;
          if (!snapshot) {
            this.brushStroke.changes.set(index, {
              center: geometry.center.clone(),
              scales: geometry.scales.clone(),
            });
          }
          const initialSnapshot = this.brushStroke.changes.get(index);
          const nextCenter = mode === "move" && initialSnapshot?.center
            ? initialSnapshot.center.clone()
            : geometry.center.clone();
          const nextScales = geometry.scales.clone();
          const splatScaleWorld = this.getSplatAverageScaleWorld(item, geometry);
          if (mode === "move") {
            nextCenter.addScaledVector(moveVector, falloff);
          } else if (mode === "standard" && Math.abs(strength) >= 1e-8) {
            const displacementBasisWorld = this.state.brushRelativeToSplatSize ? splatScaleWorld : radiusWorld * 0.08;
            const displacementBasis = this.worldDistanceToLocalDistance(item, displacementBasisWorld);
            nextCenter.addScaledVector(standardDirection, standardSign * strength * falloff * displacementBasis);
          }
          if (editsScale) {
            const scaleWeight = falloff * Math.min(Math.abs(strength), 1);
            const scaleFactor = THREE.MathUtils.lerp(1, scaleBias, scaleWeight);
            nextScales.multiplyScalar(scaleFactor).clampScalar(0.0001, 1e6);
          }
          if (this.writeSplatGeometry(item, index, nextCenter, nextScales, splat)) {
            changed += 1;
          }
        }
        if (!changed) {
          return;
        }
        this.markStaticBakeStale("Brush geometry changed");
        item.geometryRevision += 1;
        this.invalidateLightOcclusion("Brush geometry changed");
        this.syncAlignUi();
        this.brushStroke.touched += changed;
        const storage = this.getEditableSplatStorage(item);
        this.markSplatStorageNeedsUpdate(storage);
        item.mesh.updateGenerator?.();
        item.hoverEntries = this.createMeshHoverEntries(item);
        const bounds = computeCenterBounds(item.mesh, item.baseLocalBounds ?? item.mesh.getBoundingBox?.(true));
        item.baseCenterBounds = bounds.clone();
        item.baseLocalBounds = bounds.clone();
        this.recomputeBounds();
        this.renderPickedColors();
        this.invalidateRender();
        this.forceVisualRefresh(2);
        this.queueSparkSceneUpdate();
      }

      undoLastBrushStroke() {
        const undo = this.brushUndoStack?.pop() ?? null;
        this.lastBrushUndo = this.brushUndoStack?.[this.brushUndoStack.length - 1] ?? null;
        const item = undo ? this.getSceneItemById(undo.itemId) : null;
        if (!item?.mesh || !undo?.changes?.length) {
          this.updateStatus("No brush stroke to undo");
          this.syncBrushUi(false);
          return;
        }
        let restored = 0;
        undo.changes.forEach((change) => {
          const splat = this.getPackedSplatAt(item, change.index);
          if (this.writeSplatGeometry(item, change.index, change.center, change.scales, splat)) {
            restored += 1;
          }
        });
        this.markSplatStorageNeedsUpdate(this.getEditableSplatStorage(item));
        item.mesh.updateGenerator?.();
        item.hoverEntries = this.createMeshHoverEntries(item);
        const bounds = computeCenterBounds(item.mesh, item.baseLocalBounds ?? item.mesh.getBoundingBox?.(true));
        item.baseCenterBounds = bounds.clone();
        item.baseLocalBounds = bounds.clone();
        this.recomputeBounds();
        this.renderPickedColors();
        this.invalidateRender();
        this.forceVisualRefresh(3);
        this.queueSparkSceneUpdate();
        if (restored) {
          item.geometryRevision += 1;
          this.invalidateLightOcclusion("Brush undo changed geometry");
          this.syncAlignUi();
          this.markStaticBakeStale("Brush undo changed geometry");
          this.refreshActiveBackendSnapshot("Brush undo completed");
        }
        this.syncBrushUi(false);
        this.updateStatus(`Undid brush stroke on ${restored.toLocaleString()} splats`);
      }

      getSplatQuaternion(splat) {
        const source = splat?.quaternion ?? splat?.rotation ?? splat?.rot;
        if (source) {
          return new THREE.Quaternion(
            Number(source.x ?? source[1] ?? 0) || 0,
            Number(source.y ?? source[2] ?? 0) || 0,
            Number(source.z ?? source[3] ?? 0) || 0,
            Number(source.w ?? source[0] ?? 1),
          ).normalize();
        }
        const sourceNormal = splat?.normal ?? splat?.norm ?? splat?.n;
        if (sourceNormal) {
          return createQuaternionFromNormal(
            new THREE.Vector3(
              Number(sourceNormal.x ?? sourceNormal[0] ?? 0) || 0,
              Number(sourceNormal.y ?? sourceNormal[1] ?? 0) || 0,
              Number(sourceNormal.z ?? sourceNormal[2] ?? 1) || 1,
            ),
          );
        }
        return new THREE.Quaternion();
      }

      getSplatNormal(splat) {
        const source = splat?.normal ?? splat?.norm ?? splat?.n;
        const vector = source
          ? new THREE.Vector3(
            Number(source.x ?? source[0] ?? 0) || 0,
            Number(source.y ?? source[1] ?? 0) || 0,
            Number(source.z ?? source[2] ?? 1) || 1,
          )
          : new THREE.Vector3(0, 0, 1).applyQuaternion(this.getSplatQuaternion(splat));
        if (vector.lengthSq() < 1e-12) {
          return new THREE.Vector3(0, 0, 1);
        }
        return vector.normalize();
      }

      getExportOptions() {
        this.state.exportOpacity = this.dom.exportOpacityCheckbox?.checked ?? this.state.exportOpacity;
        this.state.exportFalloff = this.dom.exportFalloffCheckbox?.checked ?? this.state.exportFalloff;
        this.state.exportSh = this.dom.exportShCheckbox?.checked ?? this.state.exportSh;
        return {
          falloff: Boolean(this.state.exportFalloff),
          opacity: Boolean(this.state.exportOpacity),
          sh: Boolean(this.state.exportSh),
        };
      }

      getExportCommentsForItem(item, options) {
        const comments = [
          `gs360_export_item ${item.modelMeta?.name ?? item.id}`,
          "gs360_export_color_space srgb",
          "gs360_export_appearance baked_sh0",
        ];
        if (options.opacity) {
          comments.push(`gs360_export_opacity ${formatNumber(item.settings?.opacity ?? 1, 6)}`);
        }
        if (options.falloff) {
          comments.push(`gs360_export_falloff ${formatNumber(item.settings?.falloff ?? this.spark?.falloff ?? 1, 6)}`);
        }
        if (options.sh) {
          comments.push(`gs360_export_active_sh ${Math.round(item.settings?.shLevel ?? 0)}`);
          comments.push(`gs360_export_loaded_sh ${Math.round(item.loadedShDegree ?? 0)}`);
        }
        return comments;
      }

      buildExportSplatsForItem(item, options = this.getExportOptions()) {
        if (!item?.mesh) {
          return [];
        }
        const count = this.getPackedSplatCount(item);
        if (!count) {
          return [];
        }
        item.modelRoot.updateMatrixWorld(true);
        item.rotationPivot.updateMatrixWorld(true);
        item.mesh.updateMatrixWorld(true);
        const worldMatrix = item.mesh.matrixWorld.clone();
        const worldQuaternion = new THREE.Quaternion();
        const worldScale = new THREE.Vector3();
        worldMatrix.decompose(new THREE.Vector3(), worldQuaternion, worldScale);
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldMatrix);
        const opacityScale = options.opacity
          ? clampNumber(item.settings?.opacity ?? 1, OPACITY_LIMITS)
          : 1;
        const exportSplats = [];
        for (let index = 0; index < count; index += 1) {
          const splat = this.getPackedSplatAt(item, index);
          if (!splat) {
            continue;
          }
          const center = splat.center ?? splat.position;
          const scales = splat.scales ?? splat.scale;
          if (!center || !scales) {
            continue;
          }
          const localPosition = new THREE.Vector3(
            Number(center.x ?? center[0] ?? 0) || 0,
            Number(center.y ?? center[1] ?? 0) || 0,
            Number(center.z ?? center[2] ?? 0) || 0,
          );
          const localQuaternion = this.getSplatQuaternion(splat);
          const localNormal = this.getSplatNormal(splat);
          const localScale = new THREE.Vector3(
            Math.max(Number(scales.x ?? scales[0] ?? 0.0001) || 0.0001, 0.0001),
            Math.max(Number(scales.y ?? scales[1] ?? 0.0001) || 0.0001, 0.0001),
            Math.max(Number(scales.z ?? scales[2] ?? 0.0001) || 0.0001, 0.0001),
          );
          const color = this.getDisplayLinearColorForSample(item, {
            baseLinearRgb: sourceColorToLinear(splat.color ?? splat.rgb ?? splat.rgba, item.sourceColorSpace),
            localPosition,
            localNormal: this.getSplatLocalNormal(splat),
            splatIndex: index,
          });
          const encoded = linearColorToSrgb(color);
          const alpha = Number(splat.opacity ?? splat.alpha ?? splat.rgba?.w ?? splat.rgba?.a ?? 1) || 0;
          exportSplats.push({
            position: localPosition.applyMatrix4(worldMatrix),
            normal: localNormal.applyMatrix3(normalMatrix).normalize(),
            color: new THREE.Color(...encoded),
            alpha: THREE.MathUtils.clamp(alpha * opacityScale, 0, 1),
            scale: localScale.clone().multiply(worldScale).clampScalar(0.0001, 1e6),
            quaternion: worldQuaternion.clone().multiply(localQuaternion).normalize(),
          });
        }
        return exportSplats;
      }

      async saveVisibleSceneSplats() {
        const exportItems = this.sceneItems.filter((item) => item.exportEnabled && item.mesh);
        if (!exportItems.length) {
          this.updateStatus("No export-enabled splats to save");
          return;
        }
        const usedNames = new Set();
        const exportPayloads = [];
        const exportOptions = this.getExportOptions();
        // A portable PLY cannot retain runtime modifiers, nonstandard falloff,
        // or view-dependent SH after nonlinear grading. Do not silently save
        // a different look when the current path cannot represent it.
        const sparkActive = !this.backendManager || this.backendManager.activeId === "spark";
        if (sparkActive && this.shouldAttachAnimationModifier()) {
          this.updateStatus("Reset animation to time 0 before saving a static appearance");
          return;
        }
        if (sparkActive && exportItems.some((item) => this.getRenderModeForItem(item) !== "beauty")) {
          this.updateStatus("Switch to Beauty before saving the splat appearance");
          return;
        }
        if (sparkActive && !this.staticBakeApplied && exportItems.some((item) => Math.min(item.loadedShDegree ?? 0, item.settings?.shLevel ?? 0) > 0)) {
          this.updateStatus("Set SH Level to SH0 before saving appearance; view-dependent SH export is not supported");
          return;
        }
        if (sparkActive && Math.abs((this.spark?.falloff ?? 1) - 1) > 1e-6) {
          this.updateStatus("Set Falloff to 1 before saving a portable Gaussian PLY");
          return;
        }
        if (exportOptions.opacity && exportItems.some((item) => (item.settings?.opacity ?? 1) > 1)) {
          this.updateStatus("Set Opacity to 1 or below before saving a portable Gaussian PLY");
          return;
        }
        this.syncLightingRuntimeState();
        for (const [index, item] of exportItems.entries()) {
          const exportSplats = this.buildExportSplatsForItem(item, exportOptions);
          if (!exportSplats.length) {
            continue;
          }
          const baseName = sanitizeDownloadName(item.modelMeta?.name ?? `scene-splat-${index + 1}`);
          exportPayloads.push({
            buffer: packGaussianPly(exportSplats, this.getExportCommentsForItem(item, exportOptions)),
            fileName: buildUniqueFileName(baseName, ".ply", usedNames),
          });
        }
        if (!exportPayloads.length) {
          this.updateStatus("No exportable splats were found");
          return;
        }
        let savedCount = 0;
        if (window.showDirectoryPicker) {
          try {
            const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
            for (const payload of exportPayloads) {
              await this.writeFileToDirectory(directoryHandle, payload.fileName, payload.buffer);
              savedCount += 1;
            }
          } catch (error) {
            if (error?.name === "AbortError") {
              this.updateStatus("Save canceled");
              return;
            }
            throw error;
          }
        } else {
          exportPayloads.forEach((payload) => {
            this.triggerBrowserDownload(payload.fileName, payload.buffer);
            savedCount += 1;
          });
        }
        this.updateStatus(
          savedCount > 0
            ? `Saved ${savedCount} scene splat${savedCount === 1 ? "" : "s"}`
            : "No exportable splats were found",
        );
        this.forceVisualRefresh(2);
      }

      applyExposure(updateChip = true, syncInput = true, { refreshBackend = true } = {}) {
        this.markStaticBakeStale("Scene exposure changed");
        const exposure = clampNumber(this.state.exposure, EXPOSURE_LIMITS);
        this.state.exposure = exposure;
        this.renderer.toneMappingExposure = 1;
        this.syncMeshExposure();
        if (this.dom.exposureRange) {
          this.dom.exposureRange.value = String(exposure);
        }
        if (syncInput) {
          this.dom.exposureInput.value = exposure.toFixed(Math.abs(exposure) < 1 ? 1 : 2);
        }
        if (updateChip) {
          this.updateRenderChip(`Exposure ${formatExposureLabel(exposure)}`);
        }
        this.syncLightingRuntimeState();
        this.renderPickedColors();
        this.invalidateRender();
        this.requestActiveBackendAppearanceRefresh("Scene exposure updated", { immediate: refreshBackend });
      }

      setExposure(value, { commit = true, syncInput = true } = {}) {
        this.state.exposure = commit ? clampNumber(value, EXPOSURE_LIMITS) : Number(value);
        this.applyExposure(true, syncInput, { refreshBackend: commit });
        if (commit) {
          this.finishDeferredInteraction();
        } else {
          this.startDeferredInteraction();
        }
      }

      applyToneCurve(updateChip = true, syncInput = true, { commit = true } = {}) {
        this.markStaticBakeStale("Tone-curve appearance changed");
        this.state.toneCurve = normalizeToneCurveState(this.state.toneCurve);
        const item = this.getSelectedItem();
        if (item) {
          item.settings.toneCurve = normalizeToneCurveState(this.state.toneCurve);
        }
        this.syncToneCurveUi(syncInput);
        if (updateChip) {
          this.updateRenderChip(`Tone curve ${summarizeToneCurve(this.state.toneCurve)}`);
        }
        if (this.hoverPointer) {
          this.updateHoverReadout();
        }
        this.renderPickedColors();
        this.applyRenderMode(false);
        this.invalidateRender();
        this.forceVisualRefresh(commit ? 2 : 1);
        if (commit) {
          this.requestActiveBackendAppearanceRefresh("Tone curve updated", { immediate: true });
          this.queueSparkSceneUpdate();
          this.finishDeferredInteraction();
        } else {
          this.requestActiveBackendAppearanceRefresh("Tone curve preview updated");
          this.pendingPreviewSparkUpdate = true;
          this.startDeferredInteraction();
        }
      }

      setSelectedToneCurvePointValue(axis, value, { commit = true } = {}) {
        const toneCurve = normalizeToneCurveState(this.state.toneCurve);
        const channel = toneCurve.activeChannel;
        const index = toneCurve.selectedPointIndices[channel];
        this.state.toneCurve = updateToneCurvePoint(toneCurve, channel, index, { [axis]: value });
        this.applyToneCurve(true, true, { commit });
      }

      syncToneCurveUi(syncInput = true) {
        this.state.toneCurve = normalizeToneCurveState(this.state.toneCurve);
        const toneCurve = this.state.toneCurve;
        const channel = toneCurve.activeChannel;
        const selectedIndex = toneCurve.selectedPointIndices[channel];
        const selectedPoint = getSelectedToneCurvePoint(toneCurve, channel);
        const isEndpoint = selectedIndex <= 0 || selectedIndex >= toneCurve.curves[channel].length - 1;
        if (this.dom.toneCurveChannelSelect) {
          this.dom.toneCurveChannelSelect.value = channel;
        }
        if (syncInput && this.dom.toneCurvePointXInput) {
          this.dom.toneCurvePointXInput.value = Number(selectedPoint?.x ?? 1).toFixed(3);
        }
        if (syncInput && this.dom.toneCurvePointYInput) {
          this.dom.toneCurvePointYInput.value = Number(selectedPoint?.y ?? 1).toFixed(3);
        }
        if (this.dom.toneCurveRemovePointButton) {
          this.dom.toneCurveRemovePointButton.disabled = isEndpoint;
        }
        this.renderToneCurvePointList();
        this.renderToneCurveGraph();
      }

      renderToneCurvePointList() {
        if (!this.dom.toneCurvePointList) {
          return;
        }
        const toneCurve = normalizeToneCurveState(this.state.toneCurve);
        const channel = toneCurve.activeChannel;
        const selectedIndex = toneCurve.selectedPointIndices[channel];
        this.dom.toneCurvePointList.innerHTML = "";
        toneCurve.curves[channel].forEach((point, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "tone-curve-point-button";
          button.textContent = `${index}: ${point.x.toFixed(2)}, ${point.y.toFixed(2)}`;
          button.classList.toggle("is-active", index === selectedIndex);
          button.addEventListener("click", () => {
            this.state.toneCurve = setToneCurveSelectedPoint(this.state.toneCurve, channel, index);
            this.syncToneCurveUi();
          });
          this.dom.toneCurvePointList.append(button);
        });
      }

      renderToneCurveGraph() {
        if (!this.dom.toneCurveGraph) {
          return;
        }
        const toneCurve = normalizeToneCurveState(this.state.toneCurve);
        const channel = toneCurve.activeChannel;
        const selectedIndex = toneCurve.selectedPointIndices[channel];
        const curve = toneCurve.curves[channel];
        const pathData = buildToneCurveSvgPathData(curve);
        this.dom.toneCurveGraph.innerHTML = `
          <line x1="0" y1="100" x2="100" y2="0" stroke="rgba(255,255,255,0.24)" stroke-dasharray="4 4" />
          <path d="${pathData}" fill="none" stroke="rgba(127,240,215,0.95)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
          ${curve.map((point, index) => {
            const cx = (point.x * 100).toFixed(3);
            const cy = (100 - point.y * 100).toFixed(3);
            const selected = index === selectedIndex;
            return `<circle class="tone-curve-point-handle" data-tone-curve-point-index="${index}" cx="${cx}" cy="${cy}" r="${selected ? 3.5 : 2.8}" fill="${selected ? '#7ff0d7' : '#f6fbff'}" stroke="rgba(6,16,25,0.88)" stroke-width="1.2" />`;
          }).join("")}
        `;
        this.dom.toneCurveGraph.querySelectorAll("[data-tone-curve-point-index]").forEach((element) => {
          const index = Number(element.getAttribute("data-tone-curve-point-index"));
          element.addEventListener("click", (event) => {
            event.preventDefault();
            this.state.toneCurve = setToneCurveSelectedPoint(this.state.toneCurve, channel, index);
            this.syncToneCurveUi();
          });
          element.addEventListener("pointerdown", (event) => this.startToneCurvePointDrag(index, event));
        });
      }

      getToneCurveGraphPointFromEvent(event) {
        if (!this.dom.toneCurveGraph) {
          return null;
        }
        const rect = this.dom.toneCurveGraph.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          return null;
        }
        return {
          x: THREE.MathUtils.clamp((event.clientX - rect.left) / rect.width, 0, 1),
          y: THREE.MathUtils.clamp(1 - ((event.clientY - rect.top) / rect.height), 0, 1),
        };
      }

      handleToneCurveGraphPointerDown(event) {
        if (event.button !== 0) {
          return;
        }
        if (event.target?.closest?.("[data-tone-curve-point-index]")) {
          return;
        }
        const graphPoint = this.getToneCurveGraphPointFromEvent(event);
        if (!graphPoint) {
          return;
        }
        event.preventDefault();
        const toneCurve = normalizeToneCurveState(this.state.toneCurve);
        const channel = toneCurve.activeChannel;
        const { x, y } = graphPoint;
        this.state.toneCurve = insertToneCurvePoint(this.state.toneCurve, channel, { x, y });
        this.applyToneCurve(true, true);
      }

      handleToneCurveGraphContextMenu(event) {
        event.preventDefault();
        const graphPoint = this.getToneCurveGraphPointFromEvent(event);
        if (!graphPoint) {
          return;
        }
        const toneCurve = normalizeToneCurveState(this.state.toneCurve);
        const channel = toneCurve.activeChannel;
        const index = findNearestRemovableToneCurvePointIndex(toneCurve.curves[channel], graphPoint);
        if (index == null) {
          return;
        }
        this.state.toneCurve = removeToneCurvePoint(this.state.toneCurve, channel, index);
        this.applyToneCurve(true, true);
      }

      startToneCurvePointDrag(index, event) {
        if (!this.dom.toneCurveGraph) {
          return;
        }
        const toneCurve = normalizeToneCurveState(this.state.toneCurve);
        const channel = toneCurve.activeChannel;
        if (index < 0 || index >= toneCurve.curves[channel].length) {
          return;
        }
        event.preventDefault();
        this.state.toneCurve = setToneCurveSelectedPoint(this.state.toneCurve, channel, index);
        this.toneCurvePointerDrag = { channel, index };
        this.updateToneCurvePointFromPointer(event);
      }

      updateToneCurvePointFromPointer(event) {
        if (!this.toneCurvePointerDrag || !this.dom.toneCurveGraph) {
          return;
        }
        const graphPoint = this.getToneCurveGraphPointFromEvent(event);
        if (!graphPoint) {
          return;
        }
        const { x, y } = graphPoint;
        this.state.toneCurve = updateToneCurvePoint(
          this.state.toneCurve,
          this.toneCurvePointerDrag.channel,
          this.toneCurvePointerDrag.index,
          { x, y },
        );
        this.applyToneCurve(false, true, { commit: false });
      }

      stopToneCurvePointDrag() {
        if (!this.toneCurvePointerDrag) {
          return;
        }
        this.toneCurvePointerDrag = null;
        this.applyToneCurve(true, true, { commit: true });
      }

      applySelectedExposure(updateChip = true, syncInput = true, { refreshBackend = true } = {}) {
        this.markStaticBakeStale("Selected exposure changed");
        const exposure = clampNumber(this.state.selectedExposure, EXPOSURE_LIMITS);
        this.state.selectedExposure = exposure;
        if (this.dom.selectedExposureRange) {
          this.dom.selectedExposureRange.value = String(exposure);
        }
        if (syncInput && this.dom.selectedExposureInput) {
          this.dom.selectedExposureInput.value = exposure.toFixed(Math.abs(exposure) < 1 ? 1 : 2);
        }
        const item = this.getSelectedItem();
        if (item) {
          item.settings.exposure = exposure;
          this.modelMeta = item.modelMeta;
        }
        this.syncMeshExposure();
        if (updateChip) {
          this.updateRenderChip(`Selected exposure ${formatExposureLabel(exposure)}`);
        }
        this.syncLightingRuntimeState();
        this.renderPickedColors();
        this.invalidateRender();
        this.requestActiveBackendAppearanceRefresh("Selected exposure updated", { immediate: refreshBackend });
      }

      setSelectedExposure(value, { commit = true, syncInput = true } = {}) {
        this.state.selectedExposure = commit ? clampNumber(value, EXPOSURE_LIMITS) : Number(value);
        this.applySelectedExposure(true, syncInput, { refreshBackend: commit });
        if (commit) {
          this.finishDeferredInteraction();
        } else {
          this.startDeferredInteraction();
        }
      }

      syncMeshExposure() {
        this.sceneItems.forEach((item) => {
          if (item.mesh?.recolor) {
            const exposureScale = this.getItemExposureScale(item);
            item.mesh.recolor.setRGB(exposureScale, exposureScale, exposureScale);
          }
        });
      }

      handleStageWheel(event) {
        this.commitActiveField();
        if (this.activeMode !== "fps") {
          return;
        }
        event.preventDefault();
        const delta = THREE.MathUtils.clamp(event.deltaY, -240, 240);
        if (Math.abs(delta) < 1e-3) {
          return;
        }
        const direction = delta < 0 ? 1 : -1;
        const distance = this.firstPerson.moveSpeed * (Math.abs(delta) / 120) * 0.9 * direction;
        this.firstPerson.dolly(distance);
        this.updateCameraClipping();
      }

      applyFocalLength(refreshClipping, updateChip = true, syncInput = true) {
        const focalLength = clampNumber(this.state.focalLength, FOCAL_LENGTH_LIMITS);
        this.state.focalLength = focalLength;
        this.camera.setFocalLength(focalLength);
        this.camera.updateProjectionMatrix();
        this.dom.focalLengthRange.value = String(focalLengthToSlider(focalLength));
        if (syncInput) {
          this.dom.focalLengthInput.value = formatNumber(focalLength, focalLength < 10 ? 1 : 0);
        }
        this.dom.lensChip.textContent = `${formatNumber(focalLength, focalLength < 10 ? 1 : 0)} mm`;
        if (refreshClipping) {
          this.updateCameraClipping();
        }
        if (updateChip) {
          this.updateRenderChip("Lens updated");
        }
        this.invalidateRender();
      }

      applyMoveSpeed(updateChip = true, syncInput = true) {
        const multiplier = Math.max(this.state.moveSpeedFactor, MOVE_SPEED_LIMITS.min);
        if (this.dom.moveSpeedRange) {
          this.dom.moveSpeedRange.value = String(multiplier);
        }
        if (syncInput) {
          this.dom.moveSpeedInput.value = multiplier.toFixed(2);
        }
        const speedText = formatSpeedLabel(multiplier);
        this.dom.speedChip.textContent = speedText;
        this.firstPerson.setSpeed(multiplier);
        if (updateChip) {
          this.updateRenderChip("Move speed updated");
        }
        this.invalidateRender(false);
      }

      applyRenderFps(updateChip = true, syncInput = true) {
        const fps = clampNumber(this.state.renderFps, RENDER_FPS_LIMITS);
        this.state.renderFps = fps;
        if (syncInput && this.dom.renderFpsInput) {
          this.dom.renderFpsInput.value = String(Math.round(fps));
        }
        if (updateChip) {
          this.updateRenderChip(`Render ${Math.round(fps)} fps`);
        }
        this.markRenderActivity();
        this.invalidateRender(false);
      }

      setRenderFps(value, { commit = true, syncInput = true } = {}) {
        this.state.renderFps = commit ? clampNumber(value, RENDER_FPS_LIMITS) : Number(value);
        if (!Number.isFinite(this.state.renderFps)) {
          return;
        }
        this.applyRenderFps(true, syncInput);
      }

      setFocalLength(value, refreshClipping, { commit = true, syncInput = true } = {}) {
        this.state.focalLength = commit ? clampNumber(value, FOCAL_LENGTH_LIMITS) : Number(value);
        this.applyFocalLength(refreshClipping, true, syncInput);
      }

      setMoveSpeedFactor(value, { commit = true, syncInput = true } = {}) {
        this.state.moveSpeedFactor = commit ? clampNumber(value, MOVE_SPEED_LIMITS) : Number(value);
        this.applyMoveSpeed(true, syncInput);
      }

      configureDepthRangeFromBounds() {
        const referenceSphere = this.centerBoundsSphere ?? this.boundsSphere;
        let suggested = Math.max(referenceSphere?.radius || 0.05, 0.05);
        if (this.centerBounds) {
          this.camera.updateMatrixWorld(true);
          let furthestDepth = 0;
          getBoxCorners(this.centerBounds).forEach((corner) => {
            furthestDepth = Math.max(furthestDepth, corner.distanceTo(this.camera.position));
          });
          if (furthestDepth > 0) {
            suggested = furthestDepth;
          }
        }
        suggested = Math.max(suggested * 1.05, 0.05);
        this.depthRangeLimits = {
          min: 0.01,
          max: Math.max(suggested * 8, suggested + 1, 5),
        };
        if (this.depthRangeIsAuto || !Number.isFinite(this.state.depthRange)) {
          this.state.depthRange = suggested;
        }
        this.applyDepthRange(false);
      }

      getActiveNormalizeLimits() {
        return this.state.renderMode === "position"
          ? POSITION_RANGE_LIMITS
          : this.depthRangeLimits;
      }

      applyDepthRange(updateChip = true, syncInput = true) {
        const clamped = clampNumber(this.state.depthRange, this.depthRangeLimits);
        this.state.depthRange = clamped;
        this.depthModifierHandles.maxDepth.value = clamped;
        this.updateNormalizeFieldState(syncInput);
        if (updateChip) {
          this.updateRenderChip("Depth max updated");
        }
        this.forceVisualRefresh(3);
      }

      setDepthRange(value, { commit = true, syncInput = true } = {}) {
        if (commit) {
          this.depthRangeIsAuto = false;
        }
        this.state.depthRange = commit ? clampNumber(value, this.depthRangeLimits) : Number(value);
        this.applyDepthRange(true, syncInput);
      }

      applyPositionRange(updateChip = true, syncInput = true) {
        const clamped = clampNumber(this.state.positionRangeScale, POSITION_RANGE_LIMITS);
        this.state.positionRangeScale = clamped;
        this.positionModifierHandles.scaleFactor.value = clamped;
        this.updateNormalizeFieldState(syncInput);
        if (updateChip) {
          this.updateRenderChip("Position range updated");
        }
        this.forceVisualRefresh(3);
      }

      setPositionRange(value, { commit = true, syncInput = true } = {}) {
        this.state.positionRangeScale = commit
          ? clampNumber(value, POSITION_RANGE_LIMITS)
          : Number(value);
        this.applyPositionRange(true, syncInput);
      }

      setNormalizeValue(value, options = {}) {
        if (this.state.renderMode === "position") {
          this.setPositionRange(value, options);
          return;
        }
        this.setDepthRange(value, options);
      }

      updateNormalizeFieldState(syncInput = true) {
        const isDepth = this.state.renderMode === "depth";
        const isPosition = this.state.renderMode === "position";
        const isActive = isDepth || isPosition;
        this.dom.depthRangeField.classList.toggle("is-disabled", !isActive);
        this.dom.depthRangeLabel.textContent = isPosition ? "Position Range" : "Depth Max";
        this.dom.depthRangeField.title = isPosition
          ? "Adjust the rotated splat-center normalization span used by the Position render mode."
          : "Adjust the normalization distance used by the Depth render mode.";
        const limits = this.getActiveNormalizeLimits();
        const currentValue = isPosition ? this.state.positionRangeScale : this.state.depthRange;
        this.dom.depthRangeRange.min = String(limits.min);
        this.dom.depthRangeRange.max = String(limits.max);
        this.dom.depthRangeRange.value = String(currentValue);
        if (syncInput) {
          this.dom.depthRangeInput.value = isPosition
            ? currentValue.toFixed(currentValue < 10 ? 2 : 1)
            : currentValue.toFixed(currentValue < 10 ? 1 : 2);
        }
      }

      applyQualityPreset(presetKey) {
        const preset = QUALITY[presetKey] || QUALITY.balanced;
        this.state.quality = presetKey in QUALITY ? presetKey : "balanced";
        this.spark.maxStdDev = preset.maxStdDev;
        if (this.sparkSettings) {
          this.sparkSettings.maxStdDev = preset.maxStdDev;
          const input = document.getElementById("renderer-spark-maxStdDev");
          if (input) input.value = String(preset.maxStdDev);
        }
        this.syncRendererPixelRatio();
        this.dom.qualitySelect.value = this.state.quality;
        this.onResize();
      }

      getAvailableShDegree() {
        if (!this.currentMesh) {
          return 0;
        }
        return THREE.MathUtils.clamp(
          Number.isFinite(this.loadedShDegree) ? this.loadedShDegree : inferShDegree(this.currentMesh),
          0,
          3,
        );
      }

      getEffectiveShLevel() {
        const maxSh = this.getAvailableShDegree();
        const forced = this.state.renderMode === "worldNormal";
        return {
          activeSh: forced ? 0 : THREE.MathUtils.clamp(this.state.shLevel, 0, maxSh),
          forced,
          maxSh,
        };
      }

      applyShLevel(updateGenerator = true) {
        const selectedItem = this.getSelectedItem();
        if (selectedItem) {
          selectedItem.settings.shLevel = this.state.shLevel;
        }
        this.sceneItems.forEach((item) => {
          if (!item.mesh) {
            return;
          }
          const maxSh = THREE.MathUtils.clamp(
            Number.isFinite(item.loadedShDegree) ? item.loadedShDegree : inferShDegree(item.mesh),
            0,
            3,
          );
          const itemRenderMode = item.id === this.selectedSceneItemId
            ? this.state.renderMode
            : "beauty";
          const forced = itemRenderMode === "worldNormal";
          const targetSh = item.settings?.shLevel ?? 3;
          const activeSh = forced ? 0 : THREE.MathUtils.clamp(targetSh, 0, maxSh);
          item.mesh.maxSh = activeSh;
          item.mesh.splats?.setMaxSh?.(activeSh);
          if (item.mesh.packedSplats) {
            item.mesh.packedSplats.maxSh = activeSh;
          }
          if (item.mesh.extSplats) {
            item.mesh.extSplats.maxSh = activeSh;
          }
          if (updateGenerator) {
            item.mesh.updateGenerator();
          }
          item.modelMeta.shDegree = formatShLabel(maxSh);
          item.modelMeta.activeSh = forced
            ? `${formatShLabel(activeSh)} forced`
            : formatShLabel(activeSh);
        });
        this.updateMetaUi();
        this.invalidateRender();
      }

      applyTransformFromInputs(announce, commit = false) {
        const selectedItem = this.getSelectedItem();
        if (selectedItem) this.markStaticBakeStale("Splat transform changed");
        const rotationXRaw = this.dom.rotationXInput.value.trim();
        const rotationYRaw = this.dom.rotationYInput.value.trim();
        const rotationZRaw = this.dom.rotationZInput.value.trim();
        const scaleRaw = this.dom.scaleInput.value.trim();
        const translateXRaw = this.dom.translateXInput.value.trim();
        const translateYRaw = this.dom.translateYInput.value.trim();
        const translateZRaw = this.dom.translateZInput.value.trim();
        const parsedScale = Number(scaleRaw);
        const parsedTranslateX = Number(translateXRaw);
        const parsedTranslateY = Number(translateYRaw);
        const parsedTranslateZ = Number(translateZRaw);
        this.state.rotationX = !commit && isIntermediateNumericInput(rotationXRaw)
          ? this.state.rotationX
          : parseRotationValue(rotationXRaw);
        this.state.rotationY = !commit && isIntermediateNumericInput(rotationYRaw)
          ? this.state.rotationY
          : parseRotationValue(rotationYRaw);
        this.state.rotationZ = !commit && isIntermediateNumericInput(rotationZRaw)
          ? this.state.rotationZ
          : parseRotationValue(rotationZRaw);
        this.state.scale = commit
          ? clampNumber(scaleRaw, SCALE_LIMITS)
          : Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : this.state.scale;
        this.state.translateX = commit
          ? clampNumber(translateXRaw, TRANSLATE_LIMITS)
          : Number.isFinite(parsedTranslateX) ? parsedTranslateX : this.state.translateX;
        this.state.translateY = commit
          ? clampNumber(translateYRaw, TRANSLATE_LIMITS)
          : Number.isFinite(parsedTranslateY) ? parsedTranslateY : this.state.translateY;
        this.state.translateZ = commit
          ? clampNumber(translateZRaw, TRANSLATE_LIMITS)
          : Number.isFinite(parsedTranslateZ) ? parsedTranslateZ : this.state.translateZ;
        if (selectedItem) {
          selectedItem.transform.rotationX = this.state.rotationX;
          selectedItem.transform.rotationY = this.state.rotationY;
          selectedItem.transform.rotationZ = this.state.rotationZ;
          selectedItem.transform.scale = this.state.scale;
          selectedItem.transform.translateX = this.state.translateX;
          selectedItem.transform.translateY = this.state.translateY;
          selectedItem.transform.translateZ = this.state.translateZ;
        }
        if (!this.modelRoot || !this.rotationPivot) {
          if (commit) {
            this.syncTransformInputs();
          }
          return;
        }
        this.modelRoot.position.set(
          this.state.translateX,
          this.state.translateY,
          this.state.translateZ,
        );
        this.rotationPivot.rotation.set(
          THREE.MathUtils.degToRad(this.state.rotationX),
          THREE.MathUtils.degToRad(this.state.rotationY),
          THREE.MathUtils.degToRad(this.state.rotationZ),
        );
        this.rotationPivot.scale.setScalar(this.state.scale);
        this.rotationPivot.updateMatrixWorld(true);
        this.syncAlignUi();
        this.invalidateLightOcclusion("Splat transform changed");
        if (commit) {
          this.syncTransformInputs();
        }
        this.syncTransformGizmo();
        if (!this.currentMesh) {
          if (commit) {
            this.finishDeferredInteraction();
          } else {
            this.startDeferredInteraction();
          }
          return;
        }
        this.syncVisibleSceneItemTransforms();
        if (!commit) this.syncActiveBackendItemTransforms();
        if (commit) {
          this.refreshActiveBackendSnapshot("Transform updated");
        }
        if (commit) {
          this.finishDeferredInteraction();
        } else {
          this.startDeferredInteraction();
        }
        this.scheduleSelectedTransformRefresh(announce, commit);
      }

      syncTransformInputs() {
        this.dom.rotationXInput.value = String(this.state.rotationX);
        this.dom.rotationYInput.value = String(this.state.rotationY);
        this.dom.rotationZInput.value = String(this.state.rotationZ);
        this.dom.scaleInput.value = String(this.state.scale);
        this.dom.translateXInput.value = String(this.state.translateX);
        this.dom.translateYInput.value = String(this.state.translateY);
        this.dom.translateZInput.value = String(this.state.translateZ);
      }

      clearDiagnostics() {
        const item = this.getSelectedItem();
        if (!item?.mesh) {
          return;
        }
        item.mesh.enableWorldToView = false;
        item.mesh.objectModifiers = item.baseObjectModifier ? [item.baseObjectModifier] : undefined;
        item.mesh.worldModifiers = item.baseWorldModifier ? [item.baseWorldModifier] : undefined;
        this.syncMeshExposure();
      }

      disposeSceneItem(item) {
        if (!item) {
          return;
        }
        this.releaseLightOcclusion(item);
        if (item.mesh) {
          item.rotationPivot.remove(item.mesh);
          item.mesh.dispose();
          item.mesh = null;
        }
        this.splatSceneRoot.remove(item.modelRoot);
      }

      resetModelMeta() {
        this.modelMeta = createDefaultModelMeta();
      }

      recomputeSceneBounds() {
        const visibleItems = this.sceneItems.filter((item) => item.visible && item.bounds);
        if (!visibleItems.length) {
          this.sceneBounds = null;
          this.sceneBoundsSphere = null;
          return;
        }
        const aggregate = visibleItems[0].bounds.clone();
        visibleItems.slice(1).forEach((item) => aggregate.union(item.bounds));
        this.sceneBounds = aggregate;
        this.sceneBoundsSphere = aggregate.getBoundingSphere(new THREE.Sphere());
      }

      toggleSceneItemVisibility(itemId) {
        const item = this.sceneItems.find((entry) => entry.id === itemId);
        if (!item) {
          return;
        }
        item.visible = !item.visible;
        item.rotationPivot.visible = item.visible;
        item.modelRoot.visible = item.visible;
        if (item.mesh) {
          item.mesh.visible = item.visible;
          item.mesh.updateGenerator?.();
        }
        this.recomputeSceneBounds();
        this.syncAlignUi();
        this.refreshHelpers();
        this.updateCameraClipping();
        this.syncTransformGizmo();
        this.syncSceneList();
        this.refreshLightingModel();
        this.refreshActiveBackendSnapshot("Visibility updated");
        this.updateStatus(`${item.modelMeta.name} ${item.visible ? "shown" : "hidden"}`);
        this.forceVisualRefresh(4);
      }

      removeSceneItem(itemId) {
        if (this.staticBakeApplied || this.staticBakeApplying) {
          if (this.staticBakeApplying) this.markStaticBakeStale("Scene removal requested");
          this.updateStatus("Clear / Restore the static bake before removing splats");
          return;
        }
        const index = this.sceneItems.findIndex((entry) => entry.id === itemId);
        if (index < 0) {
          return;
        }
        const [item] = this.sceneItems.splice(index, 1);
        if (item.id === this.activeAnimationTargetItemId) {
          this.clearAnimationScript(false);
        }
        this.removePickedColorsForItem(item.id);
        const wasSelected = item.id === this.selectedSceneItemId;
        this.disposeSceneItem(item);
        this.recomputeSceneBounds();
        this.syncAlignUi();
        if (wasSelected) {
          const nextItem = this.sceneItems[index] || this.sceneItems[index - 1] || null;
          this.selectSceneItem(nextItem?.id ?? null, false);
        } else {
          this.syncSceneList();
        }
        this.refreshHelpers();
        this.updateCameraClipping();
        this.syncTransformGizmo();
        this.refreshLightingModel({ forceModifierRebuild: true });
        this.refreshActiveBackendSnapshot("Scene item removed");
        this.updateMetaUi();
        this.updateStatus(`Removed ${item.modelMeta.name}`);
        if (!this.sceneItems.length) {
          this.resetModelMeta();
          this.syncSelectionRefs(null);
          this.applySelectedTransformState(true);
          this.syncBrushUi(true);
          this.showEmptyState();
          this.setProgress("Idle", 0);
          this.updateRenderChip("Cleared");
        }
        this.invalidateRender();
      }

      clearScene() {
        if (this.staticBakeApplied || this.staticBakeApplying) {
          if (this.staticBakeApplying) this.markStaticBakeStale("Scene clear requested");
          this.updateStatus("Clear / Restore the static bake before clearing the scene");
          return;
        }
        // A clear also cancels pending additive loads, so a late decoder
        // cannot silently repopulate the scene after it has been cleared.
        this.sceneLoadEpoch += 1;
        this.loadToken += 1;
        this.clearAnimationScript(false);
        this.sceneItems.forEach((item) => this.disposeSceneItem(item));
        this.sceneItems = [];
        this.syncAlignUi();
        this.sceneLights.forEach((light) => {
          this.lightSceneRoot.remove(light.root);
          light.root.traverse?.((child) => {
            child.geometry?.dispose?.();
            child.material?.dispose?.();
          });
        });
        this.sceneLights = [];
        this.pickedColors = [];
        this.selectedSceneItemId = null;
        this.selectedLightId = null;
        this.syncSelectionRefs(null);
        this.resetModelMeta();
        this.depthRangeIsAuto = true;
        this.sceneBounds = null;
        this.sceneBoundsSphere = null;
        this.applySelectedTransformState(true);
        this.syncSelectedSplatControls(true);
        this.syncSelectedLightControls(true);
        this.syncBrushUi(true);
        this.syncTransformGizmo();
        this.refreshHelpers();
        this.syncLightList();
        this.refreshLightingModel({ forceModifierRebuild: true });
        this.refreshActiveBackendSnapshot("Scene cleared");
        this.renderPickedColors();
        this.forceVisualRefresh(3);
      }

      confirmClearScene() {
        const splatCount = this.sceneItems.length;
        const lightCount = this.sceneLights.length;
        const splatLabel = `${splatCount} splat${splatCount === 1 ? "" : "s"}`;
        const lightLabel = `${lightCount} light${lightCount === 1 ? "" : "s"}`;
        return window.confirm(`Clear Scene?\n\nRemove ${splatLabel} and ${lightLabel}.`);
      }

      clearLoadedSplat() {
        this.clearScene();
        this.state.renderMode = "beauty";
        this.state.depthRange = DEPTH_RANGE_DEFAULT;
        this.state.positionRangeScale = 1;
        this.state.translateX = 0;
        this.state.translateY = 0;
        this.state.translateZ = 0;
        this.applyDepthRange(false);
        this.applyPositionRange(false);
        this.syncTransformInputs();
        this.updateMetaUi();
        this.updateModeUi();
        this.syncSceneList();
        this.showEmptyState();
        this.clearHoverReadout();
        this.setProgress("Idle", 0);
        if (this.isFileProtocol) {
          this.prepareFileProtocolMode();
        } else {
          this.dom.progressLabel.textContent = "Open a local file or drag one into the viewer.";
          this.updateRenderChip("Cleared");
          this.updateStatus("Cleared the loaded splat.");
        }
        this.forceVisualRefresh(3);
      }

      async fetchArrayBufferWithProgress(url, label) {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`${label} failed to download: ${response.status}`);
        }
        if (!response.body) {
          const buffer = await response.arrayBuffer();
          return { buffer, bytes: buffer.byteLength };
        }
        const totalBytes = Number(response.headers.get("content-length") || 0);
        const reader = response.body.getReader();
        const chunks = [];
        let loadedBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          chunks.push(value);
          loadedBytes += value.byteLength;
          this.setProgress(`Downloading ${label}`, totalBytes > 0 ? loadedBytes / totalBytes : null);
        }
        const merged = new Uint8Array(loadedBytes);
        let offset = 0;
        chunks.forEach((chunk) => {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        });
        return { buffer: merged.buffer, bytes: loadedBytes };
      }

      enqueueSceneLoad(load) {
        const epoch = this.sceneLoadEpoch;
        const request = this.sceneLoadQueue.then(() => {
          if (epoch !== this.sceneLoadEpoch) return false;
          return load(++this.loadToken);
        });
        // A failed request must not poison subsequent additive requests.
        this.sceneLoadQueue = request.catch(() => false);
        return request;
      }

      async loadFromFile(file) {
        if (!isSupportedFile(file)) {
          this.updateStatus(`Unsupported file type: ${file.name}`);
          return false;
        }
        return this.enqueueSceneLoad(async (requestToken) => {
          try {
            this.setProgress(`Reading ${file.name}`, null);
            const arrayBuffer = await file.arrayBuffer();
            return this.loadMesh({
              bytes: arrayBuffer.byteLength,
              fileBytes: arrayBuffer,
              fileName: file.name,
              fileType: detectSplatFileType(file.name),
              loadToken: requestToken,
              source: "Local file",
            });
          } catch (error) {
            if (requestToken !== this.loadToken) return false;
            const reason = error instanceof Error ? error.message : "The file could not be read";
            this.updateStatus(`Could not read ${file.name}: ${reason}`);
            this.updateRenderChip("Error");
            this.setProgress("Load failed", 0);
            if (!this.sceneItems.length) {
              this.showEmptyState();
            }
            return false;
          }
        });
      }

      async loadFromFiles(files) {
        const epoch = this.sceneLoadEpoch;
        const droppedFiles = Array.from(files || []);
        const supportedFiles = droppedFiles.filter((file) => isSupportedFile(file));
        const rejectedCount = droppedFiles.length - supportedFiles.length;
        if (!supportedFiles.length) {
          this.updateStatus("No supported splat files were found. Existing scene was kept.");
          return { addedCount: 0, rejectedCount };
        }

        let addedCount = 0;
        for (const file of supportedFiles) {
          if (epoch !== this.sceneLoadEpoch) return { addedCount, canceled: true, rejectedCount };
          if (await this.loadFromFile(file)) {
            addedCount += 1;
          }
        }
        if (epoch !== this.sceneLoadEpoch) return { addedCount, canceled: true, rejectedCount };

        const failedCount = supportedFiles.length - addedCount;
        const statusSuffix = [
          rejectedCount
            ? `Ignored ${rejectedCount} unsupported file${rejectedCount === 1 ? "" : "s"}.`
            : "",
          failedCount
            ? `${failedCount} supported file${failedCount === 1 ? "" : "s"} could not be added.`
            : "",
        ].filter(Boolean).join(" ");
        if (addedCount) {
          this.updateStatus(`Added ${addedCount} splat file${addedCount === 1 ? "" : "s"} to the scene. ${statusSuffix}`.trim());
        } else {
          this.updateStatus(`No splat files were added. ${statusSuffix}`.trim());
        }
        return { addedCount, failedCount, rejectedCount };
      }

      async loadFromUrl(url, fileName, source) {
        return this.enqueueSceneLoad(async (requestToken) => {
          const { buffer, bytes } = await this.fetchArrayBufferWithProgress(url, fileName);
          return this.loadMesh({
            bytes,
            fileBytes: buffer,
            fileName,
            fileType: detectSplatFileType(fileName),
            loadToken: requestToken,
            source,
          });
        });
      }

      async loadPrimitive(kind) {
        return this.enqueueSceneLoad(async (requestToken) => {
          try {
            const spec = await createPrimitiveSpec(kind);
            if (requestToken !== this.loadToken) return false;
            return await this.loadMesh({
              bytes: spec.bytes,
              fileBytes: spec.buffer,
              fileName: spec.name,
              fileType: SplatFileType.PLY,
              loadToken: requestToken,
              localBounds: spec.localBounds,
              primitiveMeta: spec,
              source: spec.source,
            });
          } catch (error) {
            if (requestToken !== this.loadToken) return false;
            this.updateStatus(error instanceof Error ? error.message : "Primitive load failed");
            this.updateRenderChip("Error");
            this.setProgress("Load failed", 0);
            return false;
          }
        });
      }

      async loadMesh({
        bytes,
        fileBytes,
        fileName,
        fileType,
        loadToken,
        localBounds,
        primitiveMeta,
        source,
      }) {
        const token = loadToken ?? ++this.loadToken;
        if (token !== this.loadToken) return false;
        const hadSceneItems = this.sceneItems.length > 0;
        const startedAt = performance.now();
        this.updateStatus(`Loading ${fileName}...`);
        this.updateRenderChip("Initializing");
        this.hideEmptyState();

        let mesh = null;
        try {
          mesh = new SplatMesh({
            fileBytes,
            fileType,
          });
          mesh.enableLod = false;
          mesh.name = fileName;
          if (primitiveMeta) {
            mesh.maxShDegree = primitiveMeta.shDegree;
          }
          await mesh.initialized;

          if (token !== this.loadToken) {
            mesh.dispose();
            return;
          }

          const sceneItem = this.createSceneItemRecord(fileName, source);
          sceneItem.mesh = mesh;
          sceneItem.sourceColorSpace = detectSplatColorSpace(readPlyHeaderText(fileBytes), Boolean(primitiveMeta));
          sceneItem.loadedShDegree = primitiveMeta?.shDegree ?? inferShDegree(mesh);
          sceneItem.settings.shLevel = THREE.MathUtils.clamp(sceneItem.loadedShDegree, 0, 3);
          if (primitiveMeta?.defaultSettings) {
            sceneItem.settings.exposure = primitiveMeta.defaultSettings.exposure ?? sceneItem.settings.exposure;
            sceneItem.settings.opacity = primitiveMeta.defaultSettings.opacity ?? sceneItem.settings.opacity;
            sceneItem.settings.falloff = primitiveMeta.defaultSettings.falloff ?? sceneItem.settings.falloff;
          }
          sceneItem.hoverEntries = primitiveMeta?.hoverEntries ?? null;
          const authoredSplatEntries = Array.isArray(primitiveMeta?.authoredSplats)
            ? primitiveMeta.authoredSplats
            : (Array.isArray(primitiveMeta?.splats) ? primitiveMeta.splats : null);
          sceneItem.hasAuthoredSplatNormals = Boolean(
            authoredSplatEntries?.length && authoredSplatEntries[0]?.normal,
          );
          sceneItem.authoredNormalEntries = sceneItem.hasAuthoredSplatNormals
            ? authoredSplatEntries
            : null;
          sceneItem.authoredBounceMaterialEntries = sceneItem.hasAuthoredSplatNormals
            ? authoredSplatEntries
            : null;
          sceneItem.baseObjectModifier = mesh.objectModifier;
          sceneItem.baseWorldModifier = mesh.worldModifier;
          mesh.userData.sceneItemId = sceneItem.id;
          this.sceneItems.push(sceneItem);
          this.selectedSceneItemId = sceneItem.id;
          this.selectedLightId = null;
          this.syncSelectionRefs(sceneItem);
          this.syncAnimationControls(true);

          this.depthRangeIsAuto = true;
          let meshLocalBounds;
          if (localBounds) {
            meshLocalBounds = localBounds.clone();
          } else {
            try {
              meshLocalBounds = mesh.getBoundingBox(false);
            } catch {
              meshLocalBounds = mesh.getBoundingBox(true);
            }
          }
          const centerBounds = primitiveMeta?.localBounds?.clone() ?? computeCenterBounds(mesh, meshLocalBounds);
          this.attachMesh(sceneItem, mesh, meshLocalBounds, centerBounds);
          if (!sceneItem.hoverEntries) {
            sceneItem.hoverEntries = this.createMeshHoverEntries(sceneItem);
          }
          this.applySelectedTransformState(true);
          this.syncSelectedSplatControls(true);
          this.syncBrushUi(true);
          this.applyOpacity(false);
          this.applyFalloff(false);
          this.applyExposure(false);
          if (primitiveMeta) {
            this.updatePrimitiveMeta(primitiveMeta);
          } else {
            this.updateCompressionMeta(fileName, bytes, mesh, fileBytes);
          }
          this.modelMeta.bytes = bytes;
          this.modelMeta.elapsedMs = performance.now() - startedAt;
          this.modelMeta.format = primitiveMeta?.format ?? (getFileExtension(fileName).toUpperCase() || "AUTO");
          this.modelMeta.name = fileName;
          this.modelMeta.source = source;
          this.modelMeta.splats = primitiveMeta?.splats ?? Number(mesh.numSplats ?? mesh.packedSplats?.numSplats ?? 0);

          this.recomputeBounds();
          if (!hadSceneItems && !this.hasCapturedInitialPose) {
            this.fitView({ preserveDirection: false, captureDefaultPose: true, announce: false });
          } else {
            this.updateCameraClipping();
          }
          this.configureDepthRangeFromBounds();
          this.refreshHelpers();
          this.syncSelectedLightControls(true);
          this.refreshLightingModel({ forceModifierRebuild: true });
          this.updateMetaUi();
          this.syncSceneList();
          this.syncLightList();
          this.refreshActiveBackendSnapshot("Splat loaded");
          this.setProgress("Ready", 1);
          this.updateRenderChip("Ready");
          this.updateStatus(`Loaded ${fileName}`);
          this.schedulePostLoadRefresh();
          return true;
        } catch (error) {
          this.updateStatus(error instanceof Error ? error.message : "Load failed");
          this.updateRenderChip("Error");
          this.setProgress("Load failed", 0);
          if (mesh) {
            mesh.dispose();
          }
          if (!this.sceneItems.length) {
            this.showEmptyState();
          }
          this.forceVisualRefresh(3);
          return false;
        }
      }

      attachMesh(item, mesh, localBoundsOverride = null, centerBoundsOverride = null) {
        let localBounds;
        if (localBoundsOverride) {
          localBounds = localBoundsOverride.clone();
        } else {
          try {
            localBounds = mesh.getBoundingBox(false);
          } catch {
            localBounds = mesh.getBoundingBox(true);
          }
        }
        const centerBounds = centerBoundsOverride
          ? centerBoundsOverride.clone()
          : computeCenterBounds(mesh, localBounds);
        item.baseLocalBounds = localBounds.clone();
        item.baseCenterBounds = centerBounds.clone();
        const center = centerBounds.getCenter(new THREE.Vector3());
        item.rotationPivot.position.set(0, 0, 0);
        mesh.position.copy(center.clone().multiplyScalar(-1));
        mesh.opacity = item.settings.opacity;
        item.rotationPivot.add(mesh);
        item.modelRoot.visible = item.visible;
        this.syncSelectionRefs(item);
        this.applySelectedTransformState(true);
        this.applyTransformFromInputs(false, true);
      }

      updatePrimitiveMeta(spec) {
        this.modelMeta.compression = spec.compression;
        this.modelMeta.compressionRatio = spec.compressionRatio;
        this.modelMeta.encoding = spec.encoding;
        this.modelMeta.packedCapacity = spec.packedCapacity;
        this.modelMeta.scaleRange = spec.scaleRange;
        this.modelMeta.shDegree = formatShLabel(spec.shDegree);
        this.modelMeta.activeSh = formatShLabel(spec.shDegree);
      }

      updateCompressionMeta(fileName, bytes, mesh, fileBytes) {
        const extension = getFileExtension(fileName);
        const splats = Number(mesh.numSplats ?? mesh.packedSplats?.numSplats ?? 0);
        const shDegree = this.loadedShDegree;
        const rawEstimate = estimateRawGaussianBytes(splats, shDegree);
        const compressionLabel = extension === "ply"
          ? detectPlyCompressionLabel(fileBytes)
          : (COMPRESSION_LABELS[extension] || "Unknown");
        const estimatedRatio = rawEstimate / Math.max(bytes, 1);
        const isCompressedPayload = extension !== "ply" || compressionLabel !== COMPRESSION_LABELS.ply;
        this.modelMeta.compression = compressionLabel;
        this.modelMeta.compressionRatio = isCompressedPayload
          ? formatRatio(estimatedRatio)
          : "1.00x baseline";
        this.modelMeta.shDegree = formatShLabel(shDegree);
        this.modelMeta.activeSh = formatShLabel(Math.min(this.state.shLevel, shDegree));
        this.modelMeta.encoding = formatEncodingMeta(mesh?.packedSplats?.splatEncoding);
        this.modelMeta.packedCapacity = Number.isFinite(mesh?.packedSplats?.maxSplats)
          ? `${mesh.packedSplats.maxSplats.toLocaleString()}`
          : "-";
        const packedArray = mesh?.packedSplats?.packedArray;
        if (packedArray && splats > 0) {
          let minScale = Infinity;
          let maxScale = 0;
          const sampleStep = Math.max(1, Math.ceil(splats / 200000));
          for (let index = 0; index < splats; index += sampleStep) {
            const splat = unpackSplat(packedArray, index, mesh.packedSplats?.splatEncoding);
            minScale = Math.min(minScale, splat.scales.x, splat.scales.y, splat.scales.z);
            maxScale = Math.max(maxScale, splat.scales.x, splat.scales.y, splat.scales.z);
          }
          this.modelMeta.scaleRange = formatScaleRange(minScale, maxScale);
        } else {
          this.modelMeta.scaleRange = "-";
        }
      }

      updatePositionModifierBounds() {
        if (!this.centerBounds) {
          this.positionModifierHandles.minCorner.value.set(0, 0, 0);
          this.positionModifierHandles.span.value.set(1, 1, 1);
          return;
        }
        const size = this.centerBounds.getSize(new THREE.Vector3());
        this.positionModifierHandles.minCorner.value.copy(this.centerBounds.min);
        this.positionModifierHandles.span.value.set(
          Math.max(size.x, 0.0001),
          Math.max(size.y, 0.0001),
          Math.max(size.z, 0.0001),
        );
      }

      setDefaultPoseFromCentroid() {
        const centerSphere = this.centerBoundsSphere ?? this.boundsSphere ?? this.sceneBoundsSphere;
        if (!centerSphere) {
          return;
        }
        const center = centerSphere.center.clone();
        const radius = Math.max(centerSphere.radius, 0.05);
        const framingRadius = Math.max(this.sceneBoundsSphere?.radius || this.boundsSphere?.radius || radius, radius);
        const lookTarget = center.clone().add(DEFAULT_LOOK.clone().multiplyScalar(Math.max(radius * 0.35, 1)));
        this.camera.position.copy(center);
        this.camera.lookAt(lookTarget);
        this.orbitControls.target.copy(lookTarget);
        this.updateOrbitDistances(framingRadius);
        this.orbitControls.update();
        this.updateCameraClipping(framingRadius * 1.5);
        this.firstPerson.syncFromCamera();
        this.captureCurrentPoseAsDefault();
        this.updateRenderChip("Centered at centroid");
        this.forceVisualRefresh(3);
      }

      fitView({ preserveDirection = false, captureDefaultPose = false, announce = true } = {}) {
        const targetSphere = this.sceneBoundsSphere ?? this.boundsSphere;
        if (!targetSphere) {
          return;
        }
        const center = targetSphere.center.clone();
        const radius = Math.max(targetSphere.radius, 0.05);
        const verticalHalfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
        const horizontalHalfFov = Math.atan(
          Math.tan(verticalHalfFov) * Math.max(this.camera.aspect, 0.1),
        );
        const limitAngle = Math.max(
          Math.min(verticalHalfFov, horizontalHalfFov),
          THREE.MathUtils.degToRad(8),
        );
        const distance = (radius / Math.sin(limitAngle)) * 1.08;
        const direction = preserveDirection
          ? this.getCurrentFitDirection(center)
          : DEFAULT_FIT.clone();
        this.camera.position.copy(center.clone().addScaledVector(direction, distance));
        this.camera.lookAt(center);
        this.orbitControls.target.copy(center);
        this.updateOrbitDistances(radius);
        this.orbitControls.update();
        this.firstPerson.syncFromCamera();
        this.updateCameraClipping(distance);
        if (captureDefaultPose) {
          this.captureCurrentPoseAsDefault();
        }
        this.updateRenderChip("Fit view");
        if (announce) {
          this.updateStatus("Framed the loaded splat");
        }
        this.forceVisualRefresh(3);
      }

      getCurrentFitDirection(center) {
        const direction = this.camera.position.clone().sub(center);
        if (direction.lengthSq() < 1e-6) {
          const forward = new THREE.Vector3();
          this.camera.getWorldDirection(forward);
          return forward.multiplyScalar(-1).normalize();
        }
        return direction.normalize();
      }

      updateOrbitDistances(radius) {
        this.orbitControls.minDistance = Math.max(radius * 0.001, 0.0005);
        this.orbitControls.maxDistance = Math.max(radius * 260, 1500);
      }

      syncDiagnosticTransform() {
        if (!this.currentMesh?.context?.transform) {
          return;
        }
        this.currentMesh.updateMatrixWorld(true);
        this.currentMesh.context.transform.updateFromMatrix(this.currentMesh.matrixWorld);
      }

      recomputeBounds() {
        const item = this.getSelectedItem();
        if (!item?.mesh || !item.baseLocalBounds) {
          this.bounds = null;
          this.boundsSphere = null;
          this.centerBounds = null;
          this.centerBoundsSphere = null;
          this.recomputeSceneBounds();
          return;
        }
        item.modelRoot.updateMatrixWorld(true);
        item.rotationPivot.updateMatrixWorld(true);
        item.mesh.updateMatrixWorld(true);
        this.syncDiagnosticTransform();
        item.bounds = item.baseLocalBounds.clone().applyMatrix4(item.mesh.matrixWorld);
        item.boundsSphere = item.bounds.getBoundingSphere(new THREE.Sphere());
        item.centerBounds = (item.baseCenterBounds ?? item.baseLocalBounds)
          .clone()
          .applyMatrix4(item.mesh.matrixWorld);
        item.centerBoundsSphere = item.centerBounds.getBoundingSphere(new THREE.Sphere());
        this.syncSelectionRefs(item);
        this.recomputeSceneBounds();
      }

      prepareFileProtocolMode() {
        this.dom.progressLabel.textContent =
          "Direct-open mode detected. Use Open File or drag a file into the viewer.";
        this.dom.infoSource.textContent = "Direct-open mode";
        this.updateStatus("Direct-open mode is active. Open a local file.");
        this.updateRenderChip("Open local file");
      }

      hideEmptyState() {
        this.dom.appShell?.classList.remove("is-empty");
        this.dom.emptyState.hidden = true;
        this.dom.dropOverlay.hidden = true;
      }

      showEmptyState() {
        this.dom.appShell?.classList.add("is-empty");
        this.dom.emptyState.hidden = false;
        this.dom.dropOverlay.hidden = true;
        this.syncOpenFileAction();
      }

      syncOpenFileAction() {
        const hasSceneItems = this.sceneItems.length > 0;
        const hasClearableContent = hasSceneItems || this.sceneLights.length > 0;
        if (this.dom.headerOpenFileButton) {
          this.dom.headerOpenFileButton.hidden = !hasSceneItems;
          this.dom.headerOpenFileButton.textContent = "Add File";
        }
        if (this.dom.clearSceneButton) {
          this.dom.clearSceneButton.disabled = !hasClearableContent;
        }
      }

      focusPick(event) {
        if (!this.sceneItems.length) {
          return;
        }
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObjects(
          this.sceneItems.filter((item) => item.visible && item.mesh).map((item) => item.mesh),
          true,
        );
        if (!hits.length) {
          return;
        }
        const sceneItemId = hits[0].object?.userData?.sceneItemId ?? hits[0].object?.parent?.userData?.sceneItemId;
        if (sceneItemId) {
          this.selectSceneItem(sceneItemId, false);
        }
        const focusPoint = hits[0].point;
        const offset = this.camera.position.clone().sub(this.orbitControls.target);
        this.orbitControls.target.copy(focusPoint);
        this.camera.position.copy(focusPoint.clone().add(offset));
        this.orbitControls.update();
        this.firstPerson.syncFromCamera();
        this.updateStatus(`Focus point updated: ${formatVector(focusPoint)}`);
        this.forceVisualRefresh(3);
      }

      queueHoverProbe(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          return;
        }
        this.hoverPointer = {
          x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
          y: -(((event.clientY - rect.top) / rect.height) * 2 - 1),
        };
        this.lastHoverPointer = { ...this.hoverPointer };
        if (this.hoverProbePending) {
          return;
        }
        this.hoverProbePending = true;
        requestAnimationFrame(() => {
          this.hoverProbePending = false;
          this.updateHoverReadout();
        });
      }

      legacyClearHoverReadout() {
        this.hoverPointer = null;
        const selectedItem = this.getSelectedItem();
        const itemText = clipPadText(selectedItem?.modelMeta?.name ?? "選択していない", 18);
        const colorText = clipPadText("色未知", 11);
        this.hoverReadout = `Item ${itemText} | Color ${colorText}`;
        if (this.dom.hoverChip) {
          this.dom.hoverChip.textContent = this.hoverReadout;
        }
      }

      legacyUpdateHoverReadout() {
        const selectedItem = this.getSelectedItem();
        if (!selectedItem) {
          this.clearHoverReadout();
          return;
        }
        const itemText = clipPadText(selectedItem.modelMeta.name, 18);
        let colorText = clipPadText("色未知", 11);
        if (!this.hoverPointer || !selectedItem.hoverEntries?.length || !selectedItem.mesh) {
          this.hoverReadout = `Item ${itemText} | Color ${colorText}`;
          if (this.dom.hoverChip) {
            this.dom.hoverChip.textContent = this.hoverReadout;
          }
          return;
        }
        this.pointer.set(this.hoverPointer.x, this.hoverPointer.y);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObjects(
          this.sceneItems.filter((item) => item.visible && item.mesh).map((item) => item.mesh),
          true,
        );
        if (hits.length) {
          hits.sort((left, right) => left.distance - right.distance);
          const hit = hits[0];
          const sceneItemId = hit.object?.userData?.sceneItemId ?? hit.object?.parent?.userData?.sceneItemId;
          if (sceneItemId === selectedItem.id) {
            let bestEntry = null;
            let bestDistance = Infinity;
            const worldPosition = new THREE.Vector3();
            selectedItem.hoverEntries.forEach((entry) => {
              worldPosition.copy(entry.position).applyMatrix4(selectedItem.mesh.matrixWorld);
              const distanceSq = worldPosition.distanceToSquared(hit.point);
              if (distanceSq < bestDistance) {
                bestDistance = distanceSq;
                bestEntry = entry;
              }
            });
            if (bestEntry) {
              colorText = clipPadText(formatHoverColor(bestEntry.color), 11);
            }
          }
        }
        this.hoverReadout = `Item ${itemText} | Color ${colorText}`;
        if (this.dom.hoverChip) {
          this.dom.hoverChip.textContent = this.hoverReadout;
        }
      }

      handleViewportPointerLeave() {
        this.clearHoverReadout();
        this.hideBrushOverlay();
      }

      clearHoverReadout() {
        this.hoverPointer = null;
        const selectedItem = this.getSelectedItem();
        const itemText = clipPadText(selectedItem?.modelMeta?.name ?? "Not selected", 18);
        const colorText = clipPadText("Unknown", 11);
        this.hoverReadout = `Item ${itemText} | Color ${colorText}`;
        this.setHoverChip(itemText, colorText);
      }

      updateHoverReadout() {
        const selectedItem = this.getSelectedItem();
        if (!selectedItem) {
          this.clearHoverReadout();
          return;
        }
        const itemText = clipPadText(selectedItem.modelMeta.name, 18);
        let colorText = clipPadText("Unknown", 11);
        const pointer = this.hoverPointer ?? this.lastHoverPointer;
        if (!pointer) {
          this.hoverReadout = `Item ${itemText} | Color ${colorText}`;
          this.setHoverChip(itemText, colorText);
          return;
        }
        const sample = selectedItem.hoverEntries?.length
          ? this.resolvePrimitivePointerSample(selectedItem, pointer)
          : this.resolvePackedPointerSample(selectedItem, pointer);
        if (sample) {
          colorText = clipPadText(
            formatHoverColor(this.getDisplayLinearColorForSample(selectedItem, sample)),
            11,
          );
        }
        this.hoverReadout = `Item ${itemText} | Color ${colorText}`;
        this.setHoverChip(itemText, colorText);
      }

      getSupportedDropFiles(files) {
        return Array.from(files || []).filter((file) => isSupportedFile(file));
      }

      updateDropOverlay(files, totalCount = 0) {
        const supportedCount = files.length;
        const rejectedCount = Math.max(0, totalCount - supportedCount);
        if (this.dom.dropOverlayMessage) {
          if (supportedCount) {
            const rejectedHint = rejectedCount
              ? ` ${rejectedCount} unsupported file${rejectedCount === 1 ? "" : "s"} will be ignored.`
              : "";
            this.dom.dropOverlayMessage.textContent = `Drop to add ${supportedCount} splat file${supportedCount === 1 ? "" : "s"} to the scene.${rejectedHint}`;
          } else {
            this.dom.dropOverlayMessage.textContent = "Drop .ply, .spz, .splat, or .ksplat files to add them. Existing splats stay.";
          }
        }
        this.dom.dropOverlay.hidden = false;
      }

      onDrag(event) {
        event.preventDefault();
        const dataTransfer = event.dataTransfer;
        const files = this.getSupportedDropFiles(dataTransfer?.files);
        const hasFilePayload = files.length || Array.from(dataTransfer?.types || []).includes("Files");
        if (!hasFilePayload) {
          this.dom.dropOverlay.hidden = true;
          return;
        }
        this.updateDropOverlay(files, dataTransfer?.files?.length || 0);
      }

      onDragLeave(event) {
        event.preventDefault();
        if (event.relatedTarget && this.dom.stage.contains(event.relatedTarget)) {
          return;
        }
        this.dom.dropOverlay.hidden = true;
      }

      async onDrop(event) {
        event.preventDefault();
        this.dom.dropOverlay.hidden = true;
        await this.loadFromFiles(event.dataTransfer?.files);
      }

      onResize() {
        const width = this.dom.stage.clientWidth;
        const height = this.dom.stage.clientHeight;
        if (!width || !height) {
          return;
        }
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height, false);
        this.renderActiveBackendFrame();
        this.invalidateRender();
      }

      refreshHelpers() {
        [this.axesHelper, this.axisLabelGroup, this.boundsHelper, this.gridHelper].forEach((helper) => {
          if (!helper) {
            return;
          }
          this.scene.remove(helper);
          helper.traverse?.((child) => {
            child.geometry?.dispose?.();
            if (Array.isArray(child.material)) {
              child.material.forEach((material) => {
                material.map?.dispose?.();
                material.dispose?.();
              });
            } else {
              child.material?.map?.dispose?.();
              child.material?.dispose?.();
            }
          });
          helper.geometry?.dispose?.();
          if (Array.isArray(helper.material)) {
            helper.material.forEach((material) => material.dispose?.());
          } else {
            helper.material?.dispose?.();
          }
        });
        this.axesHelper = null;
        this.axisLabelGroup = null;
        this.boundsHelper = null;
        this.gridHelper = null;
        this.currentGridScale = null;
        this.currentGridStep = null;

        const helperBounds = this.sceneBounds ?? this.bounds;
        if (!helperBounds) {
          return;
        }

        const autoGridBounds = this.sceneItems[0]?.baseLocalBounds ?? helperBounds;
        const autoGridSizeVector = autoGridBounds.getSize(new THREE.Vector3());
        const autoGridSize = Math.max(autoGridSizeVector.x, autoGridSizeVector.z, 1) * 1.8;
        const gridSize = this.state.gridScaleMode === "auto"
          ? autoGridSize
          : Math.max(this.state.gridScaleValue, 0.01);
        const gridStep = this.getAutoGridStep(gridSize);
        const divisions = Math.max(1, Math.round(gridSize / gridStep));

        if (this.state.showGrid) {
          this.gridHelper = new THREE.GridHelper(
            gridSize,
            divisions,
            new THREE.Color("#5ce2c3"),
            new THREE.Color("#20384d"),
          );
          this.gridHelper.position.set(0, 0, 0);
          this.scene.add(this.gridHelper);
        }
        this.currentGridScale = gridSize;
        this.currentGridStep = gridStep;

        if (this.state.showAxes) {
          const axesLength = Math.max(gridSize * 0.5, 0.5);
          this.axesHelper = new THREE.AxesHelper(axesLength);
          this.axesHelper.position.set(0, 0, 0);
          this.scene.add(this.axesHelper);
          this.axisLabelGroup = new THREE.Group();
          const labelOffset = Math.max(axesLength * 1.12, 0.75);
          const xLabel = createAxisLabelSprite("X", "#ff6d6d");
          xLabel.position.set(labelOffset, 0, 0);
          const yLabel = createAxisLabelSprite("Y", "#63ff92");
          yLabel.position.set(0, labelOffset, 0);
          const zLabel = createAxisLabelSprite("Z", "#5da7ff");
          zLabel.position.set(0, 0, labelOffset);
          this.axisLabelGroup.add(xLabel, yLabel, zLabel);
          this.scene.add(this.axisLabelGroup);
        }

        if (this.state.showBounds) {
          this.boundsHelper = new THREE.Box3Helper(helperBounds.clone(), new THREE.Color("#b7e7ff"));
          this.scene.add(this.boundsHelper);
        }
        this.invalidateRender();
      }

      renderLoop() {
        const frameStartedAt = performance.now();
        const delta = Math.min(this.clock.getDelta(), 0.05);
        let visualMotion = false;
        const animationUpdated = this.stepAnimation(delta);
        const animationPlaying = shouldRenderAnimationFrame(this.state);
        const movedByKeys = Boolean(this.firstPerson.update(delta));
        if (movedByKeys && this.activeMode === "orbit") {
          this.orbitControls.target.add(this.firstPerson.lastMovementDelta);
        }
        if (movedByKeys) {
          this.updateCameraClipping();
          this.scheduleCameraDependentAppearanceRefresh();
        }
        if (this.activeMode === "orbit") {
          this.orbitControls.autoRotate = this.state.autoRotate;
          visualMotion = Boolean(this.orbitControls.enabled && this.orbitControls.update());
        } else {
          visualMotion = movedByKeys;
        }
        visualMotion = visualMotion || movedByKeys || animationUpdated;
        const keepAnimating = visualMotion || animationPlaying;
        const timedRenderActive = this.isTimedRenderActive(frameStartedAt);
        const scheduledReady = !this.scheduledRenderAt || frameStartedAt >= this.scheduledRenderAt;
        const shouldDraw = (this.renderInvalidated && scheduledReady)
          || visualMotion
          || this.pendingForcedFrames > 0
          || timedRenderActive;
        if (!shouldDraw) {
          return Boolean(this.renderInvalidated && !scheduledReady);
        }
        this.syncVisibleSceneItemTransforms();
        const frameDelay = this.getRenderFrameDelay(frameStartedAt);
        const canDrawNow = frameDelay <= 1
          || (this.renderInvalidated && scheduledReady)
          || visualMotion
          || this.pendingForcedFrames > 0;
        if (shouldDraw && canDrawNow) {
          this.flushRenderNow();
        }
        return keepAnimating
          || this.pendingForcedFrames > 0
          || this.renderInvalidated
          || Boolean(this.scheduledRenderAt)
          || this.isTimedRenderActive();
      }

      resetTransform() {
        const selectedItem = this.getSelectedItem();
        if (selectedItem) this.markStaticBakeStale("Splat transform reset");
        this.state.rotationX = 0;
        this.state.rotationY = 0;
        this.state.rotationZ = 0;
        this.state.scale = 1;
        this.state.translateX = 0;
        this.state.translateY = 0;
        this.state.translateZ = 0;
        if (selectedItem) {
          selectedItem.transform.rotationX = 0;
          selectedItem.transform.rotationY = 0;
          selectedItem.transform.rotationZ = 0;
          selectedItem.transform.scale = 1;
          selectedItem.transform.translateX = 0;
          selectedItem.transform.translateY = 0;
          selectedItem.transform.translateZ = 0;
        }
        if (!this.modelRoot || !this.rotationPivot) {
          this.syncTransformInputs();
          return;
        }
        this.modelRoot.position.set(0, 0, 0);
        this.rotationPivot.rotation.set(0, 0, 0);
        this.rotationPivot.scale.setScalar(1);
        this.rotationPivot.updateMatrixWorld(true);
        this.syncTransformInputs();
        this.syncTransformGizmo();
        if (this.currentMesh) {
          this.recomputeBounds();
          this.configureDepthRangeFromBounds();
          this.updatePositionModifierBounds();
          this.refreshHelpers();
          this.updateMetaUi();
          this.updateCameraClipping();
        }
        this.queueSparkSceneUpdate();
        this.refreshActiveBackendSnapshot("Transform reset");
        this.updateStatus("Reset splat transform");
        this.updateRenderChip("Transform reset");
        this.forceVisualRefresh(3);
      }

      resetView() {
        if (!this.defaultPose) {
          return;
        }
        this.state.focalLength = this.defaultPose.focalLength;
        this.applyFocalLength(false);
        this.camera.position.copy(this.defaultPose.position);
        this.camera.quaternion.copy(this.defaultPose.quaternion);
        this.camera.near = this.defaultPose.near;
        this.camera.far = this.defaultPose.far;
        this.camera.updateProjectionMatrix();
        this.orbitControls.target.copy(this.defaultPose.target);
        this.orbitControls.update();
        this.firstPerson.syncFromCamera();
        this.updateRenderChip("Reset view");
        this.updateStatus("Returned to saved default view");
        this.forceVisualRefresh(3);
      }

      setMode(mode) {
        const nextMode = mode === "orbit" ? "orbit" : "fps";
        if (this.activeMode === nextMode) {
          return;
        }
        if (nextMode === "fps") {
          this.orbitControls.enabled = false;
          this.orbitControls.disconnect?.();
          this.firstPerson.setPointerEnabled(true);
          this.firstPerson.setMovementEnabled(true);
        } else {
          this.syncOrbitTargetFromView();
          this.firstPerson.setPointerEnabled(false);
          this.firstPerson.setMovementEnabled(true);
          this.orbitControls.connect?.(this.renderer.domElement);
          this.orbitControls.enabled = true;
          this.orbitControls.update();
        }
        this.activeMode = nextMode;
        this.updateModeUi();
        this.updateStatus(`Camera mode: ${this.activeMode === "fps" ? "First-person" : "Orbit"}`);
        this.invalidateRender();
      }

      setRenderMode(mode) {
        const nextMode = Object.prototype.hasOwnProperty.call(RENDER_MODE_LABELS, mode) ? mode : "beauty";
        const selectedItem = this.getSelectedItem();
        this.state.renderMode = nextMode;
        if (selectedItem) {
          selectedItem.settings.renderMode = nextMode;
        }
        this.applyRenderMode(true);
        this.updateModeUi();
      }

      shouldAttachAnimationModifier() {
        return Boolean(
          this.activeAnimationModifier
          && this.isSparkAnimationAvailable()
          && this.state.animationApplied
          && this.getActiveAnimationTargetItem()
          && (this.state.animationPlaying || this.state.animationTime > 0),
        );
      }

      applyRenderMode(updateChip = true) {
        this.syncLightingRuntimeState();
        const animationModifier = this.shouldAttachAnimationModifier() ? this.activeAnimationModifier : null;
        this.sceneItems.forEach((item) => {
          if (!item.mesh) {
            return;
          }
          const itemMode = item.id === this.selectedSceneItemId
            ? (this.state.renderMode || "beauty")
            : "beauty";
          const objectModifiers = [];
          // Decode after source SH evaluation, before exposure, lights, and
          // grading. Never transform individual SH coefficients nonlinearly.
          if (itemMode === "beauty" && item.sourceColorSpace !== SPLAT_COLOR_SPACE.LINEAR) {
            objectModifiers.push(createSplatColorTransferModifier(true));
          }
          if (item.baseObjectModifier) {
            objectModifiers.push(item.baseObjectModifier);
          }
          if (animationModifier && item.id === this.activeAnimationTargetItemId) {
            objectModifiers.push(animationModifier);
          }
          item.mesh.enableWorldToView = false;
          item.mesh.enableLod = false;
          item.mesh.objectModifiers = objectModifiers.length ? objectModifiers : undefined;
          item.mesh.covObjectModifiers = item.mesh.objectModifiers;
          item.mesh.worldModifier = undefined;
          item.mesh.worldModifiers = item.baseWorldModifier ? [item.baseWorldModifier] : undefined;
          item.mesh.covWorldModifiers = item.mesh.worldModifiers;
          item.mesh.updateMatrixWorld(true);
          item.mesh.context?.transform?.updateFromMatrix(item.mesh.matrixWorld);
          if (itemMode === "beauty") {
            const worldModifiers = [];
            if (item.baseWorldModifier) {
              worldModifiers.push(item.baseWorldModifier);
            }
            if (this.activeLightCount > 0 && !this.staticBakeApplied) {
              worldModifiers.push(createPointLightColorModifier({
                cameraPosition: this.lightHandles.cameraPosition,
                faceForwardToCamera: !item.hasAuthoredSplatNormals,
                lightColorB: this.lightHandles.colorB,
                lightColorG: this.lightHandles.colorG,
                lightColorR: this.lightHandles.colorR,
                lightCount: this.activeLightCount,
                lightIntensities: this.lightHandles.intensities,
                lightOccluderCount: this.activeOccluderCount,
                lightOcclusionHandles: this.getLightOcclusionHandles(item),
                lightPositions: this.lightHandles.positions,
                lightTypes: this.lightHandles.types,
                lightDirections: this.lightHandles.directions,
                occluderOpacities: this.lightHandles.occluderOpacities,
                occluderPositions: this.lightHandles.occluderPositions,
                occluderRadii: this.lightHandles.occluderRadii,
                oneBounceFluxB: this.lightHandles.oneBounceFluxB,
                oneBounceFluxG: this.lightHandles.oneBounceFluxG,
                oneBounceFluxR: this.lightHandles.oneBounceFluxR,
                oneBounceNormals: this.lightHandles.oneBounceNormals,
                oneBouncePositions: this.lightHandles.oneBouncePositions,
                oneBounceRadii: this.lightHandles.oneBounceRadii,
              }));
            }
            if (!isNeutralToneCurve(item.settings.toneCurve)) {
              worldModifiers.push(createToneCurveColorModifier(item.settings.toneCurve));
            }
            // Spark's native splat shader writes encoded RGB directly; the
            // host renderer.outputColorSpace setting does not encode it.
            worldModifiers.push(createSplatColorTransferModifier(false));
            item.mesh.worldModifiers = worldModifiers.length ? worldModifiers : undefined;
            item.mesh.covWorldModifiers = item.mesh.worldModifiers;
          } else if (itemMode === "depth") {
            item.mesh.enableWorldToView = true;
            item.mesh.worldModifier = createDepthColorModifier(
              this.depthModifierHandles,
              item.mesh.context.worldToView,
            );
            item.mesh.covWorldModifiers = undefined;
          } else if (itemMode === "position") {
            if (item.id === this.selectedSceneItemId) {
              this.updatePositionModifierBounds();
            }
            item.mesh.worldModifier = createPositionColorModifier(this.positionModifierHandles);
            item.mesh.covWorldModifiers = undefined;
          } else if (itemMode === "worldNormal") {
            item.mesh.worldModifier = createWorldNormalModifier();
            item.mesh.covWorldModifiers = undefined;
          }
        });
        this.syncMeshExposure();
        this.applyShLevel(true);
        this.updateNormalizeFieldState();
        this.renderPickedColors();
        if (updateChip) {
          this.updateRenderChip(`${RENDER_MODE_LABELS[this.state.renderMode] || "Beauty"} mode`);
          this.updateStatus(`Render mode: ${RENDER_MODE_LABELS[this.state.renderMode] || "Beauty"}`);
        }
        this.invalidateRender();
        this.queueSparkSceneUpdate();
      }

      syncOrbitTargetFromView() {
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        const targetSphere = this.sceneBoundsSphere ?? this.boundsSphere;
        const focusDistance = targetSphere ? Math.max(targetSphere.radius * 0.9, 1.2) : 3;
        this.orbitControls.target.copy(
          this.camera.position.clone().addScaledVector(forward, focusDistance),
        );
        this.orbitControls.update();
      }

      scheduleRender(delayMs = 0) {
        const targetTime = performance.now() + Math.max(0, Number(delayMs) || 0);
        if (delayMs <= 0) {
          this.scheduledRenderAt = 0;
        } else if (!this.scheduledRenderAt || targetTime < this.scheduledRenderAt) {
          this.scheduledRenderAt = targetTime;
        }
        this.startAnimationLoop();
      }

      forceVisualRefresh(frameCount = 2) {
        this.pendingForcedFrames = Math.max(
          this.pendingForcedFrames,
          Math.max(1, Math.round(Number(frameCount) || 1)),
        );
        this.invalidateRender();
      }

      schedulePostLoadRefresh() {
        if (this.postLoadRefreshHandle) {
          window.clearTimeout(this.postLoadRefreshHandle);
          this.postLoadRefreshHandle = 0;
        }
        this.forceVisualRefresh(4);
        this.postLoadRefreshHandle = window.setTimeout(() => {
          this.postLoadRefreshHandle = 0;
          this.forceVisualRefresh(4);
          window.setTimeout(() => {
            this.forceVisualRefresh(3);
          }, 120);
        }, 40);
      }

      invalidateRender(immediate = true) {
        this.renderInvalidated = true;
        if (immediate) {
          this.scheduledRenderAt = 0;
        } else {
          this.scheduleRender(this.idleRenderDelayMs);
          return;
        }
        this.scheduleRender(0);
      }

      captureCurrentPoseAsDefault() {
        this.defaultPose = {
          far: this.camera.far,
          focalLength: this.state.focalLength,
          near: this.camera.near,
          position: this.camera.position.clone(),
          quaternion: this.camera.quaternion.clone(),
          target: this.orbitControls.target.clone(),
        };
        this.hasCapturedInitialPose = true;
      }

      setProgress(label, ratio) {
        this.dom.progressLabel.textContent = label;
        this.dom.progressTrack.classList.toggle("is-indeterminate", ratio == null);
        this.dom.progressFill.style.width = ratio == null ? "32%" : `${Math.max(0, Math.min(ratio, 1)) * 100}%`;
      }

      toggleHelper(stateKey) {
        this.state[stateKey] = !this.state[stateKey];
        this.refreshHelpers();
        this.syncToggleButtons();
        this.invalidateRender();
      }

      syncToggleButtons() {
        this.dom.toggleAutorotateButton.classList.toggle("is-active", this.state.autoRotate);
        this.dom.toggleAxesButton.classList.toggle("is-active", this.state.showAxes);
        this.dom.toggleBoundsButton.classList.toggle("is-active", this.state.showBounds);
        this.dom.toggleGridButton.classList.toggle("is-active", this.state.showGrid);
        this.dom.toggleAutorotateButton.setAttribute("aria-pressed", String(this.state.autoRotate));
        this.dom.toggleAxesButton.setAttribute("aria-pressed", String(this.state.showAxes));
        this.dom.toggleBoundsButton.setAttribute("aria-pressed", String(this.state.showBounds));
        this.dom.toggleGridButton.setAttribute("aria-pressed", String(this.state.showGrid));
      }

      updateCameraClipping(distanceHint) {
        const targetSphere = this.sceneBoundsSphere ?? this.boundsSphere;
        if (!targetSphere) {
          return;
        }
        const radius = Math.max(targetSphere.radius, 0.05);
        const distance = distanceHint ?? Math.max(this.camera.position.distanceTo(targetSphere.center), radius * 0.25);
        this.camera.near = Math.max(radius / 5000, 0.0005);
        this.camera.far = Math.max(distance + radius * 420, radius * 1500, 2400);
        this.camera.updateProjectionMatrix();
      }

      syncVisibleSceneItemTransforms() {
        this.sceneItems.forEach((item) => {
          if (!item.visible || !item.mesh) {
            return;
          }
          item.modelRoot.updateMatrixWorld(true);
          item.rotationPivot.updateMatrixWorld(true);
          item.mesh.updateMatrixWorld(true);
        });
      }

      updateCameraUi() {
        const gridText = Number.isFinite(this.currentGridScale)
          ? `Grid ${formatNumber(this.currentGridScale, this.currentGridScale < 10 ? 2 : 0)}`
          : "Grid -";
        this.dom.gridChip.textContent = gridText;
        this.dom.cameraChip.textContent = `Cam ${formatVector(this.camera.position)}`;
      }

      updateFps() {
        this.frameCounter += 1;
        const now = performance.now();
        if (now - this.lastFpsUpdate < 500) {
          return;
        }
        const fps = (this.frameCounter * 1000) / (now - this.lastFpsUpdate);
        this.dom.fpsChip.textContent = `${fps.toFixed(1)} fps`;
        this.frameCounter = 0;
        this.lastFpsUpdate = now;
      }

      updateMetaUi() {
        const center = this.centerBoundsSphere?.center ?? this.boundsSphere?.center ?? null;
        this.dom.infoName.textContent = this.modelMeta.name;
        this.dom.infoFormat.textContent = this.modelMeta.format;
        this.dom.infoSource.textContent = this.modelMeta.source;
        this.dom.infoSize.textContent = formatBytes(this.modelMeta.bytes);
        this.dom.infoSplats.textContent = this.modelMeta.splats
          ? this.modelMeta.splats.toLocaleString()
          : "-";
        this.dom.infoLoadTime.textContent = this.modelMeta.elapsedMs
          ? `${this.modelMeta.elapsedMs.toFixed(0)} ms`
          : "-";
        this.dom.infoCenter.textContent = center ? formatVector(center) : "-";
        this.dom.infoBounds.textContent = this.bounds
          ? formatVector(this.bounds.getSize(new THREE.Vector3()))
          : "-";
        this.dom.infoScaleRange.textContent = this.modelMeta.scaleRange;
        this.dom.infoShDegree.textContent = this.modelMeta.shDegree;
        this.dom.infoShActive.textContent = this.modelMeta.activeSh;
        this.dom.infoCompression.textContent = this.modelMeta.compression;
        this.dom.infoCompressionRatio.textContent = this.modelMeta.compressionRatio;
        this.dom.infoEncoding.textContent = this.modelMeta.encoding;
        this.dom.infoPackedCapacity.textContent = this.modelMeta.packedCapacity;
      }

      updateModeUi() {
        this.dom.modeButtons.forEach((button) => {
          const isActive = button.dataset.mode === this.activeMode;
          button.classList.toggle("is-active", isActive);
          button.setAttribute("aria-pressed", String(isActive));
        });
        this.dom.renderModeSelect.value = this.state.renderMode;
        this.updateNormalizeFieldState();
      }

      setAnimationOriginMode(mode) {
        if (!this.activeAnimationScript || !this.isSparkAnimationAvailable() || !this.getSelectedItem()) {
          this.syncAnimationOriginControls();
          return;
        }
        if (this.state.animationApplied) this.markStaticBakeStale("Animation origin changed");
        this.activeAnimationScript.originMode = mode === "manual" ? "manual" : "centroid";
        this.syncAnimationEditor();
        this.syncAnimationOriginControls();
        if (this.state.animationApplied) {
          this.applyActiveAnimationUniforms();
          this.forceVisualRefresh(2);
          this.queueSparkSceneUpdate();
        }
      }

      setAnimationOriginAxis(axis, value) {
        if (!this.activeAnimationScript || !this.isSparkAnimationAvailable() || !this.getSelectedItem()) {
          this.syncAnimationOriginControls();
          return;
        }
        if (this.state.animationApplied) this.markStaticBakeStale("Animation origin changed");
        this.activeAnimationScript.originMode = "manual";
        this.activeAnimationScript.origin[axis] = clampNumber(value, TRANSLATE_LIMITS);
        this.syncAnimationEditor();
        this.syncAnimationOriginControls();
        if (this.state.animationApplied) {
          this.applyActiveAnimationUniforms();
          this.forceVisualRefresh(2);
          this.queueSparkSceneUpdate();
        }
      }

      syncAnimationOriginControls() {
        const script = this.activeAnimationScript;
        const originMode = script?.originMode === "manual" ? "manual" : "centroid";
        const selectedItem = this.getSelectedItem();
        const target = this.getActiveAnimationTargetItem();
        const disabled = !script || !this.isSparkAnimationAvailable() || !selectedItem
          || (this.state.animationApplied && target?.id !== selectedItem.id);
        if (this.dom.animationOriginModeSelect) {
          this.dom.animationOriginModeSelect.value = originMode;
          this.dom.animationOriginModeSelect.disabled = disabled;
        }
        const x = script?.origin?.x ?? 0;
        const y = script?.origin?.y ?? 0;
        const z = script?.origin?.z ?? 0;
        if (this.dom.animationOriginXInput) {
          this.dom.animationOriginXInput.value = Number(x).toFixed(3);
          this.dom.animationOriginXInput.disabled = disabled || originMode !== "manual";
        }
        if (this.dom.animationOriginYInput) {
          this.dom.animationOriginYInput.value = Number(y).toFixed(3);
          this.dom.animationOriginYInput.disabled = disabled || originMode !== "manual";
        }
        if (this.dom.animationOriginZInput) {
          this.dom.animationOriginZInput.value = Number(z).toFixed(3);
          this.dom.animationOriginZInput.disabled = disabled || originMode !== "manual";
        }
      }

      syncAnimationEditor({ force = false } = {}) {
        if (this.dom.animationScriptEditor) {
          if (force || !this.animationEditorDirty) {
            this.animationEditorDraft = this.activeAnimationScript
              ? serializeAnimationScript(this.activeAnimationScript)
              : "";
            this.dom.animationScriptEditor.value = this.animationEditorDraft;
            this.animationEditorDirty = false;
          }
          this.dom.animationScriptEditor.dataset.dirty = String(this.animationEditorDirty);
        }
        if (this.dom.animationPresetSelect) {
          this.dom.animationPresetSelect.value = this.activeAnimationScript?.preset || "explosion";
        }
        this.syncAnimationScriptStatus();
        this.syncAnimationOriginControls();
      }

      syncAnimationScriptStatus() {
        if (!this.dom.animationScriptStatus) {
          return;
        }
        if (this.animationEditorDirty) {
          this.dom.animationScriptStatus.textContent = this.isSparkAnimationAvailable()
            ? "Script edits are preserved but not applied. Press Apply to use them."
            : "Script edits are preserved. Switch to Spark, then press Apply.";
          return;
        }
        if (!this.isSparkAnimationAvailable()) {
          this.dom.animationScriptStatus.textContent = "Animation: Spark only. Switch to Spark to animate the selected item.";
          return;
        }
        if (!this.activeAnimationScript) {
          this.dom.animationScriptStatus.textContent = "Load a preset or script, then apply it to the selected splat.";
          return;
        }
        const target = this.getActiveAnimationTargetItem();
        const selectedItem = this.getSelectedItem();
        if (this.state.animationApplied && !target) {
          this.dom.animationScriptStatus.textContent = "Animation target is no longer in the scene. Select an item and apply the script again.";
          return;
        }
        if (this.state.animationApplied && this.state.animationPlaying) {
          this.dom.animationScriptStatus.textContent = selectedItem?.id === target.id
            ? `Playing ${this.activeAnimationScript.name} on ${target.modelMeta.name}. Pause, Reset, or Clear Script to stop.`
            : `Playing ${this.activeAnimationScript.name} on ${target.modelMeta.name}. Select that item to control it.`;
          return;
        }
        if (this.state.animationApplied) {
          this.dom.animationScriptStatus.textContent = selectedItem?.id === target.id
            ? `${this.activeAnimationScript.name} is applied to ${target.modelMeta.name}. Press Play to animate the selected item.`
            : `${this.activeAnimationScript.name} is applied to ${target.modelMeta.name}. Select that item to control it.`;
          return;
        }
        this.dom.animationScriptStatus.textContent = `${this.activeAnimationScript.name} is loaded. Select an item and apply the script to animate it.`;
      }

      syncAnimationControls(syncSlider = true) {
        const duration = Math.max(this.state.animationDuration || this.activeAnimationScript?.duration || 0, 0);
        const animationSupported = this.isSparkAnimationAvailable();
        const target = this.getActiveAnimationTargetItem();
        const selectedItem = this.getSelectedItem();
        const targetIsSelected = !this.state.animationApplied || target?.id === selectedItem?.id;
        const canEdit = Boolean(animationSupported && selectedItem && targetIsSelected);
        const canPlay = Boolean(animationSupported && target && targetIsSelected && canPlayAnimation({
          animationApplied: this.state.animationApplied,
          hasModifier: Boolean(this.activeAnimationModifier),
        }));
        this.state.animationDuration = duration;
        if (this.dom.timelineContext) {
          this.dom.timelineContext.textContent = !animationSupported
            ? "Animation is available in Spark."
            : !selectedItem
              ? "Select a splat to animate."
              : target
                ? `${this.state.animationPlaying ? "Playing" : (target.id === selectedItem.id ? "Controlling" : "Active")} ${target.modelMeta.name}.`
                : `Controls ${selectedItem.modelMeta.name}.`;
        }
        if (this.dom.animationTimeRange) {
          this.dom.animationTimeRange.max = String(Math.max(duration, 0.01));
          if (syncSlider) {
            this.dom.animationTimeRange.value = String(Math.min(Math.max(this.state.animationTime, 0), Math.max(duration, 0.01)));
          }
          this.dom.animationTimeRange.disabled = !canPlay;
        }
        if (this.dom.animationTimeLabel) {
          this.dom.animationTimeLabel.textContent = `${this.state.animationTime.toFixed(2)}s / ${duration.toFixed(2)}s`;
        }
        if (this.dom.animationLoopCheckbox) {
          this.dom.animationLoopCheckbox.checked = Boolean(this.state.animationLoop);
          this.dom.animationLoopCheckbox.disabled = !canEdit || !this.activeAnimationScript;
        }
        if (this.dom.animationPlayButton) {
          this.dom.animationPlayButton.classList.toggle("is-active", this.state.animationPlaying);
          this.dom.animationPlayButton.disabled = !canPlay;
        }
        if (this.dom.animationPauseButton) {
          this.dom.animationPauseButton.classList.toggle("is-active", !this.state.animationPlaying);
          this.dom.animationPauseButton.disabled = !animationSupported || !target || !targetIsSelected || !this.state.animationPlaying;
        }
        if (this.dom.animationResetButton) {
          this.dom.animationResetButton.disabled = !animationSupported || !target || !targetIsSelected || !this.state.animationApplied;
        }
        [
          this.dom.animationApplyButton,
          this.dom.animationLoadPresetButton,
          this.dom.animationOpenButton,
          this.dom.animationPresetSelect,
          this.dom.animationSaveButton,
          this.dom.animationScriptEditor,
        ].forEach((control) => {
          if (control) control.disabled = !canEdit;
        });
        if (this.dom.animationCopyDefaultButton) {
          this.dom.animationCopyDefaultButton.disabled = !animationSupported || !this.activeAnimationScript;
        }
        this.syncTimelineToggle();
        this.syncAnimationScriptStatus();
      }

      syncAnimationPlaybackUi() {
        const duration = Math.max(this.state.animationDuration || this.activeAnimationScript?.duration || 0, 0);
        if (this.dom.animationTimeRange) {
          this.dom.animationTimeRange.value = String(Math.min(Math.max(this.state.animationTime, 0), Math.max(duration, 0.01)));
        }
        if (this.dom.animationTimeLabel) {
          this.dom.animationTimeLabel.textContent = `${this.state.animationTime.toFixed(2)}s / ${duration.toFixed(2)}s`;
        }
      }

      resolveAnimationOrigin(script) {
        if (!script) {
          return new THREE.Vector3();
        }
        if (script.originMode === "centroid") {
          return this.getActiveAnimationTargetItem()?.baseCenterBounds?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3();
        }
        return new THREE.Vector3(script.origin.x, script.origin.y, script.origin.z);
      }

      applyActiveAnimationUniforms() {
        if (!this.activeAnimationScript || !this.isSparkAnimationAvailable() || !this.getActiveAnimationTargetItem()) {
          return;
        }
        const { params } = this.activeAnimationScript;
        const origin = this.resolveAnimationOrigin(this.activeAnimationScript);
        this.animationModifierHandles.origin.value.copy(origin);
        this.animationModifierHandles.distanceScale.value = params.distanceScale;
        this.animationModifierHandles.opacityPower.value = params.opacityPower;
        this.animationModifierHandles.scaleInfluence.value = params.scaleInfluence;
        this.animationModifierHandles.speed.value = params.speed;
        this.animationModifierHandles.strength.value = params.strength;
        this.animationModifierHandles.swirl.value = params.swirl;
        this.animationModifierHandles.time.value = this.state.animationTime;
      }

      clearAnimationScript(announce = false) {
        if (this.state.animationApplied || this.activeAnimationModifier) this.markStaticBakeStale("Animation modifier cleared");
        this.activeAnimationScript = null;
        this.activeAnimationModifier = null;
        this.activeAnimationTargetItemId = null;
        Object.assign(this.state, createDefaultAnimationPlaybackState(null));
        this.pendingAnimationDelta = 0;
        this.animationModifierHandles.time.value = 0;
        this.syncAnimationEditor({ force: true });
        this.syncAnimationControls(true);
        this.syncStaticBakeUi();
        this.applyRenderMode(false);
        this.forceVisualRefresh(2);
        this.queueSparkSceneUpdate();
        if (announce) {
          this.updateStatus("Animation cleared");
          this.updateRenderChip("Animation off");
        }
      }

      loadAnimationPreset(name) {
        if (!this.isSparkAnimationAvailable() || !this.getSelectedItem()) {
          this.syncAnimationControls(true);
          this.syncAnimationScriptStatus();
          return;
        }
        try {
          this.activeAnimationScript = parseAnimationScript(getAnimationPresetScriptText(name));
          this.activeAnimationModifier = null;
          this.activeAnimationTargetItemId = null;
          this.state.animationApplied = false;
          this.state.animationLoop = this.activeAnimationScript.loop;
          this.state.animationDuration = this.activeAnimationScript.duration;
          this.state.animationPlaying = false;
          this.state.animationTime = 0;
          this.pendingAnimationDelta = 0;
          this.syncAnimationEditor({ force: true });
          this.syncAnimationControls(true);
          this.syncStaticBakeUi();
          this.applyRenderMode(false);
          this.forceVisualRefresh(2);
          this.queueSparkSceneUpdate();
          this.updateStatus(`Loaded ${this.activeAnimationScript.name}`);
        } catch (error) {
          this.updateStatus(error instanceof Error ? error.message : "Failed to load animation preset");
        }
      }

      applyAnimationScript(announce = true) {
        if (!this.isSparkAnimationAvailable()) {
          this.updateStatus("Animation: Spark only. Switch to Spark to apply animation.");
          this.syncAnimationControls(true);
          this.syncAnimationScriptStatus();
          return;
        }
        const target = this.getSelectedItem();
        if (!target) {
          this.updateStatus("Select an item before applying animation.");
          this.syncAnimationControls(true);
          this.syncAnimationScriptStatus();
          return;
        }
        this.markStaticBakeStale("Animation modifier applied");
        try {
          const text = this.dom.animationScriptEditor?.value?.trim() || "";
          if (!text) {
            this.clearAnimationScript(announce);
            return;
          }
          this.activeAnimationScript = parseAnimationScript(text);
          this.activeAnimationTargetItemId = target.id;
          this.state.animationLoop = this.activeAnimationScript.loop;
          this.state.animationDuration = this.activeAnimationScript.duration;
          this.state.animationTime = 0;
          this.state.animationPlaying = false;
          this.pendingAnimationDelta = 0;
          this.state.animationApplied = true;
          this.applyActiveAnimationUniforms();
          this.activeAnimationModifier = createAnimationModifierFromScript(this.activeAnimationScript, {
            dyno,
            handles: this.animationModifierHandles,
          });
          this.syncAnimationEditor({ force: true });
          this.syncAnimationControls(true);
          this.syncStaticBakeUi();
          this.applyRenderMode(false);
          this.forceVisualRefresh(3);
          this.queueSparkSceneUpdate();
          if (announce) {
            this.updateStatus(`Applied ${this.activeAnimationScript.name} to ${target.modelMeta.name}`);
            this.updateRenderChip(`${ANIMATION_PRESET_LABELS[this.activeAnimationScript.preset] || "Animation"} ready`);
          }
        } catch (error) {
          this.activeAnimationModifier = null;
          this.activeAnimationTargetItemId = null;
          this.state.animationApplied = false;
          this.state.animationPlaying = false;
          this.pendingAnimationDelta = 0;
          this.syncAnimationControls(true);
          this.syncStaticBakeUi();
          this.applyRenderMode(false);
          this.forceVisualRefresh(2);
          this.queueSparkSceneUpdate();
          this.updateStatus(error instanceof Error ? error.message : "Animation script parse failed");
          if (this.dom.animationScriptStatus) {
            this.dom.animationScriptStatus.textContent = error instanceof Error ? error.message : "Animation script parse failed";
          }
        }
      }

      stepAnimation(delta) {
        if (!this.isSparkAnimationAvailable() || !this.getActiveAnimationTargetItem() || !this.activeAnimationModifier || !this.state.animationApplied) {
          this.pendingAnimationDelta = 0;
          return false;
        }
        if (!this.state.animationPlaying) {
          this.pendingAnimationDelta = 0;
          this.animationModifierHandles.time.value = this.state.animationTime;
          return false;
        }
        this.pendingAnimationDelta += Math.max(Number(delta) || 0, 0);
        if (this.sparkSceneUpdatePromise) {
          return false;
        }
        const animationDelta = this.pendingAnimationDelta;
        this.pendingAnimationDelta = 0;
        Object.assign(this.state, advanceAnimationPlayback(this.state, { delta: animationDelta }));
        this.animationModifierHandles.time.value = this.state.animationTime;
        this.syncAnimationPlaybackUi();
        this.renderInvalidated = true;
        this.queueSparkSceneUpdate();
        if (!this.state.animationPlaying) {
          this.syncAnimationControls(true);
          this.updateStatus(`Paused ${this.activeAnimationScript.name}`);
        }
        return true;
      }

      playAnimation() {
        if (!this.isSparkAnimationAvailable()) {
          this.updateStatus("Animation: Spark only. Switch to Spark to play animation.");
          return;
        }
        const target = this.getActiveAnimationTargetItem();
        if (!target || target.id !== this.getSelectedItem()?.id || !canPlayAnimation({
          animationApplied: this.state.animationApplied,
          hasModifier: Boolean(this.activeAnimationModifier),
        })) {
          this.updateStatus("No animation script applied");
          return;
        }
        this.markStaticBakeStale("Animation playback started");
        this.pendingAnimationDelta = 0;
        Object.assign(this.state, advanceAnimationPlayback(this.state, { start: true }));
        this.applyRenderMode(false);
        this.forceVisualRefresh(2);
        this.queueSparkSceneUpdate();
        this.syncAnimationControls(true);
        this.syncAnimationScriptStatus();
        this.updateStatus(`Playing ${this.activeAnimationScript.name}`);
      }

      pauseAnimation({ announce = true, allowUnsupported = false } = {}) {
        if (!allowUnsupported && !this.isSparkAnimationAvailable()) {
          this.syncAnimationControls(true);
          this.syncAnimationScriptStatus();
          return;
        }
        this.state.animationPlaying = false;
        this.pendingAnimationDelta = 0;
        this.applyRenderMode(false);
        this.syncAnimationControls(true);
        this.syncAnimationScriptStatus();
        if (announce) this.updateStatus(`Paused ${this.activeAnimationScript?.name || "animation"}`);
      }

      resetAnimation() {
        const target = this.getActiveAnimationTargetItem();
        if (!this.isSparkAnimationAvailable() || !target || target.id !== this.getSelectedItem()?.id) {
          this.syncAnimationControls(true);
          this.syncAnimationScriptStatus();
          return;
        }
        this.pauseAnimation();
        this.state.animationTime = 0;
        this.pendingAnimationDelta = 0;
        this.animationModifierHandles.time.value = 0;
        this.applyRenderMode(false);
        this.syncAnimationControls(true);
        this.syncAnimationScriptStatus();
        this.forceVisualRefresh(2);
        this.queueSparkSceneUpdate();
        this.updateStatus(`Reset ${this.activeAnimationScript?.name || "animation"}`);
      }

      setAnimationTimeFromUi(commit = false) {
        const target = this.getActiveAnimationTargetItem();
        if (!this.isSparkAnimationAvailable() || !target || target.id !== this.getSelectedItem()?.id || !this.dom.animationTimeRange) {
          return;
        }
        const duration = Math.max(this.state.animationDuration || 0, 0);
        if (this.state.animationApplied) this.markStaticBakeStale("Animation time changed");
        this.state.animationPlaying = false;
        this.pendingAnimationDelta = 0;
        this.state.animationTime = THREE.MathUtils.clamp(Number(this.dom.animationTimeRange.value) || 0, 0, Math.max(duration, 0));
        this.animationModifierHandles.time.value = this.state.animationTime;
        this.applyRenderMode(false);
        this.syncAnimationControls(true);
        this.syncAnimationScriptStatus();
        this.forceVisualRefresh(commit ? 3 : 1);
        if (this.state.animationApplied) {
          this.queueSparkSceneUpdate();
        }
      }

      async loadAnimationScriptFile(file) {
        if (!this.isSparkAnimationAvailable() || !this.getSelectedItem()) {
          this.syncAnimationControls(true);
          this.syncAnimationScriptStatus();
          return;
        }
        try {
          const text = await file.text();
          this.activeAnimationScript = parseAnimationScript(text);
          this.activeAnimationModifier = null;
          this.activeAnimationTargetItemId = null;
          this.state.animationApplied = false;
          this.state.animationLoop = this.activeAnimationScript.loop;
          this.state.animationDuration = this.activeAnimationScript.duration;
          this.state.animationPlaying = false;
          this.state.animationTime = 0;
          this.pendingAnimationDelta = 0;
          this.syncAnimationEditor({ force: true });
          this.syncAnimationControls(true);
          this.syncStaticBakeUi();
          this.applyRenderMode(false);
          this.forceVisualRefresh(2);
          this.queueSparkSceneUpdate();
          this.updateStatus(`Loaded ${this.activeAnimationScript.name}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to read animation script";
          this.updateStatus(message);
          if (this.dom.animationScriptStatus) {
            this.dom.animationScriptStatus.textContent = message;
          }
        }
      }

      saveAnimationScript() {
        const blob = new Blob([this.dom.animationScriptEditor?.value || ""], { type: "text/javascript;charset=utf-8" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = buildAnimationDownloadName(this.activeAnimationScript?.name || DEFAULT_ANIMATION_SCRIPT_NAME);
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
        this.updateStatus(`Saved ${link.download}`);
      }

      setInspectorTab(tab) {
        const nextTab = ["scene", "color", "light", "animation", "align", "brush", "info", "export"].includes(tab) ? tab : "scene";
        const tabChanged = this.state.inspectorTab !== nextTab;
        this.state.inspectorTab = nextTab;
        this.syncInspectorTabs();
        if (nextTab === "align") {
          this.syncAlignUi();
        }
        if (nextTab === "brush") {
          this.syncBrushUi(true);
        }
        // Start at the new panel's first control, not another tab's scroll offset.
        if (tabChanged && this.dom.inspectorScroller) {
          this.dom.inspectorScroller.scrollTop = 0;
        }
        const label = nextTab === "scene"
          ? "Splats"
          : `${nextTab[0].toUpperCase()}${nextTab.slice(1)}`;
        this.updateRenderChip(`${label} tab`);
      }

      handleInspectorTabKeydown(event) {
        const tabs = this.dom.inspectorTabButtons;
        const currentIndex = tabs.indexOf(event.currentTarget);
        if (currentIndex < 0) {
          return;
        }
        let nextIndex = null;
        if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        if (nextIndex == null) {
          return;
        }
        event.preventDefault();
        const nextTab = tabs[nextIndex];
        this.setInspectorTab(nextTab.dataset.inspectorTab || "scene");
        nextTab.focus();
      }

      syncInspectorTabs() {
        this.dom.inspectorTabButtons.forEach((button) => {
          const isActive = button.dataset.inspectorTab === this.state.inspectorTab;
          button.classList.toggle("is-active", isActive);
          button.setAttribute("aria-selected", String(isActive));
          button.tabIndex = isActive ? 0 : -1;
        });
        this.dom.inspectorPanels.forEach((panel) => {
          const isActive = panel.dataset.inspectorPanel === this.state.inspectorTab;
          panel.classList.toggle("is-active", isActive);
          panel.hidden = !isActive;
        });
      }

      updateRenderChip(message) {
        if (this.dom.renderChip) {
          this.dom.renderChip.textContent = message;
        }
      }

      updateStatus(message) {
        this.dom.statusLine.textContent = message;
        this.dom.statusLine.title = message;
        this.dom.statusLine.classList.toggle("is-error", /(?:error|failed|unavailable)/i.test(message));
      }
    }

    const app = new GaussianViewerApp(dom);
    window.__sparkViewerApp = app;
    app.init().catch((error) => {
      dom.statusLine.textContent = error instanceof Error ? error.message : "Viewer failed to initialize";
      dom.progressLabel.textContent = "Viewer failed to start";
      if (dom.renderChip) {
        dom.renderChip.textContent = "Init error";
      }
    });
}

startSparkViewer();
