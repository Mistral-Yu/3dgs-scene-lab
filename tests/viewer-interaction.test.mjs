import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../viewer.js', import.meta.url), 'utf8');

// Exercise the actual event handlers without constructing a WebGL viewer.
function viewerMethod(name, nextName, bindings = {}) {
  const start = source.indexOf(`      ${name}(`);
  const end = source.indexOf(`\n      ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} method must exist`);
  return new Function(...Object.keys(bindings), `return ({ ${source.slice(start, end)} }).${name};`)(...Object.values(bindings));
}

const bindNumberPair = viewerMethod('bindNumberPair', 'commitActiveField', {
  isIntermediateNumericInput: (value) => ['', '-', '+', '.', '-.', '+.'].includes(value),
});

class InputStub {
  constructor(id, label = null) {
    this.id = id;
    this.label = label;
    this.value = '1.25';
    this.attributes = new Map();
    this.listeners = new Map();
    this.focused = true;
  }
  closest() { return this.label ? { querySelector: () => this.label } : null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name, details = {}) {
    const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...details };
    this.listeners.get(name)?.(event);
    return event;
  }
  blur() {
    if (!this.focused) return;
    this.focused = false;
    this.dispatch('blur');
  }
}

test('Enter commits a numeric field once through blur, without duplicate renderer updates', () => {
  const input = new InputStub('opacity-input');
  const calls = [];
  let limitReads = 0;
  bindNumberPair({ input, limits: () => { limitReads += 1; return { min: 0, max: 8 }; }, onChange: (...args) => calls.push(args) });
  const event = input.dispatch('keydown', { key: 'Enter' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(calls.length, 1);
  assert.equal(limitReads, 1);
  assert.deepEqual(calls[0], ['1.25', { commit: true, limits: { min: 0, max: 8 }, syncInput: true }]);
});

test('light color, position, and transform inputs also commit once and leave focus on Enter', () => {
  const bindInputs = viewerMethod('bindCommitInputs', 'bindNumberPair');
  const input = new InputStub('light-r-input');
  const calls = [];
  bindInputs([null, input], (commit) => calls.push(commit));
  input.dispatch('input');
  const event = input.dispatch('keydown', { key: 'Enter' });
  input.blur();
  assert.equal(event.defaultPrevented, true);
  assert.equal(input.focused, false);
  assert.deepEqual(calls, [false, true]);
});

test('light metadata updates preserve the buttons being clicked while a numeric field blurs', () => {
  const syncIntensity = viewerMethod('syncLightListIntensity', 'addPointLight', {
    formatNumber: (value, places) => value.toFixed(places),
  });
  const meta = { textContent: 'On / I 8.00' };
  const button = {};
  const row = { dataset: { lightId: 'light-1' }, button, querySelector: () => meta };
  const lightList = { children: [row], replaceChildren() { assert.fail('light edits must not remove the click target'); } };
  syncIntensity.call({ dom: { lightList } }, { id: 'light-1', visible: true, intensity: 0 });
  assert.equal(meta.textContent, 'On / I 0.00');
  assert.equal(lightList.children[0], row);
  assert.equal(lightList.children[0].button, button);
  for (const [name, next] of [
    ['applySelectedLightIntensity', 'applySelectedLightHelperScale'],
    ['applySelectedLightColor', 'applySelectedLightPosition'],
    ['applySelectedLightPosition', 'applySelectedLightShape'],
  ]) {
    assert.doesNotMatch(viewerMethod(name, next).toString(), /this\.syncLightList\(\)/);
  }
});

test('brush overlay uses the injected vertex color attribute and an ordered smoothstep', () => {
  const overlay = viewerMethod('createBrushOverlay', 'hideBrushOverlay').toString();
  assert.match(overlay, /vertexColors: true/);
  assert.doesNotMatch(overlay, /attribute vec[34] color\s*;/);
  assert.match(overlay, /vColor = color;/);
  assert.match(overlay, /1\.0 - smoothstep\(0\.32, 0\.5, distanceFromCenter\)/);
});

test('slider and typed preview events stay distinct from a final commit', () => {
  const input = new InputStub('opacity-input');
  const range = new InputStub('opacity-range');
  const calls = [];
  bindNumberPair({ input, range, limits: { min: 0, max: 8 }, onChange: (...args) => calls.push(args) });
  input.value = '-';
  input.dispatch('input');
  assert.equal(calls.length, 0);
  input.value = '2.5';
  input.dispatch('input');
  range.value = '0.5';
  range.dispatch('input');
  range.dispatch('change');
  assert.deepEqual(calls.map(([value, options]) => [value, options.commit]), [[2.5, false], ['0.5', false], ['0.5', true]]);
});

test('both numeric controls refer to the same live label without replacing existing label IDs', () => {
  const label = { id: 'normalize-range-label', textContent: 'Depth Max' };
  const input = new InputStub('depth-range-input', label);
  const range = new InputStub('depth-range-range');
  bindNumberPair({ input, range, onChange() {} });
  assert.equal(input.attributes.get('aria-labelledby'), label.id);
  assert.equal(range.attributes.get('aria-labelledby'), label.id);
  label.textContent = 'Position Scale';
  assert.equal(input.attributes.get('aria-labelledby'), 'normalize-range-label');
  const newLabel = { id: '', textContent: 'Focal Length' };
  const focal = new InputStub('focal-length-input', newLabel);
  bindNumberPair({ input: focal, onChange() {} });
  assert.equal(newLabel.id, 'focal-length-input-label');
  assert.equal(focal.attributes.get('aria-labelledby'), newLabel.id);
});

test('inspector keyboard navigation wraps and handles Home and End while moving focus', () => {
  const navigate = viewerMethod('handleInspectorTabKeydown', 'syncInspectorTabs');
  let focused = null;
  let selected = null;
  const tabs = ['scene', 'color', 'light', 'animation', 'align', 'brush', 'info', 'export'].map((name) => ({
    dataset: { inspectorTab: name },
    focus() { focused = name; },
  }));
  const viewer = { dom: { inspectorTabButtons: tabs }, setInspectorTab(name) { selected = name; } };
  for (const [index, key, expected] of [[0, 'ArrowLeft', 'export'], [7, 'ArrowRight', 'scene'], [4, 'Home', 'scene'], [2, 'End', 'export']]) {
    let prevented = false;
    navigate.call(viewer, { currentTarget: tabs[index], key, preventDefault() { prevented = true; } });
    assert.equal(selected, expected);
    assert.equal(focused, expected);
    assert.equal(prevented, true);
  }
});

test('alignment coordinate fields expose marker, set and axis in their accessible name', () => {
  const createEditor = viewerMethod('createAlignPointEditor', 'updateAlignPointCoordinate', {
    document: {
      createElement: () => ({
        children: [], dataset: {}, attributes: {}, listeners: new Map(),
        append(...children) { this.children.push(...children); },
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, listener) { this.listeners.set(name, listener); },
      }),
    },
    formatAlignPointLabel: ({ role, index }) => `${role === 'source' ? 'S' : 'T'}${index}`,
    formatNumber: (value, places) => value.toFixed(places),
  });
  const point = { x: -123.4567, y: 0, z: 1 };
  const commits = [];
  const viewer = { updateAlignPointCoordinate(role, index, axis, value) {
    commits.push([role, index, axis, value]);
    point[axis] = Number(value);
  } };
  const editor = createEditor.call(viewer, { role: 'target', index: 1, point });
  const inputs = editor.children.slice(1).map(field => field.children[1]);
  assert.deepEqual(inputs.map(input => input.attributes['aria-label']), ['T2 X', 'T2 Y', 'T2 Z']);
  assert.deepEqual(inputs.map(input => input.value), ['-123.457', '0.000', '1.000']);
  assert.ok(inputs.every(input => input.disabled === false));
  assert.equal(inputs[0].listeners.has('change'), false);
  inputs[0].listeners.get('blur')();
  assert.equal(commits.length, 0);
  assert.equal(point.x, -123.4567, 'focus and blur must not round a picked coordinate');
  inputs[0].value = '-234.5';
  inputs[0].listeners.get('blur')();
  assert.deepEqual(commits, [['target', 1, 'x', '-234.5']]);
  assert.equal(inputs[0].value, '-234.500');
});

test('coordinate commits move an existing marker without recreating editors or geometry', () => {
  const updatePoint = viewerMethod('updateAlignPointCoordinate', 'removeAlignPointPair', {
    formatAlignPointLabel: ({ role, index }) => `${role === 'source' ? 'S' : 'T'}${index}`,
    formatNumber: (value, places) => value.toFixed(places),
  });
  const point = { x: 1, y: 2, z: 3 };
  let copied = null;
  let refreshes = 0;
  const viewer = {
    alignPoints: { source: [point], target: [] },
    alignMarkers: [{ name: 'S1', position: { copy(value) { copied = { ...value }; } } }],
    syncAlignUi() { assert.fail('coordinate-only edits must preserve input DOM and focus'); },
    rebuildAlignMarkers() { assert.fail('coordinate-only edits must reuse marker geometry'); },
    updateStatus() {}, forceVisualRefresh() { refreshes += 1; },
  };
  updatePoint.call(viewer, 'source', 0, 'x', '-123.456');
  assert.deepEqual(copied, { x: -123.456, y: 2, z: 3 });
  updatePoint.call(viewer, 'source', 0, 'x', '-123.456');
  updatePoint.call(viewer, 'source', 0, 'x', 'invalid');
  assert.equal(refreshes, 1);
});

test('removed alignment markers release their geometry and materials before rebuilding', () => {
  const disposeMarkers = viewerMethod('disposeAlignMarkers', 'rebuildAlignMarkers');
  const disposed = [];
  const child = {
    geometry: { dispose() { disposed.push('geometry'); } },
    material: [{ dispose() { disposed.push('material'); } }],
  };
  const marker = { traverse(callback) { callback(this); callback(child); } };
  const viewer = {
    alignMarkers: [marker],
    scene: { remove(value) { assert.equal(value, marker); disposed.push('scene'); } },
  };
  disposeMarkers.call(viewer);
  assert.deepEqual(disposed, ['scene', 'geometry', 'material']);
  assert.deepEqual(viewer.alignMarkers, []);
});

test('switching inspector tabs clears a previous panel scroll offset without jumping on same-tab clicks', () => {
  const selectTab = viewerMethod('setInspectorTab', 'handleInspectorTabKeydown');
  const scroller = { scrollTop: 160 };
  const viewer = {
    dom: { inspectorScroller: scroller }, state: { inspectorTab: 'scene' },
    syncInspectorTabs() {}, syncAlignUi() {}, syncBrushUi() {}, updateRenderChip() {},
  };
  selectTab.call(viewer, 'color');
  assert.equal(viewer.state.inspectorTab, 'color');
  assert.equal(scroller.scrollTop, 0);
  scroller.scrollTop = 90;
  selectTab.call(viewer, 'color');
  assert.equal(scroller.scrollTop, 90);
  selectTab.call(viewer, 'align');
  assert.equal(scroller.scrollTop, 0);
});

test('export actions reflect loaded items and export selection instead of offering an empty save', () => {
  const syncExportList = viewerMethod('syncExportList', 'setGridScaleMode');
  const dom = { saveSceneSplatsButton: {}, exportEnableAllButton: {}, exportDisableAllButton: {} };
  const viewer = { dom, sceneItems: [] };
  const check = (items, expected) => {
    viewer.sceneItems = items;
    syncExportList.call(viewer);
    assert.deepEqual([dom.saveSceneSplatsButton.disabled, dom.exportEnableAllButton.disabled, dom.exportDisableAllButton.disabled], expected);
  };
  check([], [true, true, true]);
  check([{ mesh: null, exportEnabled: true }], [true, true, true]);
  check([{ mesh: {}, exportEnabled: false }], [true, false, true]);
  check([{ mesh: {}, exportEnabled: true }], [false, true, false]);
  check([{ mesh: {}, exportEnabled: true }, { mesh: {}, exportEnabled: false }], [false, false, false]);
});

test('requesting an alignment point leaves brush mode before the next viewport click', () => {
  const start = viewerMethod('startAlignPointPick', 'pickAlignPoint', {
    formatAlignPointLabel: () => 'S1',
  });
  const viewer = {
    brushEnabled: true, alignPickMode: false, isColorPickMode: true,
    isSparkViewportEditingAvailable: () => true,
    dom: { alignRoleSelect: { value: 'source' } }, alignPoints: { source: [] },
    getAlignSelection: () => ({ modelMeta: { name: 'Cube' } }),
    syncAlignUi() {}, updateStatus() {},
    setViewportEditingMode(mode) {
      this.brushEnabled = mode === 'brush';
      this.alignPickMode = mode === 'align';
      this.isColorPickMode = mode === 'color';
    },
  };
  start.call(viewer);
  assert.equal(viewer.brushEnabled, false);
  assert.equal(viewer.isColorPickMode, false);
  assert.equal(viewer.alignPickMode, true);
});

test('Brush, Align and Color picking are mutually exclusive and finish any pending stroke', () => {
  const setMode = viewerMethod('setViewportEditingMode', 'getSplatLocalNormal');
  for (const mode of ['brush', 'align', 'color', null]) {
    const calls = [];
    const viewer = {
      brushEnabled: true, alignPickMode: true, isColorPickMode: true,
      endBrushStroke() { calls.push('end'); },
      syncBrushUi() { calls.push('brush'); },
      syncAlignUi() { calls.push('align'); },
      syncColorPickButton() { calls.push('color'); },
    };
    setMode.call(viewer, mode);
    assert.deepEqual([viewer.brushEnabled, viewer.alignPickMode, viewer.isColorPickMode],
      ['brush', 'align', 'color'].map((tool) => tool === mode));
    assert.deepEqual(calls, ['end', 'brush', 'align', 'color']);
  }
  const color = viewerMethod('startColorPickMode', 'stopColorPickMode');
  let requested = null;
  color.call({ setViewportEditingMode(mode) { requested = mode; }, updateStatus() {} });
  assert.equal(requested, 'color');
  const brush = viewerMethod('toggleBrushEditing', 'getBrushPointer');
  const viewer = {
    brushEnabled: false, isSparkViewportEditingAvailable: () => true,
    getSelectedItem: () => ({ mesh: {} }), getEditableSplatStorage: () => ({}),
    setViewportEditingMode(mode) { requested = mode; this.brushEnabled = mode === 'brush'; }, updateStatus() {},
  };
  brush.call(viewer);
  assert.equal(requested, 'brush');
  brush.call(viewer);
  assert.equal(requested, null);
});

test('leaving the viewport clears the readout and stale brush overlay without disabling the tool', () => {
  const leave = viewerMethod('handleViewportPointerLeave', 'clearHoverReadout');
  const calls = [];
  const viewer = {
    brushEnabled: true,
    clearHoverReadout() { calls.push('readout'); },
    hideBrushOverlay() { calls.push('overlay'); },
  };
  leave.call(viewer);
  assert.deepEqual(calls, ['readout', 'overlay']);
  assert.equal(viewer.brushEnabled, true);
  assert.match(source, /addEventListener\("pointerleave", \(\) => this\.handleViewportPointerLeave\(\)\)/);
});
