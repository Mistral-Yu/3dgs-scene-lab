import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as tone from '../viewer-tone-curve.mjs';
import { SPLAT_COLOR_SPACE } from '../viewer-color.mjs';
import { expandLightSamples } from '../viewer-light-types.mjs';
import { applyDirectLighting, applyOneBouncePreview, DIRECT_LIGHT_NORMAL_POLICY, orientDirectLightNormal } from '../viewer-lighting.mjs';

const source = readFileSync(new URL('../viewer.js', import.meta.url), 'utf8');
const method = (name, bindings = {}) => {
  const start = new RegExp(`^      ${name}\\(`, 'm').exec(source)?.index;
  assert.ok(start >= 0, name);
  const next = /\n      (?:async )?\w+\(/.exec(source.slice(start));
  return new Function(...Object.keys(bindings), `return ({${source.slice(start, next ? start + next.index : undefined)}}).${name};`)(...Object.values(bindings));
};

test('legacy bounce toggles refresh alternate appearance and reject non-point lights', () => {
  const toggle=method('setOneBouncePreview',{ONE_BOUNCE_VPL_LIMIT:6});
  const calls=[];
  const viewer={sceneLights:[{type:'point',visible:true}],state:{oneBouncePreview:false},activeOneBounceVplCount:6,
    syncOneBouncePreviewUi(){},syncLightingRuntimeState(){},renderPickedColors(){},invalidateRender(){},queueSparkSceneUpdate(){},updateStatus(){},
    refreshActiveBackendSnapshot(reason,options){calls.push({enabled:this.state.oneBouncePreview,reason,options});}};
  toggle.call(viewer,true); toggle.call(viewer,false);
  assert.deepEqual(calls.map(c=>c.enabled),[true,false]);
  assert.ok(calls.every(c=>c.options.appearanceOnly));
  viewer.sceneLights=[{type:'area',visible:true}];
  toggle.call(viewer,true);
  assert.equal(viewer.state.oneBouncePreview,false);
  assert.equal(calls.length,2);
});
const expressionStart = source.indexOf('    const evaluateToneCurveExpression = ');
const expressionEnd = source.indexOf('\n    const createToneCurveColorModifier', expressionStart);
const expressionBindings = {
  normalizeToneCurveState: tone.normalizeToneCurveState,
  getToneCurveSpline: tone.getToneCurveSpline,
  dynoConst: (_type, value) => value,
  add: (a, b) => a + b, sub: (a, b) => a - b,
  mul: (a, b) => a * b, div: (a, b) => a / b,
  clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
};
const evaluateShaderCurve = new Function(...Object.keys(expressionBindings), `${source.slice(expressionStart, expressionEnd)}; return evaluateToneCurveExpression;`)(...Object.values(expressionBindings));
const curves = [
  [{ x: 0, y: 0 }, { x: 0.5, y: 0.12 }, { x: 1, y: 1 }],
  [{ x: 0.1, y: 0.2 }, { x: 0.35, y: 0.9 }, { x: 0.8, y: 0.3 }],
  [{ x: 0, y: 0.7 }, { x: 0.2, y: 0.7 }, { x: 0.21, y: 0.05 }, { x: 1, y: 1 }],
];

test('rendered Master and RGB curves match the smooth curve shown in the editor', () => {
  for (const points of curves) {
    for (const channel of ['master', 'red', 'green', 'blue']) {
      const state = tone.buildToneCurveState();
      state.curves[channel] = points;
      for (let index = -2; index <= 102; index += 1) {
        const value = index / 100;
        const result = tone.applyToneCurveToLinearRgb([value, value, value], state);
        const expected = tone.sampleToneCurveChannel(points, value);
        const affected = channel === 'master' ? [0, 1, 2] : [['red', 'green', 'blue'].indexOf(channel)];
        for (const component of affected) assert.ok(Math.abs(result[component] - expected) < 1e-12, `${channel} at ${value}: ${result[component]} != ${expected}`);
      }
    }
  }
});

test('actual Dyno tone-curve arithmetic matches the editor spline, including moved endpoints', () => {
  for (const points of curves) {
    for (let index = -2; index <= 102; index += 1) {
      const value = index / 100;
      const expected = tone.sampleToneCurveChannel(points, value);
      assert.ok(Math.abs(evaluateShaderCurve(value, points) - expected) < 1e-12, `shader curve at ${value}`);
    }
  }
});

test('graded items retain their own post-light curve when another item or a light is selected', () => {
  const grade = tone.insertToneCurvePoint(tone.buildToneCurveState(), 'master', { x: 0.5, y: 0.12 });
  const items = [grade, tone.buildToneCurveState()].map((curve, index) => ({
    id: `item-${index}`, settings: { toneCurve: curve }, cache: {},
    mesh: { updateMatrixWorld() {} },
  }));
  const apply = method('applyRenderMode', {
    SPLAT_COLOR_SPACE,
    createSplatColorTransferModifier: (decode) => ({ kind: decode ? 'decode' : 'encode' }),
    isNeutralToneCurve: tone.isNeutralToneCurve,
    createPointLightColorModifier: ({ lightOcclusionHandles }) => ({ kind: 'light', cache: lightOcclusionHandles }),
    createToneCurveColorModifier: (curve) => ({ kind: 'grade', curve }),
  });
  const noop = () => {};
  const viewer = {
    sceneItems: items, state: { renderMode: 'beauty' }, lightHandles: {}, activeLightCount: 2,
    shouldAttachAnimationModifier: () => false, getLightOcclusionHandles: (item) => item.cache,
    syncLightingRuntimeState: noop, syncMeshExposure: noop, applyShLevel: noop,
    updateNormalizeFieldState: noop, renderPickedColors: noop, invalidateRender: noop, queueSparkSceneUpdate: noop,
  };
  for (const selection of ['item-0', 'item-1', null]) {
    viewer.selectedSceneItemId = selection;
    apply.call(viewer, false);
    assert.deepEqual(items[0].mesh.objectModifiers.map((entry) => entry.kind), ['decode']);
    assert.deepEqual(items[0].mesh.worldModifiers.map((entry) => entry.kind), ['light', 'grade', 'encode'], `selection ${selection}`);
    assert.deepEqual(items[1].mesh.worldModifiers.map((entry) => entry.kind), ['light', 'encode']);
    assert.equal(items[0].mesh.worldModifiers[0].cache, items[0].cache);
    assert.equal(items[0].mesh.worldModifiers[1].curve, grade);
  }
});

test('multiple colored lights, per-light visibility, exposure, and Master/RGB curves compose in linear RGB', () => {
  const grade = tone.buildToneCurveState();
  grade.curves.master = curves[0];
  grade.curves.blue = curves[1];
  const base = [0.12, 0.2, 0.32];
  for (const exposure of [0.5, 1, 2]) {
    for (const transmission of [0, 0.2, 1]) {
      const lit = applyDirectLighting({
        baseLinearRgb: base.map((x) => x * exposure), normal: [0, 1, 0], position: [0, 0, 0],
        lights: [
          { position: [0, 2, 0], color: { r: 1, g: 0, b: 0 }, intensity: 4, visibility: transmission },
          { position: [0, 2, 0], color: { r: 0, g: 0, b: 1 }, intensity: 2, visibility: 0.8 },
          { position: [0, 1, 0], color: { r: 0, g: 1, b: 0 }, intensity: 50, visible: false },
        ],
      });
      const expectedLight = [base[0] * exposure * (1 + transmission), base[1] * exposure, base[2] * exposure * 1.4];
      for (let component = 0; component < 3; component += 1) assert.ok(Math.abs(lit[component] - expectedLight[component]) < 1e-12);
      const result = tone.applyToneCurveToLinearRgb(lit, grade);
      for (const [component, channel] of ['red', 'green', 'blue'].entries()) {
        const expected = evaluateShaderCurve(evaluateShaderCurve(expectedLight[component], grade.curves.master), grade.curves[channel]);
        assert.ok(Math.abs(result[component] - expected) < 1e-12);
      }
    }
  }
});

test('picked-color readouts use the second light cache as well as the first after grading', () => {
  const readColor = method('getDisplayLinearColorForSample', {
    ...tone, applyDirectLighting, applyOneBouncePreview, DIRECT_LIGHT_NORMAL_POLICY, orientDirectLightNormal,
    THREE: { Vector3: class {} },
  });
  const grade = tone.buildToneCurveState();
  grade.curves.master = curves[0];
  const sample = { splatIndex: 5, baseLinearRgb: Object.freeze([0.12, 0.2, 0.32]) };
  const viewer = {
    getLightSamples() { return expandLightSamples(this.sceneLights); },
    state: { oneBouncePreview: false }, camera: { getWorldPosition: () => [0, 4, 4] },
    getRenderModeForItem: () => 'beauty', getBeautyExposureScaleForItem: () => 2,
    getSampleWorldPosition: () => [0, 0, 0], getSampleWorldNormal: () => [0, 1, 0],
    getCachedLightTransmission: (_item, _sample, id) => id === 'red' ? 0.1 : 0.7,
    evaluateLightTransmission: () => 1,
    sceneLights: [
      { id: 'red', position: [0, 2, 0], color: { r: 1, g: 0, b: 0 }, intensity: 4, visible: true },
      { id: 'blue', position: [0, 2, 0], color: { r: 0, g: 0, b: 1 }, intensity: 2, visible: true },
    ],
  };
  const result = readColor.call(viewer, { hasAuthoredSplatNormals: true, settings: { toneCurve: grade } }, sample);
  const expected = [0.264, 0.4, 0.864].map((x) => tone.sampleToneCurveChannel(grade.curves.master, x));
  for (let component = 0; component < 3; component += 1) assert.ok(Math.abs(result[component] - expected[component]) < 1e-12);
  assert.deepEqual(sample.baseLinearRgb, [0.12, 0.2, 0.32]);
});

test('releasing an occlusion cache refreshes picked colors and the hover value immediately', () => {
  const invalidate = method('invalidateLightOcclusion', { window: { clearTimeout() {} } });
  for (const hoverPointer of [null, { x: 20, y: 30 }]) {
    const item = { lightOcclusion: { enabled: { value: true } } };
    const events = [];
    const viewer = {
      sceneItems: [item], state: { lightOcclusionEnabled: false }, lightOcclusionRevision: 0,
      lightOcclusionController: { cancel() {} }, hoverPointer,
      refreshActiveBackendSnapshot(reason, options) { assert.equal(options.appearanceOnly, true); },
      releaseLightOcclusion: (entry) => { entry.lightOcclusion.enabled.value = false; },
      getLightOcclusionAvailability: () => ({ enabled: true }), syncLightOcclusionUi() {},
      renderPickedColors: () => { assert.equal(item.lightOcclusion.enabled.value, false); events.push('picked'); },
      updateHoverReadout: () => events.push('hover'),
      forceVisualRefresh: () => events.push('refresh'), queueSparkSceneUpdate() {},
    };
    invalidate.call(viewer, 'Off');
    assert.deepEqual(events, hoverPointer ? ['picked', 'hover', 'refresh'] : ['picked', 'refresh']);
  }
});
