import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as ThreeR186 from "three-r186/webgpu";
import { GaussianSplat } from "three-r186/addons/objects/GaussianSplat.js";

import { guardCircularSplat } from "../tools/build-three-r186.mjs";
import { createNativeAppearance, disposeNativeSplat, updateNativeGeometry } from "../viewer-three-native.mjs";
import { LookDevBackendManager } from "../viewer-backends.mjs";

const packRgba = (red, green, blue, alpha) => (red | (green << 8) | (blue << 16) | (alpha << 24)) >>> 0;

test("native release drops large CPU appearance arrays and stale GPU flags", () => {
  const manager=new LookDevBackendManager({inputCanvas:{classList:{toggle(){}}}});
  const backend=manager.backends.get('three-r186');
  backend.appearanceSlots=new Float32Array(128);
  backend.appearanceEntries=[{state:{visibility:{data:new Float32Array(64)}}}];
  backend.gpuAppearanceActive=true;
  backend.releaseSplats();
  assert.equal(backend.appearanceSlots,null);
  assert.deepEqual(backend.appearanceEntries,[]);
  assert.equal(backend.gpuAppearanceActive,false);
  assert.equal(backend.appearanceDirty,true);
});

const createSplat = () => {
  const geometry = new ThreeR186.BufferGeometry();
  geometry.setAttribute("position", new ThreeR186.BufferAttribute(new Float32Array([
    1, 2, 3,
    4, 5, 6,
  ]), 3));
  geometry.setAttribute("covariance", new ThreeR186.BufferAttribute(new Float32Array([
    2, 3, 4, 5, 6, 7,
    8, 9, 10, 11, 12, 13,
  ]), 6));
  geometry.setAttribute("color", new ThreeR186.BufferAttribute(new Uint8Array([
    26, 51, 77, 102,
    128, 153, 179, 204,
  ]), 4, true));
  return new GaussianSplat(geometry, { autoSort: false });
};

test("r186 circular-splat build guard exactly patches installed upstream and fails closed", () => {
  const source = readFileSync(new URL("../node_modules/three-r186/examples/jsm/objects/GaussianSplat.js", import.meta.url), "utf8");
  const before = "If( radius.greaterThan( 0.00001 ), () => {";
  const after = "If( b.abs().greaterThan( 0.00001 ).or( a.sub( c ).abs().greaterThan( 0.00001 ) ), () => {";

  assert.equal(source.split(before).length, 2);
  assert.equal(guardCircularSplat(source), source.replace(before, after));
  for (const incompatible of [
    source.replace(before, "If( radius.greaterThan( 0.00002 ), () => {"),
    `${source}\n${before}`,
  ]) {
    assert.throws(() => guardCircularSplat(incompatible), /Re-review GaussianSplat circular-projection guard/);
  }
});

test("native cleanup releases public resources even after a layout guard failure", () => {
  const mesh=createSplat(), disposed=[];
  mesh._buffers={};
  mesh._sort=undefined;
  for(const key of ['geometry','material','splatGeometry'])mesh[key].addEventListener('dispose',()=>disposed.push(key));
  assert.throws(()=>updateNativeGeometry(mesh,{}),/Unsupported official GaussianSplat buffer layout/);
  disposeNativeSplat(mesh);
  assert.deepEqual(disposed,['geometry','material','splatGeometry']);
});

test("native WebGL PBO textures are disposed once even with aliased storage nodes", () => {
  const mesh=createSplat();
  let disposals=0;
  mesh._buffers.colorRead.value.pbo={dispose(){disposals++;}};
  mesh._buffers.colorAlias=mesh._buffers.colorRead;
  disposeNativeSplat(mesh);
  assert.equal(disposals,1);
});

test("official r186 GaussianSplat keeps the viewer byte-RGBA opacity contract", () => {
  const mesh = createSplat();
  try {
    assert.equal(ThreeR186.REVISION, "186");
    assert.equal(mesh.isGaussianSplat, true);
    assert.equal(mesh.autoSort, false);
    const color = mesh.splatGeometry.getAttribute("color");
    assert.ok(color.array instanceof Uint8Array);
    assert.equal(color.normalized, true);
    assert.deepEqual([...mesh._buffers.colorRead.value.array], [
      packRgba(26, 51, 77, 102),
      packRgba(128, 153, 179, 204),
    ]);
    assert.equal(mesh.material.transparent, true);
  } finally {
    disposeNativeSplat(mesh);
  }
});

test("native appearance updates official storage positions without changing opacity", () => {
  const mesh = createSplat();
  let appearance = null;
  try {
    const flat = {
      count: 2,
      center: new Float32Array([1, 2, 3, 4, 5, 6]),
      opacity: new Float32Array([0.4, 0.8]),
    };
    const texture = new ThreeR186.DataTexture(new Float32Array(4), 1, 1, ThreeR186.RGBAFormat, ThreeR186.FloatType);
    appearance = createNativeAppearance(mesh, flat, new Float32Array([0, 0, 1, 0]), texture, texture);
    const points = mesh.geometry.getAttribute("sceneLabAppearancePoints");
    const slots = mesh.geometry.getAttribute("sceneLabAppearanceSlots");
    assert.equal(appearance.compute.isComputeNode, true);
    assert.deepEqual(appearance.camera.value.toArray(), [0, 0, 0]);
    assert.deepEqual([...points.array.slice(0, 3)], [1, 2, 3]);
    assert.equal(points.array[3], Math.fround(0.4));
    assert.deepEqual([...slots.array], [0, 0, 1, 0]);

    const beforeVersion = points.version;
    appearance.updatePositions({ count: 2, center: new Float32Array([10, 11, 12, 13, 14, 15]) });
    assert.deepEqual([...points.array], [10, 11, 12, Math.fround(0.4), 13, 14, 15, Math.fround(0.8)]);
    assert.ok(points.version > beforeVersion);
  } finally {
    appearance?.compute.dispose();
    disposeNativeSplat(mesh);
  }
});

test("native geometry updates and disposal retain official buffer ownership", () => {
  const mesh = createSplat();
  const buffers = mesh._buffers;
  let disposed = false;
  try {
    const versions = [
      buffers.centerRead.value.version,
      buffers.covarianceARead.value.version,
      buffers.covarianceBRead.value.version,
    ];
    mesh._sortInitialized = true;
    updateNativeGeometry(mesh, {
      count: 2,
      center: new Float32Array([10, 11, 12, 13, 14, 15]),
      covarianceDiagonal: new Float32Array([1, 2, 3, 4, 5, 6]),
      covarianceOffDiagonal: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
    });

    assert.deepEqual(buffers.centerRead.value.array, new Float32Array([10, 11, 12, 0, 13, 14, 15, 0]));
    assert.deepEqual(buffers.covarianceARead.value.array, new Float32Array([1, 0.1, 0.2, 2, 4, 0.4, 0.5, 5]));
    assert.deepEqual(buffers.covarianceBRead.value.array, new Float32Array([0.3, 3, 0, 0, 0.6, 6, 0, 0]));
    assert.deepEqual(mesh.splatGeometry.getAttribute("position").array, new Float32Array([10, 11, 12, 13, 14, 15]));
    assert.deepEqual(mesh.splatGeometry.getAttribute("covariance").array, new Float32Array([
      1, 0.1, 0.2, 2, 0.3, 3,
      4, 0.4, 0.5, 5, 0.6, 6,
    ]));
    assert.ok(mesh.boundingSphere?.radius > 0);
    assert.equal(mesh._sortInitialized, false);
    assert.ok(buffers.centerRead.value.version > versions[0]);
    assert.ok(buffers.covarianceARead.value.version > versions[1]);
    assert.ok(buffers.covarianceBRead.value.version > versions[2]);

    const events = { geometry: 0, material: 0, source: 0 };
    mesh.geometry.addEventListener("dispose", () => { events.geometry += 1; });
    mesh.material.addEventListener("dispose", () => { events.material += 1; });
    mesh.splatGeometry.addEventListener("dispose", () => { events.source += 1; });
    disposeNativeSplat(mesh);
    disposed = true;

    assert.deepEqual(events, { geometry: 1, material: 1, source: 1 });
    assert.equal(mesh.geometry.getAttribute("sceneLabOwned_centerRead"), buffers.centerRead.value);
    assert.equal(mesh.geometry.getAttribute("sceneLabOwned_covarianceARead"), buffers.covarianceARead.value);
    assert.equal(mesh.geometry.getAttribute("sceneLabOwned_covarianceBRead"), buffers.covarianceBRead.value);
    assert.equal(mesh.geometry.getAttribute("sceneLabOwned_colorRead"), buffers.colorRead.value);
    assert.equal(mesh.geometry.getAttribute("sceneLabSort_orderAttribute"), mesh._sort.orderAttribute);
  } finally {
    if (!disposed) disposeNativeSplat(mesh);
  }
});
