import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../vendor/three/three.module.js';
import * as color from '../viewer-color.mjs';
import * as tone from '../viewer-tone-curve.mjs';
import * as lighting from '../viewer-lighting.mjs';
import * as lut from '../viewer-lut.mjs';
import { expandLightSamples } from '../viewer-light-types.mjs';
import { createSceneSnapshot, SH_C0 } from '../renderer-contract.mjs';
import { GSplatData } from '../node_modules/playcanvas/build/playcanvas/src/scene/gsplat/gsplat-data.js';

const source = readFileSync(new URL('../viewer.js', import.meta.url), 'utf8');
const block = (text, start, end) => {
  const a = text.indexOf(start), b = text.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return text.slice(a, b);
};
const evaluate = (text, name, bindings) => new Function(...Object.keys(bindings), `${text}; return ${name};`)(...Object.values(bindings));
const serializer = evaluate(block(source, '    const SH_C0 =', '    const createPrimitiveSpec ='),
  'packGaussianPly', { THREE, ...color });
const naming = evaluate(block(source, '    const sanitizeDownloadName =', '    const createDefaultModelMeta ='),
  '{ sanitizeDownloadName, buildUniqueFileName }', {});
const bindings = {
  THREE, ...color, ...tone, ...lighting, ...lut, ...naming, packGaussianPly: serializer,
  toLinearRgbArray: color.colorComponents, window: {}, OPACITY_LIMITS: { min: 0, max: 8 },
  clampNumber: (value, { min, max }) => Math.min(max, Math.max(min, value)),
  formatNumber: (value, digits) => value.toFixed(digits),
};
const method = (name) => {
  const start = new RegExp(`^      (?:async )?${name}\\(`, 'm').exec(source)?.index;
  assert.ok(start >= 0, name);
  const next = /\n      (?:async )?\w+\(/.exec(source.slice(start));
  return evaluate(`const result = ({${source.slice(start, next ? start + next.index : undefined)}}).${name}`, 'result', bindings);
};
const near = (actual, expected, tolerance = 1e-6) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((x, i) => assert.ok(Math.abs(x - expected[i]) <= tolerance, `${i}: ${x} != ${expected[i]}`));
};
const libraryWindow = {};
vm.runInNewContext(readFileSync(new URL('../primitives/primitive-library.js', import.meta.url), 'utf8'), { window: libraryWindow });
const definition = await libraryWindow.PrimitiveLibrary.createPrimitiveDefinition({ kind: 'macbeth', THREE,
  helpers: { createQuaternionFromNormal: n => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n), formatScaleRange: () => '' } });

function fixture(space = color.SPLAT_COLOR_SPACE.LINEAR) {
  const mesh = new THREE.Object3D();
  const splats = definition.splats.map(s => ({ ...s, center: s.position, scales: s.scale, opacity: s.alpha,
    color: new THREE.Color(...color.linearColorToSource(s.color, space)) }));
  const item = { id: 'chart', modelMeta: { name: 'Macbeth' }, mesh, modelRoot: mesh, rotationPivot: mesh,
    sourceColorSpace: space, exportEnabled: true, loadedShDegree: 0, hasAuthoredSplatNormals: true,
    settings: { opacity: 1, exposure: 0, shLevel: 0, toneCurve: tone.buildToneCurveState() } };
  const downloads = [], statuses = [];
  const viewer = { sceneItems: [item], sceneLights: [], state: { oneBouncePreview: false }, spark: { falloff: 1 },
    getLightSamples() { return expandLightSamples(this.sceneLights); },
    backendManager: { activeId: 'spark' }, camera: { getWorldPosition: () => new THREE.Vector3(0, 0, 4) },
    getPackedSplatCount: () => splats.length, getPackedSplatAt: (_, i) => splats[i],
    getSplatQuaternion: method('getSplatQuaternion'), getSplatNormal: method('getSplatNormal'),
    getSplatLocalNormal: () => new THREE.Vector3(0, 0, 1), getRenderModeForItem: () => 'beauty',
    getBeautyExposureScaleForItem: () => 2 ** item.settings.exposure,
    getSampleWorldPosition: (_, s) => s.localPosition, getSampleWorldNormal: () => new THREE.Vector3(0, 0, 1),
    getCachedLightTransmission: () => null, evaluateLightTransmission: () => 1,
    getDisplayLinearColorForSample: method('getDisplayLinearColorForSample'),
    getExportOptions: () => ({ opacity: true, sh: true, falloff: true }),
    getExportCommentsForItem: method('getExportCommentsForItem'), buildExportSplatsForItem: method('buildExportSplatsForItem'),
    shouldAttachAnimationModifier: () => false, syncLightingRuntimeState() {}, forceVisualRefresh() {},
    updateStatus: text => statuses.push(text), triggerBrowserDownload: (name, buffer) => downloads.push({ name, buffer }),
  };
  return { viewer, item, splats, downloads, statuses };
}

// Use the pinned PlayCanvas PLY reader, independently of our serializer and
// Spark. No browser, graphics device, network, or large fixture is involved.
const plySource = readFileSync(new URL('../node_modules/playcanvas/build/playcanvas/src/framework/parsers/ply.js', import.meta.url), 'utf8');
const readPly = evaluate(block(plySource, 'const magicBytes', 'const defaultElementFilter'), 'readPly', {
  GSplatData, GSplatCompressedData: class { constructor() { throw Error('Unexpected compressed PLY'); } },
});
const decode = async buffer => readPly(new Blob([buffer]).stream().getReader());
const decodedRgb = (data, index) => [0, 1, 2].map(c => data.getProp(`f_dc_${c}`)[index] * SH_C0 + 0.5);

test('untagged external splats are sRGB; primitives and legacy exports retain their linear meaning', () => {
  assert.equal(color.detectSplatColorSpace(), 'srgb');
  assert.equal(color.detectSplatColorSpace('comment color_space srgb\n'), 'srgb');
  for (const tag of ['linear-srgb', 'linear_srgb', 'linear_srgb_values_srgb_display']) {
    assert.equal(color.detectSplatColorSpace(`comment gs360_export_color_space ${tag}\n`), 'linear-srgb');
  }
  assert.equal(color.detectSplatColorSpace('', true), 'linear-srgb');
});

test('exact sRGB CPU and actual Spark modifier arithmetic agree across all byte values and boundaries', () => {
  const shader = evaluate(block(source, '    const createSplatColorTransferModifier =', '    const createWorldNormalModifier ='),
    'createSplatColorTransferModifier', {
      Gsplat: {}, dynoBlock: (_, __, run) => rgb => run({ gsplat: rgb }).gsplat,
      splitGsplat: rgb => ({ outputs: { rgb } }), split: rgb => ({ outputs: { x: rgb[0], y: rgb[1], z: rgb[2] } }),
      combineGsplat: ({ r, g, b }) => [r, g, b], dynoConst: (_, x) => x,
      clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)), lessThan: (a, b) => a < b,
      select: (condition, a, b) => condition ? a : b, div: (a, b) => a / b, mul: (a, b) => a * b,
      add: (a, b) => a + b, sub: (a, b) => a - b, pow: Math.pow,
    });
  for (const x of [-1, 0.0031308, 0.04045, 2, ...Array.from({ length: 256 }, (_, i) => i / 255)]) {
    near(shader(true)([x, x, x]), Array(3).fill(color.srgbToLinearChannel(x)), 3e-9);
    near(shader(false)([x, x, x]), Array(3).fill(color.linearToSrgbChannel(x)), 3e-8);
    assert.ok(Math.abs(color.linearToSrgbChannel(color.srgbToLinearChannel(x)) - Math.min(1, Math.max(0, x))) < 1e-7);
  }
});

test('snapshot source-space conversion gives identical linear colors without touching alpha', () => {
  const linear = [0.02, 0.18, 0.8];
  for (const space of Object.values(color.SPLAT_COLOR_SPACE)) {
    const snapshot = createSceneSnapshot([{ sourceColorSpace: space, mesh: { numSplats: 1,
      forEachSplat: cb => cb(0, {}, {}, {}, 0.37, color.linearColorToSource(linear, space)) } }]);
    near([...snapshot.items[0].linearRgb], linear);
    near([...snapshot.items[0].opacity], [0.37]);
  }
});

test('snapshot appearance mapping runs after source decoding and preserves alpha', () => {
  const mappedInputs = [];
  const snapshot = createSceneSnapshot([{ id: 'mapped', sourceColorSpace: color.SPLAT_COLOR_SPACE.SRGB,
    mesh: { numSplats: 1, forEachSplat: cb => cb(0, { x: 1, y: 2, z: 3 }, { x: 1, y: 1, z: 1 },
      { x: 0, y: 0, z: 0, w: 1 }, 0.37, [0.25, 0.5, 0.75]) } }], {
    mapLinearRgb: (entry) => {
      mappedInputs.push(entry);
      return entry.linearRgb.map(value => value * 2);
    },
  });
  near(mappedInputs[0].linearRgb, color.sourceColorToLinear([0.25, 0.5, 0.75]));
  near([...snapshot.items[0].linearRgb], mappedInputs[0].linearRgb.map(value => value * 2));
  near([...snapshot.items[0].opacity], [0.37]);
  assert.equal(mappedInputs[0].sceneItem.id, 'mapped');
  assert.equal(mappedInputs[0].splatCenter.x, 1);
});

test('PlayCanvas adapter encodes linear snapshots exactly once; both alternate backends disable tone mapping', () => {
  const backend = readFileSync(new URL('../viewer-backends.mjs', import.meta.url), 'utf8');
  const createData = evaluate(block(backend, 'const createGsplatData =', 'const setEntityTransform ='),
    'createGsplatData', { PlayCanvas: { GSplatData }, SH_C0, ...color });
  const data = createData({ center: [0, 0, 0], scale: [1, 1, 1], quaternion: [0, 0, 0, 1],
    linearRgb: [0.02, 0.18, 0.8], opacity: [0.37], opacityMultiplier: 1 });
  near(decodedRgb(data, 0), color.linearColorToSrgb([0.02, 0.18, 0.8]));
  near([...data.getProp('opacity')], [0.37]);
  assert.match(backend, /gammaCorrection = PlayCanvas\.GAMMA_SRGB/);
  assert.match(backend, /toneMapping = PlayCanvas\.TONEMAP_NONE/);
  assert.match(backend, /toneMapping = ThreeR186\.NoToneMapping/);
});

test('actual Save serializes every Macbeth patch as sRGB and the independent PlayCanvas reader reloads it', async () => {
  for (const space of Object.values(color.SPLAT_COLOR_SPACE)) {
    const { viewer, downloads, statuses } = fixture(space);
    await method('saveVisibleSceneSplats').call(viewer);
    assert.equal(downloads.length, 1);
    assert.match(statuses.at(-1), /Saved 1 scene splat/);
    const { buffer } = downloads[0];
    assert.match(new TextDecoder().decode(buffer.slice(0, 600)), /comment color_space srgb/);
    const parsed = await decode(buffer);
    assert.equal(parsed.numSplats, 432);
    definition.splats.forEach((s, index) => {
      const rgb = decodedRgb(parsed, index);
      near(rgb, color.linearColorToSrgb(s.color));
      near(color.sourceColorToLinear(rgb), color.colorComponents(s.color));
      const alpha = 1 / (1 + Math.exp(-parsed.getProp('opacity')[index]));
      assert.ok(Math.abs(alpha - s.alpha) < 1.1e-6);
    });
  }
});

test('export bakes exposure, colored lighting, cached and legacy occlusion, and tone curves in linear RGB', async () => {
  for (const space of Object.values(color.SPLAT_COLOR_SPACE)) {
    const { viewer, item, splats } = fixture(space);
    for (const exposure of [-1, 0, 1]) for (const visibility of [0, 0.3, 1]) {
      item.settings.exposure = exposure;
      item.settings.toneCurve.curves.master = [{ x: 0, y: 0 }, { x: 1, y: 0.6 }];
      viewer.sceneLights = [{ id: 'red', visible: true, position: new THREE.Vector3(0, 0, 2), color: { r: 1, g: 0, b: 0 }, intensity: 2 }];
      viewer.getCachedLightTransmission = () => visibility;
      viewer.evaluateLightTransmission = () => 0.5;
      const exported = viewer.buildExportSplatsForItem(item);
      const sample = splats[0];
      const lit = lighting.applyDirectLighting({
        baseLinearRgb: color.sourceColorToLinear(sample.color, space).map(x => x * 2 ** exposure),
        position: sample.center, normal: [0, 0, 1], normalPolicy: lighting.DIRECT_LIGHT_NORMAL_POLICY.AUTHORED_ONE_SIDED,
        lights: [{ ...viewer.sceneLights[0], visibility: visibility * 0.5 }],
      });
      const expected = color.linearColorToSrgb(tone.applyToneCurveToLinearRgb(lit, item.settings.toneCurve));
      near(color.colorComponents(exported[0].color), expected);
      near(decodedRgb(await decode(serializer(exported)), 0), expected);
    }
  }
});

test('area and directional exports encode graded sample contributions as sRGB', async () => {
  const {viewer,item,splats}=fixture('srgb');
  viewer.sceneLights=[
    {id:'sun',type:'directional',visible:true,position:[99,20,30],direction:[0,0,-1],intensity:0.5,color:[0,0.5,1]},
    {id:'panel',type:'area',visible:true,position:[0,0,3],direction:[0,0,-1],right:[1,0,0],up:[0,1,0],width:2,height:1,intensity:2,color:[1,0.2,0.1]},
  ];
  item.settings.toneCurve.curves.master=[{x:0,y:0},{x:1,y:0.6}];
  viewer.getCachedLightTransmission=(_item,_sample,id)=>id==='panel/sample-0'?0:0.7;
  viewer.evaluateLightTransmission=()=>1;
  const sample=splats[0], samples=expandLightSamples(viewer.sceneLights).map(light=>({...light,visibility:viewer.getCachedLightTransmission(null,null,light.id)}));
  const lit=lighting.applyDirectLighting({baseLinearRgb:color.sourceColorToLinear(sample.color,'srgb'),position:sample.center,normal:[0,0,1],lights:samples});
  const expected=color.linearColorToSrgb(tone.applyToneCurveToLinearRgb(lit,item.settings.toneCurve));
  for(const activeId of ['spark','playcanvas','three-r186']) {
    viewer.backendManager.activeId=activeId;
    const exported=viewer.buildExportSplatsForItem(item);
    near(color.colorComponents(exported[0].color),expected);
    near(decodedRgb(await decode(serializer(exported)),0),expected);
  }
});

test('exports use the same graded appearance for every active renderer', () => {
  const { viewer, item, splats } = fixture('srgb');
  item.settings.exposure = 2;
  item.settings.toneCurve.curves.master = [{ x: 0, y: 0 }, { x: 1, y: 0.1 }];
  viewer.backendManager.activeId = 'spark';
  const expected = color.colorComponents(viewer.buildExportSplatsForItem(item)[0].color);
  assert.notDeepEqual(expected, color.colorComponents(splats[0].color));
  for (const activeId of ['playcanvas', 'three-r186']) {
    viewer.backendManager.activeId = activeId;
    near(color.colorComponents(viewer.buildExportSplatsForItem(item)[0].color), expected);
  }
});

test('static bake writes in the original source space and restores original raw RGB exactly', () => {
  for (const space of Object.values(color.SPLAT_COLOR_SPACE)) {
    const { viewer, item } = fixture(space);
    let stored = new THREE.Color(0.123, 0.345, 0.678);
    const storage = { getSplat: () => ({ color: stored }), setSplat: (_, __, ___, ____, _____, c) => { stored = c; } };
    const snapshot = { count: 1, itemIds: ['chart'], itemIndex: [0], sourceIndex: [0] };
    Object.assign(viewer, {
      getSceneItemById: () => item, getEditableSplatStorage: () => storage,
      collectStaticBakeWrites: () => [{ item, splats: storage, outputIndex: 0, sourceIndex: 0 }],
      markSplatStorageNeedsUpdate() {}, createMeshHoverEntries: () => [],
    });
    const original = method('captureStaticBakeSourceColors').call(viewer, snapshot);
    method('applyStaticBakeColors').call(viewer, snapshot, [0.1, 0.2, 0.3]);
    near(color.colorComponents(stored), color.linearColorToSource([0.1, 0.2, 0.3], space));
    method('applyStaticBakeColors').call(viewer, snapshot, original, { sourceEncoded: true });
    assert.deepEqual(color.colorComponents(stored), [...original]);
  }
});

test('Save refuses appearance that ordinary SH0 PLY cannot reproduce', async () => {
  const cases = [
    [f => { f.viewer.shouldAttachAnimationModifier = () => true; }, /Reset animation/],
    [f => { f.viewer.getRenderModeForItem = () => 'normal'; }, /Beauty/],
    [f => { f.item.loadedShDegree = 3; f.item.settings.shLevel = 3; }, /SH0/],
    [f => { f.viewer.spark.falloff = 2; }, /Falloff/],
    [f => { f.item.settings.opacity = 2; }, /Opacity/],
  ];
  for (const [change, message] of cases) {
    const f = fixture(); change(f);
    await method('saveVisibleSceneSplats').call(f.viewer);
    assert.equal(f.downloads.length, 0);
    assert.match(f.statuses.at(-1), message);
  }
});

test('applying a LUT decodes input and writes back into the item source space', () => {
  const cube = lut.parseCubeLut('LUT_3D_SIZE 2\n0 0 0\n0.5 0 0\n0 0.5 0\n0.5 0.5 0\n0 0 0.5\n0.5 0 0.5\n0 0.5 0.5\n0.5 0.5 0.5\n');
  for (const space of Object.values(color.SPLAT_COLOR_SPACE)) {
    const { viewer, item, splats } = fixture(space);
    let output;
    item.mesh.splats = { numSplats: 1, getSplat: () => splats[0],
      setSplat: (_, __, ___, ____, _____, rgb) => { output = color.colorComponents(rgb); } };
    Object.assign(viewer, { dom: {}, getSelectedItem: () => item,
      markSplatStorageNeedsUpdate() {}, createMeshHoverEntries: () => [], renderPickedColors() {},
      invalidateRender() {}, queueSparkSceneUpdate() {}, refreshActiveBackendSnapshot() {} });
    viewer.state.loadedLut = cube;
    method('applyLoadedLutToSelectedSplat').call(viewer);
    near(output, color.linearColorToSource(color.colorComponents(definition.splats[0].color).map(x => x * 0.5), space));
  }
});

test('static-baked SH0 export does not apply live lights a second time and remains saveable', async () => {
  const { viewer, item, splats, downloads } = fixture('srgb');
  item.loadedShDegree = 3; item.settings.shLevel = 3;
  viewer.staticBakeApplied = true;
  viewer.sceneLights = [{ visible: true, intensity: 100 }];
  await method('saveVisibleSceneSplats').call(viewer);
  assert.equal(downloads.length, 1);
  near(decodedRgb(await decode(downloads[0].buffer), 0), color.colorComponents(splats[0].color));
});
