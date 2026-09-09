import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../viewer.js', import.meta.url), 'utf8');

test('applyRenderMode keeps apply-only scripts visually idle, targets one item, and keeps LoD disabled', () => {
  assert.match(source, /shouldAttachAnimationModifier\(/);
  assert.match(source, /this\.state\.animationPlaying \|\| this\.state\.animationTime > 0/);
  assert.match(source, /const animationModifier = this\.shouldAttachAnimationModifier\(\) \? this\.activeAnimationModifier : null;/);
  assert.match(source, /animationModifier && item\.id === this\.activeAnimationTargetItemId/);
  assert.match(source, /item\.mesh\.enableLod = false;/);
  assert.match(source, /item\.mesh\.covObjectModifiers = item\.mesh\.objectModifiers;/);
  assert.match(source, /item\.mesh\.covWorldModifiers = item\.mesh\.worldModifiers;/);
  assert.match(source, /this\.applyShLevel\(true\);/);
  assert.match(source, /return item\.id === this\.selectedSceneItemId\n\s*\? \(this\.state\.renderMode \|\| "beauty"\)/);
  assert.doesNotMatch(source, /\? \(item\.settings\.renderMode \|\| "beauty"\)/);
});

test('tone curve edits target the selected item but stored grades remain active on every item', () => {
  assert.match(source, /settings:\s*\{[\s\S]*toneCurve:\s*buildToneCurveState\(\)/);
  assert.match(source, /this\.state\.toneCurve = normalizeToneCurveState\(item\?\.settings\?\.toneCurve \?\? buildToneCurveState\(\)\);/);
  assert.match(source, /item\.settings\.toneCurve = normalizeToneCurveState\(this\.state\.toneCurve\);/);
  assert.ok(/if \(!isNeutralToneCurve\(item\.settings\.toneCurve\)\)/.test(source), 'stored grades must not depend on selection');
  assert.match(source, /createToneCurveColorModifier\(item\.settings\.toneCurve\)/);
  assert.match(source, /const toneCurve = item\.settings\?\.toneCurve \?\? buildToneCurveState\(\);/);
  assert.doesNotMatch(source, /createToneCurveColorModifier\(this\.state\.toneCurve\)/);
});

test('tone curve graph supports direct left-click add and right-click remove without using the add button', () => {
  assert.match(source, /this\.dom\.toneCurveGraph\?\.addEventListener\("pointerdown", \(event\) => this\.handleToneCurveGraphPointerDown\(event\)\);/);
  assert.match(source, /this\.dom\.toneCurveGraph\?\.addEventListener\("contextmenu", \(event\) => this\.handleToneCurveGraphContextMenu\(event\)\);/);
  assert.match(source, /handleToneCurveGraphPointerDown\(event\)\s*\{[\s\S]*if \(event\.button !== 0\)[\s\S]*insertToneCurvePoint\(this\.state\.toneCurve,\s*channel,\s*\{\s*x,\s*y\s*\}\)/);
  assert.match(source, /handleToneCurveGraphContextMenu\(event\)\s*\{[\s\S]*findNearestRemovableToneCurvePointIndex\([\s\S]*removeToneCurvePoint\(this\.state\.toneCurve,\s*channel,\s*index\)/);
});

test('tone curve endpoint editing stays enabled for point inputs and graph dragging while deletion remains protected', () => {
  assert.match(source, /setSelectedToneCurvePointValue\(axis, value, \{ commit = true \} = \{\}\) \{[\s\S]*updateToneCurvePoint\(toneCurve,\s*channel,\s*index,\s*\{ \[axis\]: value \}\)/);
  assert.doesNotMatch(source, /this\.dom\.toneCurvePointXInput\.disabled = isEndpoint/);
  assert.doesNotMatch(source, /this\.dom\.toneCurvePointYInput\.disabled = isEndpoint/);
  assert.match(source, /this\.dom\.toneCurveRemovePointButton\.disabled = isEndpoint/);
  assert.doesNotMatch(source, /startToneCurvePointDrag\(index, event\)\s*\{[\s\S]*if \(index <= 0 \|\| !this\.dom\.toneCurveGraph\)/);
  assert.doesNotMatch(source, /startToneCurvePointDrag\(index, event\)\s*\{[\s\S]*if \(index >= toneCurve\.curves\[channel\]\.length - 1\)/);
});

test('exposure and tone-curve edits use deferred low-fps preview while inputs are active', () => {
  assert.match(source, /setExposure\(value, \{ commit = true, syncInput = true \} = \{\}\) \{[\s\S]*if \(commit\) \{[\s\S]*this\.finishDeferredInteraction\(\);[\s\S]*\} else \{[\s\S]*this\.startDeferredInteraction\(\);/);
  assert.match(source, /setSelectedExposure\(value, \{ commit = true, syncInput = true \} = \{\}\) \{[\s\S]*if \(commit\) \{[\s\S]*this\.finishDeferredInteraction\(\);[\s\S]*\} else \{[\s\S]*this\.startDeferredInteraction\(\);/);
  assert.match(source, /setSelectedToneCurvePointValue\(axis, value, \{ commit = true \} = \{\}\) \{/);
  assert.match(source, /range\?\.addEventListener\("input", \(event\) => onChange\(event\.target\.value, \{[\s\S]*commit:\s*false/);
  assert.match(source, /range\?\.addEventListener\("change", \(event\) => onChange\(event\.target\.value, \{[\s\S]*commit:\s*true/);
});

test('animation script status reflects loaded, applied, and playing states', () => {
  assert.match(source, /syncAnimationScriptStatus\(\) \{/);
  assert.match(source, /Animation: Spark only\. Switch to Spark to animate the selected item\./);
  assert.match(source, /Load a preset or script, then apply it to the selected splat\./);
  assert.match(source, /is applied to \$\{target\.modelMeta\.name\}\. Press Play to animate the selected item/);
  assert.match(source, /Playing \$\{this\.activeAnimationScript\.name\} on \$\{target\.modelMeta\.name\}/);
  assert.match(source, /playAnimation\(\)[\s\S]*this\.syncAnimationScriptStatus\(\);[\s\S]*this\.updateStatus\(`Playing/);
});

test('brush editing exposes relative controls, z-depth limiting, and viewport overlay helpers', () => {
  assert.match(source, /brushRelativeToSplatSize:\s*false/);
  assert.match(source, /brushDepthLimit:\s*0\.35/);
  assert.match(source, /createBrushOverlay\(\) \{/);
  assert.match(source, /Brush Influence Overlay/);
  assert.match(source, /new THREE\.Points\(/);
  assert.match(source, /new THREE\.ShaderMaterial\(/);
  assert.match(source, /uniforms:\s*\{ opacity:\s*\{ value:\s*0\.34 \} \}/);
  assert.match(source, /attribute float size;/);
  assert.match(source, /vertexColors:\s*true/);
  assert.match(source, /getStandardBrushDirection\(item\)/);
  assert.match(source, /getBrushRadiusWorld\(item\)/);
  assert.match(source, /getBrushInfluenceFalloffWorld\([\s\S]*item,[\s\S]*centerWorld,[\s\S]*radiusWorld,[\s\S]*geometry\.center/);
  assert.match(source, /const distanceWorld = referenceWorldPosition\.distanceTo\(brushCenterWorld\);/);
  assert.match(source, /const displacementBasisWorld = this\.state\.brushRelativeToSplatSize \? splatScaleWorld : radiusWorld \* 0\.08;/);
  assert.match(source, /nextCenter\.addScaledVector\(standardDirection, standardSign \* strength \* falloff \* displacementBasis\)/);
  assert.match(source, /const referenceCenter = mode === "move" && snapshot\?\.center \? snapshot\.center : geometry\.center;/);
  assert.match(source, /const editsScale = mode === "scale" && Math\.abs\(scaleBias - 1\) > 1e-4;/);
  assert.match(source, /const scaleWeight = falloff \* Math\.min\(Math\.abs\(strength\), 1\);/);
  assert.match(source, /isSplatWithinBrushDepth\(item, centerViewZ, referenceCenter, depthLimitWorld\)/);
  assert.match(source, /BRUSH_STRENGTH_LIMITS = \{ min: -8, max: 8 \}/);
  assert.match(source, /brushUndoStack\.push\(\{ itemId: item\.id, changes \}\)/);
});

test('alternate backends retain Spark-only brush and alignment picking guards', () => {
  assert.match(source, /isSparkViewportEditingAvailable\(\)/);
  assert.match(source, /startAlignPointPick\(\)[\s\S]*?Switch to Spark to pick alignment points/);
  assert.match(source, /toggleBrushEditing\(\)[\s\S]*?Switch to Spark to use the viewport brush/);
  assert.match(source, /alignAddPointButton\.disabled = !viewportEditingAvailable/);
  assert.match(source, /toggleGizmoButton\.disabled = !viewportEditingAvailable/);
});

test('persistent LUT and brush writes invalidate bake state and refresh alternate snapshots once per operation', () => {
  assert.match(source, /applyLoadedLutToSelectedSplat\(\)[\s\S]*?refreshActiveBackendSnapshot\("LUT applied"\)/);
  assert.match(source, /applyBrushAtHit\([\s\S]*?markStaticBakeStale\("Brush geometry changed"\)/);
  assert.match(source, /endBrushStroke\(\)[\s\S]*?refreshActiveBackendSnapshot\("Brush stroke completed"\)/);
  assert.match(source, /undoLastBrushStroke\(\)[\s\S]*?markStaticBakeStale\("Brush undo changed geometry"\)[\s\S]*?refreshActiveBackendSnapshot\("Brush undo completed"\)/);
});

test('alternate snapshots share exposure, lighting, and tone-curve appearance updates', () => {
  assert.match(source, /captureRendererSnapshot\(\{ gpuAppearance[\s\S]*?createSceneSnapshot\(this\.sceneItems, \{[\s\S]*?mapLinearRgb:[\s\S]*?if \(!useGpu\) return this\.getDisplayLinearColorForSample/);
  assert.match(source, /appearanceOnly && syncActive && this\.backendManager\.activeBackend\?\.setAppearance/);
  assert.doesNotMatch(source, /getDisplayLinearColorForSample\(item, sample\)[\s\S]*?activeId !== "spark"[\s\S]*?sample\.baseLinearRgb\.slice\(\)/);
  assert.match(source, /applyExposure\([\s\S]*?requestActiveBackendAppearanceRefresh\("Scene exposure updated"/);
  assert.match(source, /applySelectedExposure\([\s\S]*?requestActiveBackendAppearanceRefresh\("Selected exposure updated"/);
  assert.match(source, /applyToneCurve\([\s\S]*?requestActiveBackendAppearanceRefresh\("Tone curve updated"/);
  assert.match(source, /refreshLightingModel\([\s\S]*?refreshActiveBackendSnapshot\("Lighting updated", \{ appearanceOnly: !geometryChanged \|\| !occlusionChanged \}\)/);
  assert.match(source, /hasCameraDependentAlternateAppearance\(\)[\s\S]*?!this\.staticBakeApplied[\s\S]*?!item\.hasAuthoredSplatNormals/);
  assert.match(source, /scheduleCameraDependentAppearanceRefresh\(\)[\s\S]*?window\.setTimeout\([\s\S]*?refreshActiveBackendSnapshot\("Camera-dependent lighting updated"\)/);
  assert.match(source, /orbitControls\.addEventListener\("change", \(\) => \{[\s\S]*?scheduleCameraDependentAppearanceRefresh\(\)/);
  assert.match(source, /firstPerson\.onChange = \(\) => \{[\s\S]*?scheduleCameraDependentAppearanceRefresh\(\)/);
  assert.match(source, /if \(movedByKeys\) \{[\s\S]*?scheduleCameraDependentAppearanceRefresh\(\)/);
  assert.match(source, /startDeferredInteraction\([\s\S]*?flushActiveBackendAppearanceRefresh\(\)/);
  assert.match(source, /finishDeferredInteraction\(\)[\s\S]*?flushActiveBackendAppearanceRefresh\(\)/);
});

test('animation applies only to a selected target and uses target-local centroid coordinates', () => {
  assert.match(source, /activeAnimationTargetItemId = target\.id/);
  assert.match(source, /Select an item before applying animation\./);
  assert.match(source, /getActiveAnimationTargetItem\(\)\?\.baseCenterBounds\?\.getCenter\(new THREE\.Vector3\(\)\)/);
  assert.match(source, /activeAnimationTargetItemId = null;/);
});

test('a successful load re-enables selected-item animation controls after selection is synchronized', () => {
  assert.match(source, /this\.syncSelectionRefs\(sceneItem\);\s*this\.syncAnimationControls\(true\);/);
  assert.match(source, /syncAnimationControls\(syncSlider = true\)[\s\S]*this\.syncAnimationScriptStatus\(\);/);
});

test('non-Spark animation guards pause playback, disable controls, and stop scrub races', () => {
  assert.match(source, /pauseAnimation\(\{ announce: false, allowUnsupported: true \}\)/);
  assert.match(source, /Animation: Spark only/);
  assert.match(source, /animationTimeRange\.disabled = !canPlay/);
  assert.match(source, /this\.state\.animationPlaying = false;\s*this\.pendingAnimationDelta = 0;\s*this\.state\.animationTime = THREE\.MathUtils\.clamp/);
  assert.match(source, /advanceAnimationPlayback\(this\.state, \{ start: true \}\)/);
  assert.match(source, /advanceAnimationPlayback\(this\.state, \{ delta: animationDelta \}\)/);
  assert.match(source, /clearAnimationScript\(announce = false\)[\s\S]*?syncStaticBakeUi\(\);/);
  assert.match(source, /applyAnimationScript\(announce = true\)[\s\S]*?state\.animationApplied = true;[\s\S]*?syncStaticBakeUi\(\);/);
});

test('animation drafts, apply transitions, and playback UI avoid silent loss and per-frame live-region churn', () => {
  assert.match(source, /animationScriptEditor\?\.addEventListener\("input"[\s\S]*?animationEditorDirty = true/);
  assert.match(source, /syncAnimationEditor\(\{ force = false \} = \{\}\)[\s\S]*?if \(force \|\| !this\.animationEditorDirty\)/);
  assert.match(source, /Script edits are preserved but not applied/);
  assert.match(source, /applyAnimationScript\(announce = true\)[\s\S]*?state\.animationTime = 0;[\s\S]*?state\.animationPlaying = false;/);
  assert.match(source, /catch \(error\) \{[\s\S]*?state\.animationPlaying = false;[\s\S]*?syncAnimationControls\(true\);/);
  const step = source.match(/stepAnimation\(delta\) \{[\s\S]*?\n      \}/)?.[0] ?? '';
  assert.match(step, /syncAnimationPlaybackUi\(\)/);
  assert.doesNotMatch(step, /syncAnimationScriptStatus\(\)/);
  assert.doesNotMatch(step, /syncAnimationControls\(true\);[\s\S]*?forceVisualRefresh\(1\)/);
});

test('animation playback backpressures Spark updates and only draws changed frames', () => {
  const step = source.match(/stepAnimation\(delta\) \{[\s\S]*?\n      \}/)?.[0] ?? '';
  const renderLoop = source.match(/renderLoop\(\) \{[\s\S]*?\n      \}/)?.[0] ?? '';

  assert.match(step, /this\.pendingAnimationDelta \+= Math\.max\(Number\(delta\) \|\| 0, 0\)/);
  assert.match(step, /if \(this\.sparkSceneUpdatePromise\) \{\s*return false;/);
  assert.match(step, /delta: animationDelta/);
  assert.match(step, /this\.renderInvalidated = true;\s*this\.queueSparkSceneUpdate\(\);/);
  assert.doesNotMatch(step, /forceVisualRefresh/);
  assert.match(renderLoop, /const animationUpdated = this\.stepAnimation\(delta\);/);
  assert.match(renderLoop, /const animationPlaying = shouldRenderAnimationFrame\(this\.state\);/);
  assert.match(renderLoop, /visualMotion = visualMotion \|\| movedByKeys \|\| animationUpdated;/);
  assert.match(renderLoop, /const keepAnimating = visualMotion \|\| animationPlaying;/);
  assert.doesNotMatch(renderLoop, /shouldDraw[\s\S]*?\|\| keepAnimating/);
  assert.doesNotMatch(renderLoop, /canDrawNow[\s\S]*?\|\| keepAnimating/);
});

test('render scheduling stops its animation frame chain when the viewer is idle', () => {
  assert.match(source, /this\.animationLoopHandle = 0;\s*if \(this\.renderLoop\(\)\) this\.animationLoopHandle = window\.requestAnimationFrame\(tick\);/);
  assert.match(source, /renderLoop\(\)[\s\S]*?return keepAnimating[\s\S]*?this\.isTimedRenderActive\(\);/);
  assert.doesNotMatch(source, /\["pointerdown", "pointermove", "keydown", "keyup", "wheel"\]/);
  assert.match(source, /invalidateRender\(immediate = true\)[\s\S]*?this\.scheduleRender\(0\);/);
  assert.doesNotMatch(source.match(/invalidateRender\(immediate = true\)[\s\S]*?\n      \}/)?.[0] ?? '', /markRenderActivity/);
});
