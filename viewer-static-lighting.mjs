/**
 * Deterministic direct-light bake for an owned world-space splat snapshot.
 *
 * A splat's conservative support is a sphere with radius 3 * max(sigma).  The
 * support is only a finite traversal bound; candidates inside it contribute a
 * Gaussian optical depth.  This is deliberately a direct-light appearance
 * bake, not physical GI: generic imported RGB/SH is captured radiance and is
 * never treated as albedo or given an inferred surface normal.
 */

import { directionalRayOrigin } from './viewer-light-types.mjs';

export const STATIC_BAKE_VERSION = 1;
export const STATIC_BAKE_SUPPORT_SIGMA = 3;
export const STATIC_BAKE_LEAF_SIZE = 16;
export const STATIC_BAKE_OPACITY_EPSILON = 1e-6;
export const STATIC_BAKE_DISTANCE_SQ_EPSILON = 1e-4;
export const STATIC_BAKE_SEGMENT_ENDPOINT_EPSILON = 1e-4;
export const STATIC_BAKE_MAX_AUTHORED_BOUNCE_SOURCES = 96;
export const STATIC_BAKE_MAX_AUTHORED_BOUNCE_PATHS = 192000;
export const STATIC_BAKE_MODE = Object.freeze({
  DIRECT: "direct",
  AUTHORED_ONE_BOUNCE: "authored-one-bounce",
});
export const STATIC_BAKE_GENERIC_POLICY = Object.freeze({
  PRESERVE: "preserve-captured-radiance",
  VISIBILITY_MODULATION: "captured-radiance-visibility-modulation",
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const at3 = (values, offset) => [finite(values?.[offset]), finite(values?.[offset + 1]), finite(values?.[offset + 2])];
const dot = (a, b) => (a[0] * b[0]) + (a[1] * b[1]) + (a[2] * b[2]);
const lengthSq = (value) => dot(value, value);

export function getStaticBakeActiveShDegree({ loadedShDegree = 0, requestedShLevel = 0 } = {}) {
  return clamp(Math.min(finite(loadedShDegree), finite(requestedShLevel)), 0, 3);
}

export function getStaticBakeSupportRadius(snapshot, index) {
  const offset = index * 3;
  const sigma = Math.max(
    Math.abs(finite(snapshot?.scale?.[offset])),
    Math.abs(finite(snapshot?.scale?.[offset + 1])),
    Math.abs(finite(snapshot?.scale?.[offset + 2])),
  );
  return sigma * STATIC_BAKE_SUPPORT_SIGMA;
}

export function validateStaticBakeSnapshot(snapshot, { requireRgb = true } = {}) {
  const count = Math.max(0, Math.floor(finite(snapshot?.count)));
  const unsupportedTransformCount = Math.max(0, Math.floor(finite(snapshot?.unsupportedStaticBakeTransformCount)));
  if (unsupportedTransformCount) {
    throw new Error(`Static bake does not support ${unsupportedTransformCount.toLocaleString()} non-uniform, sheared, or mirrored world transform${unsupportedTransformCount === 1 ? "" : "s"}`);
  }
  const required = ["center", "scale", "opacity", "itemIndex", "sourceIndex"];
  if (requireRgb) required.push("linearRgb");
  if (!required.every((key) => snapshot?.[key]?.length >= (key === "opacity" || key.endsWith("Index") ? count : count * 3))) {
    throw new Error(`Static lighting needs owned world-space center, scale, ${requireRgb ? "RGB, " : ""}opacity, and stable indices`);
  }
  if (snapshot.normal && snapshot.normal.length < count * 3) {
    throw new Error("Static bake normal array length is invalid");
  }
  if (snapshot.hasAuthoredNormal && snapshot.hasAuthoredNormal.length < count) {
    throw new Error("Static bake authored-normal mask length is invalid");
  }
  if (snapshot.hasAuthoredBounceMaterial && snapshot.hasAuthoredBounceMaterial.length < count) {
    throw new Error("Static bake authored bounce-material mask length is invalid");
  }
  if (snapshot.authoredDiffuseAlbedo && snapshot.authoredDiffuseAlbedo.length < count * 3) {
    throw new Error("Static bake authored diffuse-albedo array length is invalid");
  }
  if (snapshot.authoredSurfaceArea && snapshot.authoredSurfaceArea.length < count) {
    throw new Error("Static bake authored surface-area array length is invalid");
  }
  return count;
}

const MORTON_GRID_SIZE = 1023;
const PACKED_BOUNDS_STRIDE = 6;
const PACKED_MIN_X = 0;
const PACKED_MIN_Y = 1;
const PACKED_MIN_Z = 2;
const PACKED_MAX_X = 3;
const PACKED_MAX_Y = 4;
const PACKED_MAX_Z = 5;
const PACKED_MEDIAN_MIN_SPLATS = 1;

const normalizeStableKey = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback) >>> 0;
const expandMorton10 = (value) => {
  let bits = value & MORTON_GRID_SIZE;
  bits = (bits | (bits << 16)) & 0x030000ff;
  bits = (bits | (bits << 8)) & 0x0300f00f;
  bits = (bits | (bits << 4)) & 0x030c30c3;
  bits = (bits | (bits << 2)) & 0x09249249;
  return bits >>> 0;
};
const morton30 = (x, y, z) => (expandMorton10(x) | (expandMorton10(y) << 1) | (expandMorton10(z) << 2)) >>> 0;
const getPackedNodeCount = (leafCount) => {
  let total = 0;
  for (let level = leafCount; level > 0;) {
    total += level;
    if (level === 1) break;
    level = Math.ceil(level / 2);
  }
  return total;
};
const quantizeMortonCoordinate = (value, min, max) => {
  const extent = max - min;
  if (!(extent > 0)) return 0;
  return Math.min(MORTON_GRID_SIZE, Math.max(0, Math.floor(((value - min) / extent) * MORTON_GRID_SIZE)));
};
const createSanitizedCenterStorage = (snapshot, count) => snapshot.center instanceof Float32Array
  ? new Float32Array(count * 3)
  : new Float64Array(count * 3);
const createSanitizedOpacityStorage = (snapshot, count) => snapshot.opacity instanceof Float32Array
  ? new Float32Array(count)
  : new Float64Array(count);
const createSupportRadiusStorage = (snapshot, count) => snapshot.scale instanceof Float64Array
  ? new Float64Array(count)
  : new Float32Array(count);
const createIndexingState = (snapshot, count) => ({
  centerMax: new Float64Array([-Infinity, -Infinity, -Infinity]),
  centerMin: new Float64Array([Infinity, Infinity, Infinity]),
  center: createSanitizedCenterStorage(snapshot, count),
  count,
  itemKey: new Uint32Array(count),
  mortonKey: new Uint32Array(count),
  opacity: createSanitizedOpacityStorage(snapshot, count),
  originalKey: new Uint32Array(count),
  order: new Uint32Array(count),
  scratch: new Uint32Array(count),
  sourceKey: new Uint32Array(count),
  // Float32 runtime snapshots retain their established support/checksum
  // behavior.  Float64 caller snapshots keep tiny support radii instead of
  // silently narrowing them during BVH construction.
  supportRadius: createSupportRadiusStorage(snapshot, count),
});

const scanIndexingState = (snapshot, state, start, end) => {
  for (let index = start; index < end; index += 1) {
    const offset = index * 3;
    const x = finite(snapshot.center[offset]);
    const y = finite(snapshot.center[offset + 1]);
    const z = finite(snapshot.center[offset + 2]);
    state.center[offset] = x;
    state.center[offset + 1] = y;
    state.center[offset + 2] = z;
    state.centerMin[0] = Math.min(state.centerMin[0], x);
    state.centerMin[1] = Math.min(state.centerMin[1], y);
    state.centerMin[2] = Math.min(state.centerMin[2], z);
    state.centerMax[0] = Math.max(state.centerMax[0], x);
    state.centerMax[1] = Math.max(state.centerMax[1], y);
    state.centerMax[2] = Math.max(state.centerMax[2], z);
    state.supportRadius[index] = getStaticBakeSupportRadius(snapshot, index);
    state.itemKey[index] = normalizeStableKey(snapshot.itemIndex[index], index);
    state.opacity[index] = finite(snapshot.opacity[index]);
    state.sourceKey[index] = normalizeStableKey(snapshot.sourceIndex[index], index);
    state.originalKey[index] = index;
    state.order[index] = index;
  }
};

const fillMortonKeys = (_snapshot, state, start, end) => {
  const { centerMax, centerMin, mortonKey } = state;
  for (let index = start; index < end; index += 1) {
    const offset = index * 3;
    mortonKey[index] = morton30(
      quantizeMortonCoordinate(state.center[offset], centerMin[0], centerMax[0]),
      quantizeMortonCoordinate(state.center[offset + 1], centerMin[1], centerMax[1]),
      quantizeMortonCoordinate(state.center[offset + 2], centerMin[2], centerMax[2]),
    );
  }
};

const radixPass = (order, scratch, keys, shift) => {
  const bins = new Uint32Array(256);
  for (let index = 0; index < order.length; index += 1) bins[(keys[order[index]] >>> shift) & 0xff] += 1;
  let offset = 0;
  for (let bin = 0; bin < bins.length; bin += 1) {
    const count = bins[bin];
    bins[bin] = offset;
    offset += count;
  }
  for (let index = 0; index < order.length; index += 1) {
    const entry = order[index];
    const bin = (keys[entry] >>> shift) & 0xff;
    scratch[bins[bin]] = entry;
    bins[bin] += 1;
  }
  order.set(scratch);
};

const stableRadixSort = (state) => {
  // LSD passes make the resulting lexicographic key exactly
  // (morton30, itemIndex, sourceIndex, originalIndex), without engine sort.
  for (const keys of [state.originalKey, state.sourceKey, state.itemKey, state.mortonKey]) {
    for (let shift = 0; shift < 32; shift += 8) radixPass(state.order, state.scratch, keys, shift);
  }
};

const reportBuildProgress = (onProgress, stage, processed, total, extra = {}) => {
  onProgress?.({ ...extra, phase: "indexing", processed, stage, total });
};

const canceledIndexingResult = (processed, total) => ({ canceled: true, phase: "indexing", processed, total });

const radixPassAsync = async ({
  keys,
  onProgress,
  order,
  pass,
  processedOffset,
  scratch,
  shouldCancel,
  total,
  yieldToEventLoop,
  yieldEvery,
}) => {
  const bins = new Uint32Array(256);
  for (let start = 0; start < order.length; start += yieldEvery) {
    const end = Math.min(start + yieldEvery, order.length);
    for (let index = start; index < end; index += 1) {
      if (shouldCancel?.()) return false;
      bins[(keys[order[index]] >>> processedOffset) & 0xff] += 1;
    }
    reportBuildProgress(onProgress, "sort", end, total, { pass: pass + 1, passes: 16, sortStep: "histogram" });
    if (end < order.length) await yieldToEventLoop();
  }
  if (shouldCancel?.()) return false;
  let offset = 0;
  for (let bin = 0; bin < bins.length; bin += 1) {
    const count = bins[bin];
    bins[bin] = offset;
    offset += count;
  }
  for (let start = 0; start < order.length; start += yieldEvery) {
    const end = Math.min(start + yieldEvery, order.length);
    for (let index = start; index < end; index += 1) {
      if (shouldCancel?.()) return false;
      const entry = order[index];
      const bin = (keys[entry] >>> processedOffset) & 0xff;
      scratch[bins[bin]] = entry;
      bins[bin] += 1;
    }
    reportBuildProgress(onProgress, "sort", end, total, { pass: pass + 1, passes: 16, sortStep: "scatter" });
    if (end < order.length) await yieldToEventLoop();
  }
  order.set(scratch);
  return true;
};

const stableRadixSortAsync = async ({ onProgress, shouldCancel, state, yieldEvery, yieldToEventLoop }) => {
  let pass = 0;
  for (const keys of [state.originalKey, state.sourceKey, state.itemKey, state.mortonKey]) {
    for (let shift = 0; shift < 32; shift += 8) {
      const complete = await radixPassAsync({
        keys,
        onProgress,
        order: state.order,
        pass,
        processedOffset: shift,
        scratch: state.scratch,
        shouldCancel,
        total: state.count,
        yieldEvery,
        yieldToEventLoop,
      });
      if (!complete) return false;
      pass += 1;
      if (shouldCancel?.()) return false;
      await yieldToEventLoop();
    }
  }
  return true;
};

const createPackedHierarchy = (snapshot, state, leafSize) => {
  const { center, count, itemKey, opacity, order, sourceKey, supportRadius } = state;
  if (!count) {
    const empty = new Int32Array(0);
    return Object.freeze({
      bounds: new Float64Array(0),
      center,
      childLeft: empty,
      childRight: new Int32Array(0),
      count,
      leafLength: new Uint32Array(0),
      leafSize,
      leafStart: new Uint32Array(0),
      itemKey,
      nodeCount: 0,
      nodes: empty,
      opacity,
      order,
      root: -1,
      sourceKey,
      supportRadius,
      traversalStack: new Int32Array(64),
    });
  }
  const leafCount = Math.ceil(count / leafSize);
  const nodeCapacity = getPackedNodeCount(leafCount);
  const bounds = new Float64Array(nodeCapacity * PACKED_BOUNDS_STRIDE);
  const childLeft = new Int32Array(nodeCapacity);
  const childRight = new Int32Array(nodeCapacity);
  const leafStart = new Uint32Array(nodeCapacity);
  const leafLength = new Uint32Array(nodeCapacity);
  childLeft.fill(-1);
  childRight.fill(-1);
  let nodeCount = leafCount;
  for (let leaf = 0; leaf < leafCount; leaf += 1) {
    const start = leaf * leafSize;
    const end = Math.min(start + leafSize, count);
    const boundOffset = leaf * PACKED_BOUNDS_STRIDE;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let position = start; position < end; position += 1) {
      const index = order[position];
      const offset = index * 3;
      const radius = supportRadius[index];
      const x = center[offset];
      const y = center[offset + 1];
      const z = center[offset + 2];
      minX = Math.min(minX, x - radius);
      minY = Math.min(minY, y - radius);
      minZ = Math.min(minZ, z - radius);
      maxX = Math.max(maxX, x + radius);
      maxY = Math.max(maxY, y + radius);
      maxZ = Math.max(maxZ, z + radius);
    }
    bounds[boundOffset + PACKED_MIN_X] = minX;
    bounds[boundOffset + PACKED_MIN_Y] = minY;
    bounds[boundOffset + PACKED_MIN_Z] = minZ;
    bounds[boundOffset + PACKED_MAX_X] = maxX;
    bounds[boundOffset + PACKED_MAX_Y] = maxY;
    bounds[boundOffset + PACKED_MAX_Z] = maxZ;
    leafStart[leaf] = start;
    leafLength[leaf] = end - start;
  }
  let current = new Uint32Array(leafCount);
  for (let index = 0; index < leafCount; index += 1) current[index] = index;
  while (current.length > 1) {
    const next = new Uint32Array(Math.ceil(current.length / 2));
    for (let index = 0; index < next.length; index += 1) {
      const left = current[index * 2];
      const right = (index * 2) + 1 < current.length ? current[(index * 2) + 1] : -1;
      const node = nodeCount;
      nodeCount += 1;
      childLeft[node] = left;
      childRight[node] = right;
      const nodeOffset = node * PACKED_BOUNDS_STRIDE;
      const leftOffset = left * PACKED_BOUNDS_STRIDE;
      const rightOffset = right * PACKED_BOUNDS_STRIDE;
      bounds[nodeOffset + PACKED_MIN_X] = right < 0 ? bounds[leftOffset + PACKED_MIN_X] : Math.min(bounds[leftOffset + PACKED_MIN_X], bounds[rightOffset + PACKED_MIN_X]);
      bounds[nodeOffset + PACKED_MIN_Y] = right < 0 ? bounds[leftOffset + PACKED_MIN_Y] : Math.min(bounds[leftOffset + PACKED_MIN_Y], bounds[rightOffset + PACKED_MIN_Y]);
      bounds[nodeOffset + PACKED_MIN_Z] = right < 0 ? bounds[leftOffset + PACKED_MIN_Z] : Math.min(bounds[leftOffset + PACKED_MIN_Z], bounds[rightOffset + PACKED_MIN_Z]);
      bounds[nodeOffset + PACKED_MAX_X] = right < 0 ? bounds[leftOffset + PACKED_MAX_X] : Math.max(bounds[leftOffset + PACKED_MAX_X], bounds[rightOffset + PACKED_MAX_X]);
      bounds[nodeOffset + PACKED_MAX_Y] = right < 0 ? bounds[leftOffset + PACKED_MAX_Y] : Math.max(bounds[leftOffset + PACKED_MAX_Y], bounds[rightOffset + PACKED_MAX_Y]);
      bounds[nodeOffset + PACKED_MAX_Z] = right < 0 ? bounds[leftOffset + PACKED_MAX_Z] : Math.max(bounds[leftOffset + PACKED_MAX_Z], bounds[rightOffset + PACKED_MAX_Z]);
      next[index] = node;
    }
    current = next;
  }
  return Object.freeze({
    bounds,
    center,
    childLeft,
    childRight,
    count,
    leafLength,
    leafSize,
    leafStart,
    itemKey,
    nodeCount,
    // Compatibility alias: callers that only reported bvh.nodes.length keep
    // working while the data itself remains flat and allocation-free.
    nodes: childLeft,
    opacity,
    order,
    root: current[0],
    sourceKey,
    supportRadius,
    traversalStack: new Int32Array(64),
  });
};

const compareMedianEntries = (state, left, right, axis) => {
  const coordinateDelta = state.center[(left * 3) + axis] - state.center[(right * 3) + axis];
  if (coordinateDelta) return coordinateDelta < 0 ? -1 : 1;
  const mortonDelta = state.mortonKey[left] - state.mortonKey[right];
  if (mortonDelta) return mortonDelta < 0 ? -1 : 1;
  const itemDelta = state.itemKey[left] - state.itemKey[right];
  if (itemDelta) return itemDelta < 0 ? -1 : 1;
  const sourceDelta = state.sourceKey[left] - state.sourceKey[right];
  if (sourceDelta) return sourceDelta < 0 ? -1 : 1;
  return state.originalKey[left] - state.originalKey[right];
};

const swapOrderEntries = (order, left, right) => {
  const value = order[left];
  order[left] = order[right];
  order[right] = value;
};

const selectMedianOrderEntry = (state, order, start, end, target, axis) => {
  let lower = start;
  let upper = end - 1;
  while (lower < upper) {
    let first = lower;
    let middle = lower + ((upper - lower) >> 1);
    let last = upper;
    if (compareMedianEntries(state, order[first], order[middle], axis) > 0) [first, middle] = [middle, first];
    if (compareMedianEntries(state, order[middle], order[last], axis) > 0) [middle, last] = [last, middle];
    if (compareMedianEntries(state, order[first], order[middle], axis) > 0) [first, middle] = [middle, first];
    const pivotEntry = order[middle];
    swapOrderEntries(order, middle, upper);
    let write = lower;
    for (let scan = lower; scan < upper; scan += 1) {
      if (compareMedianEntries(state, order[scan], pivotEntry, axis) < 0) {
        swapOrderEntries(order, write, scan);
        write += 1;
      }
    }
    swapOrderEntries(order, write, upper);
    if (target === write) return;
    if (target < write) upper = write - 1;
    else lower = write + 1;
  }
};

const getMedianHierarchyCapacity = (count, leafSize) => {
  const safeCount = Math.max(0, Math.floor(count));
  const safeLeafSize = Math.max(1, Math.floor(leafSize));
  if (!safeCount) return 1;
  const memo = new Map();
  const countNodes = (rangeLength) => {
    if (rangeLength <= safeLeafSize) return 1;
    const cached = memo.get(rangeLength);
    if (cached) return cached;
    const leftLength = Math.floor(rangeLength / 2);
    const total = 1 + countNodes(leftLength) + countNodes(rangeLength - leftLength);
    memo.set(rangeLength, total);
    return total;
  };
  return countNodes(safeCount);
};

const getMedianHierarchyStackCapacity = (count, leafSize) => {
  const safeLeafSize = Math.max(1, Math.floor(leafSize));
  let largestRange = Math.max(0, Math.floor(count));
  let depth = 1;
  while (largestRange > safeLeafSize) {
    largestRange = Math.ceil(largestRange / 2);
    depth += 1;
  }
  return depth;
};

const createPackedMedianHierarchy = (state, leafSize) => {
  const { center, count, itemKey, opacity, sourceKey, supportRadius } = state;
  if (!count) return createPackedHierarchy(null, state, leafSize);
  // Preserve the deterministic Morton radix order separately. Median
  // partitioning improves broad-phase pruning for large, diffuse clouds while
  // every coordinate tie still resolves through that stable key.
  const mortonOrder = state.order;
  const order = new Uint32Array(mortonOrder);
  const capacity = getMedianHierarchyCapacity(count, leafSize);
  const bounds = new Float64Array(capacity * PACKED_BOUNDS_STRIDE);
  const childLeft = new Int32Array(capacity);
  const childRight = new Int32Array(capacity);
  const leafStart = new Uint32Array(capacity);
  const leafLength = new Uint32Array(capacity);
  const stackCapacity = getMedianHierarchyStackCapacity(count, leafSize);
  const nodeStack = new Uint32Array(stackCapacity);
  const rangeStartStack = new Uint32Array(stackCapacity);
  const rangeEndStack = new Uint32Array(stackCapacity);
  childLeft.fill(-1);
  childRight.fill(-1);
  let nodeCount = 1;
  let stackLength = 1;
  nodeStack[0] = 0;
  rangeStartStack[0] = 0;
  rangeEndStack[0] = count;
  while (stackLength) {
    stackLength -= 1;
    const node = nodeStack[stackLength];
    const start = rangeStartStack[stackLength];
    const end = rangeEndStack[stackLength];
    const boundOffset = node * PACKED_BOUNDS_STRIDE;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let position = start; position < end; position += 1) {
      const index = order[position];
      const offset = index * 3;
      const radius = supportRadius[index];
      const x = center[offset];
      const y = center[offset + 1];
      const z = center[offset + 2];
      minX = Math.min(minX, x - radius);
      minY = Math.min(minY, y - radius);
      minZ = Math.min(minZ, z - radius);
      maxX = Math.max(maxX, x + radius);
      maxY = Math.max(maxY, y + radius);
      maxZ = Math.max(maxZ, z + radius);
    }
    bounds[boundOffset + PACKED_MIN_X] = minX;
    bounds[boundOffset + PACKED_MIN_Y] = minY;
    bounds[boundOffset + PACKED_MIN_Z] = minZ;
    bounds[boundOffset + PACKED_MAX_X] = maxX;
    bounds[boundOffset + PACKED_MAX_Y] = maxY;
    bounds[boundOffset + PACKED_MAX_Z] = maxZ;
    if (end - start <= leafSize) {
      leafStart[node] = start;
      leafLength[node] = end - start;
      continue;
    }
    const extentX = maxX - minX;
    const extentY = maxY - minY;
    const extentZ = maxZ - minZ;
    const axis = extentY > extentX && extentY >= extentZ ? 1 : (extentZ > extentX && extentZ > extentY ? 2 : 0);
    const middle = start + Math.floor((end - start) / 2);
    selectMedianOrderEntry(state, order, start, end, middle, axis);
    const left = nodeCount;
    const right = nodeCount + 1;
    nodeCount += 2;
    childLeft[node] = left;
    childRight[node] = right;
    nodeStack[stackLength] = right;
    rangeStartStack[stackLength] = middle;
    rangeEndStack[stackLength] = end;
    stackLength += 1;
    nodeStack[stackLength] = left;
    rangeStartStack[stackLength] = start;
    rangeEndStack[stackLength] = middle;
    stackLength += 1;
  }
  return Object.freeze({
    bounds: bounds.subarray(0, nodeCount * PACKED_BOUNDS_STRIDE),
    center,
    childLeft: childLeft.subarray(0, nodeCount),
    childRight: childRight.subarray(0, nodeCount),
    count,
    leafLength: leafLength.subarray(0, nodeCount),
    leafSize,
    leafStart: leafStart.subarray(0, nodeCount),
    itemKey,
    mortonOrder,
    nodeCount,
    nodes: childLeft.subarray(0, nodeCount),
    opacity,
    order,
    root: 0,
    sourceKey,
    supportRadius,
    topology: "median",
    traversalStack: new Int32Array(64),
  });
};

const selectMedianOrderEntryAsync = async ({
  axis,
  end,
  order,
  shouldCancel,
  start,
  state,
  target,
  yieldEvery,
  yieldToEventLoop,
}) => {
  let lower = start;
  let upper = end - 1;
  while (lower < upper) {
    let first = lower;
    let middle = lower + ((upper - lower) >> 1);
    let last = upper;
    if (compareMedianEntries(state, order[first], order[middle], axis) > 0) {
      const swap = first;
      first = middle;
      middle = swap;
    }
    if (compareMedianEntries(state, order[middle], order[last], axis) > 0) {
      const swap = middle;
      middle = last;
      last = swap;
    }
    if (compareMedianEntries(state, order[first], order[middle], axis) > 0) {
      const swap = first;
      first = middle;
      middle = swap;
    }
    const pivotEntry = order[middle];
    swapOrderEntries(order, middle, upper);
    let write = lower;
    for (let scan = lower; scan < upper; scan += 1) {
      if (shouldCancel?.()) return false;
      if (compareMedianEntries(state, order[scan], pivotEntry, axis) < 0) {
        swapOrderEntries(order, write, scan);
        write += 1;
      }
      if ((scan - lower + 1) % yieldEvery === 0) await yieldToEventLoop();
    }
    swapOrderEntries(order, write, upper);
    if (target === write) return true;
    if (target < write) upper = write - 1;
    else lower = write + 1;
  }
  return !shouldCancel?.();
};

const fillMedianNodeBoundsAsync = async ({
  bounds,
  center,
  end,
  node,
  order,
  shouldCancel,
  start,
  supportRadius,
  yieldEvery,
  yieldToEventLoop,
}) => {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let position = start; position < end; position += 1) {
    if (shouldCancel?.()) return false;
    const index = order[position];
    const offset = index * 3;
    const radius = supportRadius[index];
    const x = center[offset];
    const y = center[offset + 1];
    const z = center[offset + 2];
    minX = Math.min(minX, x - radius);
    minY = Math.min(minY, y - radius);
    minZ = Math.min(minZ, z - radius);
    maxX = Math.max(maxX, x + radius);
    maxY = Math.max(maxY, y + radius);
    maxZ = Math.max(maxZ, z + radius);
    if ((position - start + 1) % yieldEvery === 0) await yieldToEventLoop();
  }
  const boundOffset = node * PACKED_BOUNDS_STRIDE;
  bounds[boundOffset + PACKED_MIN_X] = minX;
  bounds[boundOffset + PACKED_MIN_Y] = minY;
  bounds[boundOffset + PACKED_MIN_Z] = minZ;
  bounds[boundOffset + PACKED_MAX_X] = maxX;
  bounds[boundOffset + PACKED_MAX_Y] = maxY;
  bounds[boundOffset + PACKED_MAX_Z] = maxZ;
  return true;
};

const createPackedMedianHierarchyAsync = async ({
  leafSize,
  onProgress,
  shouldCancel,
  state,
  yieldEvery,
  yieldToEventLoop,
}) => {
  const { center, count, itemKey, opacity, sourceKey, supportRadius } = state;
  if (!count) return createPackedHierarchy(null, state, leafSize);
  const mortonOrder = state.order;
  const order = new Uint32Array(count);
  for (let start = 0; start < count; start += yieldEvery) {
    const end = Math.min(start + yieldEvery, count);
    for (let index = start; index < end; index += 1) order[index] = mortonOrder[index];
    reportBuildProgress(onProgress, "hierarchy", end, count, { topology: "median" });
    if (shouldCancel?.()) return canceledIndexingResult(end, count);
    if (end < count) await yieldToEventLoop();
  }
  const capacity = getMedianHierarchyCapacity(count, leafSize);
  const bounds = new Float64Array(capacity * PACKED_BOUNDS_STRIDE);
  const childLeft = new Int32Array(capacity);
  const childRight = new Int32Array(capacity);
  const leafStart = new Uint32Array(capacity);
  const leafLength = new Uint32Array(capacity);
  const stackCapacity = getMedianHierarchyStackCapacity(count, leafSize);
  const nodeStack = new Uint32Array(stackCapacity);
  const rangeStartStack = new Uint32Array(stackCapacity);
  const rangeEndStack = new Uint32Array(stackCapacity);
  childLeft.fill(-1);
  childRight.fill(-1);
  let nodeCount = 1;
  let stackLength = 1;
  let visitedNodes = 0;
  nodeStack[0] = 0;
  rangeStartStack[0] = 0;
  rangeEndStack[0] = count;
  while (stackLength) {
    stackLength -= 1;
    const node = nodeStack[stackLength];
    const start = rangeStartStack[stackLength];
    const end = rangeEndStack[stackLength];
    if (!(await fillMedianNodeBoundsAsync({
      bounds,
      center,
      end,
      node,
      order,
      shouldCancel,
      start,
      supportRadius,
      yieldEvery,
      yieldToEventLoop,
    }))) return canceledIndexingResult(start, count);
    const boundOffset = node * PACKED_BOUNDS_STRIDE;
    if (end - start <= leafSize) {
      leafStart[node] = start;
      leafLength[node] = end - start;
    } else {
      const extentX = bounds[boundOffset + PACKED_MAX_X] - bounds[boundOffset + PACKED_MIN_X];
      const extentY = bounds[boundOffset + PACKED_MAX_Y] - bounds[boundOffset + PACKED_MIN_Y];
      const extentZ = bounds[boundOffset + PACKED_MAX_Z] - bounds[boundOffset + PACKED_MIN_Z];
      const axis = extentY > extentX && extentY >= extentZ ? 1 : (extentZ > extentX && extentZ > extentY ? 2 : 0);
      const middle = start + Math.floor((end - start) / 2);
      const selected = await selectMedianOrderEntryAsync({
        axis,
        end,
        order,
        shouldCancel,
        start,
        state,
        target: middle,
        yieldEvery,
        yieldToEventLoop,
      });
      if (!selected) return canceledIndexingResult(start, count);
      const left = nodeCount;
      const right = nodeCount + 1;
      nodeCount += 2;
      childLeft[node] = left;
      childRight[node] = right;
      nodeStack[stackLength] = right;
      rangeStartStack[stackLength] = middle;
      rangeEndStack[stackLength] = end;
      stackLength += 1;
      nodeStack[stackLength] = left;
      rangeStartStack[stackLength] = start;
      rangeEndStack[stackLength] = middle;
      stackLength += 1;
    }
    visitedNodes += 1;
    if (visitedNodes % yieldEvery === 0) {
      reportBuildProgress(onProgress, "hierarchy", Math.min(end, count), count, { topology: "median" });
      if (shouldCancel?.()) return canceledIndexingResult(start, count);
      await yieldToEventLoop();
    }
  }
  reportBuildProgress(onProgress, "hierarchy", count, count, { topology: "median" });
  return Object.freeze({
    bounds: bounds.subarray(0, nodeCount * PACKED_BOUNDS_STRIDE),
    center,
    childLeft: childLeft.subarray(0, nodeCount),
    childRight: childRight.subarray(0, nodeCount),
    count,
    leafLength: leafLength.subarray(0, nodeCount),
    leafSize,
    leafStart: leafStart.subarray(0, nodeCount),
    itemKey,
    mortonOrder,
    nodeCount,
    nodes: childLeft.subarray(0, nodeCount),
    opacity,
    order,
    root: 0,
    sourceKey,
    supportRadius,
    topology: "median",
    traversalStack: new Int32Array(64),
  });
};

const createPackedHierarchyAsync = async ({
  leafSize,
  onProgress,
  shouldCancel,
  snapshot,
  state,
  yieldEvery,
  yieldToEventLoop,
}) => {
  const { center, count, itemKey, opacity, order, sourceKey, supportRadius } = state;
  if (!count) return createPackedHierarchy(snapshot, state, leafSize);
  const leafCount = Math.ceil(count / leafSize);
  const nodeCapacity = getPackedNodeCount(leafCount);
  const bounds = new Float64Array(nodeCapacity * PACKED_BOUNDS_STRIDE);
  const childLeft = new Int32Array(nodeCapacity);
  const childRight = new Int32Array(nodeCapacity);
  const leafStart = new Uint32Array(nodeCapacity);
  const leafLength = new Uint32Array(nodeCapacity);
  childLeft.fill(-1);
  childRight.fill(-1);
  for (let leaf = 0; leaf < leafCount; leaf += 1) {
    if (shouldCancel?.()) return canceledIndexingResult(Math.min(leaf * leafSize, count), count);
    const start = leaf * leafSize;
    const end = Math.min(start + leafSize, count);
    const boundOffset = leaf * PACKED_BOUNDS_STRIDE;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let position = start; position < end; position += 1) {
      const index = order[position];
      const offset = index * 3;
      const radius = supportRadius[index];
      const x = center[offset];
      const y = center[offset + 1];
      const z = center[offset + 2];
      minX = Math.min(minX, x - radius);
      minY = Math.min(minY, y - radius);
      minZ = Math.min(minZ, z - radius);
      maxX = Math.max(maxX, x + radius);
      maxY = Math.max(maxY, y + radius);
      maxZ = Math.max(maxZ, z + radius);
    }
    bounds[boundOffset + PACKED_MIN_X] = minX;
    bounds[boundOffset + PACKED_MIN_Y] = minY;
    bounds[boundOffset + PACKED_MIN_Z] = minZ;
    bounds[boundOffset + PACKED_MAX_X] = maxX;
    bounds[boundOffset + PACKED_MAX_Y] = maxY;
    bounds[boundOffset + PACKED_MAX_Z] = maxZ;
    leafStart[leaf] = start;
    leafLength[leaf] = end - start;
    if ((leaf + 1) % yieldEvery === 0 || leaf + 1 === leafCount) {
      reportBuildProgress(onProgress, "hierarchy", end, count);
      if (leaf + 1 < leafCount) await yieldToEventLoop();
    }
  }
  let nodeCount = leafCount;
  let current = new Uint32Array(leafCount);
  for (let index = 0; index < leafCount; index += 1) current[index] = index;
  while (current.length > 1) {
    const next = new Uint32Array(Math.ceil(current.length / 2));
    for (let start = 0; start < next.length; start += yieldEvery) {
      const end = Math.min(start + yieldEvery, next.length);
      for (let index = start; index < end; index += 1) {
        if (shouldCancel?.()) return canceledIndexingResult(0, count);
        const left = current[index * 2];
        const right = (index * 2) + 1 < current.length ? current[(index * 2) + 1] : -1;
        const node = nodeCount;
        nodeCount += 1;
        childLeft[node] = left;
        childRight[node] = right;
        const nodeOffset = node * PACKED_BOUNDS_STRIDE;
        const leftOffset = left * PACKED_BOUNDS_STRIDE;
        const rightOffset = right * PACKED_BOUNDS_STRIDE;
        bounds[nodeOffset + PACKED_MIN_X] = right < 0 ? bounds[leftOffset + PACKED_MIN_X] : Math.min(bounds[leftOffset + PACKED_MIN_X], bounds[rightOffset + PACKED_MIN_X]);
        bounds[nodeOffset + PACKED_MIN_Y] = right < 0 ? bounds[leftOffset + PACKED_MIN_Y] : Math.min(bounds[leftOffset + PACKED_MIN_Y], bounds[rightOffset + PACKED_MIN_Y]);
        bounds[nodeOffset + PACKED_MIN_Z] = right < 0 ? bounds[leftOffset + PACKED_MIN_Z] : Math.min(bounds[leftOffset + PACKED_MIN_Z], bounds[rightOffset + PACKED_MIN_Z]);
        bounds[nodeOffset + PACKED_MAX_X] = right < 0 ? bounds[leftOffset + PACKED_MAX_X] : Math.max(bounds[leftOffset + PACKED_MAX_X], bounds[rightOffset + PACKED_MAX_X]);
        bounds[nodeOffset + PACKED_MAX_Y] = right < 0 ? bounds[leftOffset + PACKED_MAX_Y] : Math.max(bounds[leftOffset + PACKED_MAX_Y], bounds[rightOffset + PACKED_MAX_Y]);
        bounds[nodeOffset + PACKED_MAX_Z] = right < 0 ? bounds[leftOffset + PACKED_MAX_Z] : Math.max(bounds[leftOffset + PACKED_MAX_Z], bounds[rightOffset + PACKED_MAX_Z]);
        next[index] = node;
      }
      reportBuildProgress(onProgress, "hierarchy", count, count, { levelNodes: next.length });
      if (end < next.length) await yieldToEventLoop();
    }
    current = next;
    if (shouldCancel?.()) return canceledIndexingResult(0, count);
    await yieldToEventLoop();
  }
  return Object.freeze({
    bounds,
    center,
    childLeft,
    childRight,
    count,
    leafLength,
    leafSize,
    leafStart,
    itemKey,
    nodeCount,
    nodes: childLeft,
    opacity,
    order,
    root: current[0],
    sourceKey,
    supportRadius,
    traversalStack: new Int32Array(64),
  });
};

export function createDeterministicSplatBvh(snapshot, { leafSize = STATIC_BAKE_LEAF_SIZE } = {}) {
  const count = validateStaticBakeSnapshot(snapshot, { requireRgb: false });
  const safeLeafSize = Math.max(1, Math.floor(finite(leafSize, STATIC_BAKE_LEAF_SIZE)));
  const state = createIndexingState(snapshot, count);
  scanIndexingState(snapshot, state, 0, count);
  fillMortonKeys(snapshot, state, 0, count);
  stableRadixSort(state);
  return count >= PACKED_MEDIAN_MIN_SPLATS
    ? createPackedMedianHierarchy(state, safeLeafSize)
    : createPackedHierarchy(snapshot, state, safeLeafSize);
}

/** Cooperative packed-BVH build used by the Worker and file:// fallback. */
export async function createDeterministicSplatBvhAsync(snapshot, {
  chunkSize = 4096,
  leafSize = STATIC_BAKE_LEAF_SIZE,
  onProgress,
  shouldCancel,
  yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0)),
} = {}) {
  const count = validateStaticBakeSnapshot(snapshot, { requireRgb: false });
  const safeLeafSize = Math.max(1, Math.floor(finite(leafSize, STATIC_BAKE_LEAF_SIZE)));
  const yieldEvery = Math.max(1, Math.floor(finite(chunkSize, 4096)));
  const state = createIndexingState(snapshot, count);
  for (let start = 0; start < count; start += yieldEvery) {
    const end = Math.min(start + yieldEvery, count);
    scanIndexingState(snapshot, state, start, end);
    reportBuildProgress(onProgress, "center-scan", end, count);
    if (shouldCancel?.()) return canceledIndexingResult(end, count);
    if (end < count) await yieldToEventLoop();
  }
  for (let start = 0; start < count; start += yieldEvery) {
    const end = Math.min(start + yieldEvery, count);
    fillMortonKeys(snapshot, state, start, end);
    reportBuildProgress(onProgress, "morton", end, count);
    if (shouldCancel?.()) return canceledIndexingResult(end, count);
    if (end < count) await yieldToEventLoop();
  }
  if (!(await stableRadixSortAsync({ onProgress, shouldCancel, state, yieldEvery, yieldToEventLoop }))) {
    return canceledIndexingResult(0, count);
  }
  if (count >= PACKED_MEDIAN_MIN_SPLATS) {
    return createPackedMedianHierarchyAsync({
      leafSize: safeLeafSize,
      onProgress,
      shouldCancel,
      state,
      yieldEvery,
      yieldToEventLoop,
    });
  }
  return createPackedHierarchyAsync({
    leafSize: safeLeafSize,
    onProgress,
    shouldCancel,
    snapshot,
    state,
    yieldEvery,
    yieldToEventLoop,
  });
}

/** Inclusive segment/AABB test. Bounds already include the 3-sigma sphere. */
export function segmentIntersectsAabb(lightPosition, receiverPosition, min, max) {
  const light = at3(lightPosition, 0);
  const receiver = at3(receiverPosition, 0);
  let enter = 0;
  let exit = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    const direction = receiver[axis] - light[axis];
    if (Math.abs(direction) < Number.EPSILON) {
      if (light[axis] < min[axis] || light[axis] > max[axis]) return false;
      continue;
    }
    const inverse = 1 / direction;
    let t0 = (min[axis] - light[axis]) * inverse;
    let t1 = (max[axis] - light[axis]) * inverse;
    if (t0 > t1) {
      const swap = t0;
      t0 = t1;
      t1 = swap;
    }
    enter = Math.max(enter, t0);
    exit = Math.min(exit, t1);
    if (enter > exit) return false;
  }
  return true;
}

export function gaussianSegmentOpticalDepth({
  lightPosition,
  opacity,
  receiverEndpointBias = 0,
  sourceEndpointBias = 0,
  receiverPosition,
  sigma,
  splatPosition,
} = {}) {
  const safeSigma = Math.max(finite(sigma), 0);
  const alpha = clamp(finite(opacity), 0, 1 - STATIC_BAKE_OPACITY_EPSILON);
  if (!(safeSigma > 0) || !(alpha > 0)) return 0;
  const light = at3(lightPosition, 0);
  const receiver = at3(receiverPosition, 0);
  const splat = at3(splatPosition, 0);
  const segment = [receiver[0] - light[0], receiver[1] - light[1], receiver[2] - light[2]];
  const segmentLengthSq = lengthSq(segment);
  if (!(segmentLengthSq > Number.EPSILON)) return 0;
  const segmentLength = Math.sqrt(segmentLengthSq);
  const toSplat = [splat[0] - light[0], splat[1] - light[1], splat[2] - light[2]];
  const t = dot(toSplat, segment) / segmentLengthSq;
  // A light/receiver endpoint is not an interposed occluder.  Use a strict
  // interior gate. Same-item callers can additionally exclude one local sigma
  // at the receiver so overlapping samples of one continuous surface do not
  // falsely shadow one another. Separate items retain contact-shadow behavior.
  const sourceEndpointT = Math.min(
    Math.max(finite(sourceEndpointBias) / segmentLength, STATIC_BAKE_SEGMENT_ENDPOINT_EPSILON),
    0.49,
  );
  const receiverEndpointT = Math.min(
    Math.max(finite(receiverEndpointBias) / segmentLength, STATIC_BAKE_SEGMENT_ENDPOINT_EPSILON),
    0.49,
  );
  if (!(t > sourceEndpointT && t < (1 - receiverEndpointT))) return 0;
  const nearest = [light[0] + (segment[0] * t), light[1] + (segment[1] * t), light[2] + (segment[2] * t)];
  const distanceSq = lengthSq([splat[0] - nearest[0], splat[1] - nearest[1], splat[2] - nearest[2]]);
  const support = safeSigma * STATIC_BAKE_SUPPORT_SIGMA;
  if (distanceSq > support * support) return 0;
  const gaussianWeight = Math.exp(-0.5 * distanceSq / (safeSigma * safeSigma));
  const opticalDepth = -Math.log1p(-alpha) * gaussianWeight;
  return Number.isFinite(opticalDepth) && opticalDepth >= 0 ? opticalDepth : 0;
}

const segmentIntersectsPackedBounds = (lightX, lightY, lightZ, receiverX, receiverY, receiverZ, bounds, offset) => {
  let enter = 0;
  let exit = 1;
  const directionX = receiverX - lightX;
  if (Math.abs(directionX) < Number.EPSILON) {
    if (lightX < bounds[offset + PACKED_MIN_X] || lightX > bounds[offset + PACKED_MAX_X]) return false;
  } else {
    const inverse = 1 / directionX;
    let t0 = (bounds[offset + PACKED_MIN_X] - lightX) * inverse;
    let t1 = (bounds[offset + PACKED_MAX_X] - lightX) * inverse;
    if (t0 > t1) {
      const swap = t0;
      t0 = t1;
      t1 = swap;
    }
    enter = Math.max(enter, t0);
    exit = Math.min(exit, t1);
    if (enter > exit) return false;
  }
  const directionY = receiverY - lightY;
  if (Math.abs(directionY) < Number.EPSILON) {
    if (lightY < bounds[offset + PACKED_MIN_Y] || lightY > bounds[offset + PACKED_MAX_Y]) return false;
  } else {
    const inverse = 1 / directionY;
    let t0 = (bounds[offset + PACKED_MIN_Y] - lightY) * inverse;
    let t1 = (bounds[offset + PACKED_MAX_Y] - lightY) * inverse;
    if (t0 > t1) {
      const swap = t0;
      t0 = t1;
      t1 = swap;
    }
    enter = Math.max(enter, t0);
    exit = Math.min(exit, t1);
    if (enter > exit) return false;
  }
  const directionZ = receiverZ - lightZ;
  if (Math.abs(directionZ) < Number.EPSILON) {
    if (lightZ < bounds[offset + PACKED_MIN_Z] || lightZ > bounds[offset + PACKED_MAX_Z]) return false;
  } else {
    const inverse = 1 / directionZ;
    let t0 = (bounds[offset + PACKED_MIN_Z] - lightZ) * inverse;
    let t1 = (bounds[offset + PACKED_MAX_Z] - lightZ) * inverse;
    if (t0 > t1) {
      const swap = t0;
      t0 = t1;
      t1 = swap;
    }
    enter = Math.max(enter, t0);
    exit = Math.min(exit, t1);
    if (enter > exit) return false;
  }
  return true;
};

export function evaluateBvhTransmission({ bvh, lightPosition, receiverIndex, snapshot, sourceIndex, lightDirection } = {}) {
  const receiverOffset = receiverIndex * 3;
  if (!bvh || bvh.root < 0 || receiverOffset < 0 || receiverOffset + 2 >= snapshot?.center?.length) {
    return { opticalDepth: 0, testedCandidates: 0, transmission: 1 };
  }
  if (lightDirection) lightPosition = directionalRayOrigin(bvh, receiverIndex, lightDirection);
  const lightX = finite(lightPosition?.[0]);
  const lightY = finite(lightPosition?.[1]);
  const lightZ = finite(lightPosition?.[2]);
  const receiverX = bvh.center[receiverOffset];
  const receiverY = bvh.center[receiverOffset + 1];
  const receiverZ = bvh.center[receiverOffset + 2];
  const receiverItem = bvh.itemKey[receiverIndex];
  const receiverSource = bvh.sourceKey[receiverIndex];
  const receiverSigma = bvh.supportRadius[receiverIndex] / STATIC_BAKE_SUPPORT_SIGMA;
  const hasSourceEndpoint = Number.isInteger(sourceIndex) && sourceIndex >= 0 && sourceIndex < bvh.count;
  const sourceItem = hasSourceEndpoint ? bvh.itemKey[sourceIndex] : 0;
  const sourceSource = hasSourceEndpoint ? bvh.sourceKey[sourceIndex] : 0;
  const sourceSigma = hasSourceEndpoint ? bvh.supportRadius[sourceIndex] / STATIC_BAKE_SUPPORT_SIGMA : 0;
  const segmentX = receiverX - lightX;
  const segmentY = receiverY - lightY;
  const segmentZ = receiverZ - lightZ;
  const segmentLengthSq = (segmentX * segmentX) + (segmentY * segmentY) + (segmentZ * segmentZ);
  if (!(segmentLengthSq > Number.EPSILON)) return { opticalDepth: 0, testedCandidates: 0, transmission: 1 };
  const segmentLength = Math.sqrt(segmentLengthSq);
  const alphaMaximum = 1 - STATIC_BAKE_OPACITY_EPSILON;
  let opticalDepth = 0;
  let testedCandidates = 0;
  const stack = bvh.traversalStack;
  let stackLength = 1;
  stack[0] = bvh.root;
  while (stackLength) {
    const node = stack[--stackLength];
    const boundOffset = node * PACKED_BOUNDS_STRIDE;
    if (!segmentIntersectsPackedBounds(lightX, lightY, lightZ, receiverX, receiverY, receiverZ, bvh.bounds, boundOffset)) continue;
    const length = bvh.leafLength[node];
    if (length) {
      const start = bvh.leafStart[node];
      const end = start + length;
      for (let position = start; position < end; position += 1) {
        const occluderIndex = bvh.order[position];
        const occluderItem = bvh.itemKey[occluderIndex];
        if (occluderItem === receiverItem && bvh.sourceKey[occluderIndex] === receiverSource) continue;
        if (hasSourceEndpoint && occluderItem === sourceItem && bvh.sourceKey[occluderIndex] === sourceSource) continue;
        const offset = occluderIndex * 3;
        const occluderSigma = bvh.supportRadius[occluderIndex] / STATIC_BAKE_SUPPORT_SIGMA;
        const alpha = bvh.opacity[occluderIndex];
        const clampedAlpha = alpha < 0 ? 0 : (alpha > alphaMaximum ? alphaMaximum : alpha);
        if (occluderSigma > 0 && clampedAlpha > 0) {
          const splatX = bvh.center[offset];
          const splatY = bvh.center[offset + 1];
          const splatZ = bvh.center[offset + 2];
          const t = (((splatX - lightX) * segmentX) + ((splatY - lightY) * segmentY) + ((splatZ - lightZ) * segmentZ)) / segmentLengthSq;
          const sourceEndpointBias = hasSourceEndpoint && occluderItem === sourceItem
            ? Math.max(sourceSigma, occluderSigma)
            : 0;
          const receiverEndpointBias = occluderItem === receiverItem ? Math.max(receiverSigma, occluderSigma) : 0;
          const sourceEndpointT = hasSourceEndpoint
            ? Math.min(Math.max(sourceEndpointBias / segmentLength, STATIC_BAKE_SEGMENT_ENDPOINT_EPSILON), 0.49)
            : (lightDirection ? 0 : STATIC_BAKE_SEGMENT_ENDPOINT_EPSILON);
          const receiverEndpointT = Math.min(
            Math.max(receiverEndpointBias / segmentLength, lightDirection ? 0 : STATIC_BAKE_SEGMENT_ENDPOINT_EPSILON),
            0.49,
          );
          if (t > sourceEndpointT && t < (1 - receiverEndpointT)) {
            const deltaX = splatX - (lightX + (segmentX * t));
            const deltaY = splatY - (lightY + (segmentY * t));
            const deltaZ = splatZ - (lightZ + (segmentZ * t));
            const distanceSq = (deltaX * deltaX) + (deltaY * deltaY) + (deltaZ * deltaZ);
            const support = occluderSigma * STATIC_BAKE_SUPPORT_SIGMA;
            if (distanceSq <= support * support) {
              const candidateDepth = -Math.log1p(-clampedAlpha) * Math.exp(-0.5 * distanceSq / (occluderSigma * occluderSigma));
              if (Number.isFinite(candidateDepth) && candidateDepth >= 0) opticalDepth += candidateDepth;
            }
          }
        }
        testedCandidates += 1;
      }
      continue;
    }
    const right = bvh.childRight[node];
    const left = bvh.childLeft[node];
    // Push in deterministic hierarchy order. The fixed Morton order makes the
    // small floating-point sum repeatable while leaving the physics unchanged.
    if (right >= 0) stack[stackLength++] = right;
    if (left >= 0) stack[stackLength++] = left;
  }
  const finiteDepth = Number.isFinite(opticalDepth) ? Math.max(opticalDepth, 0) : Number.MAX_VALUE;
  return {
    opticalDepth: finiteDepth,
    testedCandidates,
    transmission: Math.exp(-Math.min(finiteDepth, 745)),
  };
}

const authoredLambert = (snapshot, index, lightPosition) => {
  if (!snapshot.hasAuthoredNormal?.[index]) return 0;
  const offset = index * 3;
  const normal = at3(snapshot.normal, offset);
  const position = at3(snapshot.center, offset);
  const toLight = [lightPosition[0] - position[0], lightPosition[1] - position[1], lightPosition[2] - position[2]];
  const normalLengthSq = lengthSq(normal);
  const distanceSq = lengthSq(toLight);
  if (!(normalLengthSq > 0) || !(distanceSq > 0)) return 0;
  return Math.max(dot(normal, toLight) / Math.sqrt(normalLengthSq * distanceSq), 0);
};

const luminance = (rgb) => (rgb[0] * 0.2126) + (rgb[1] * 0.7152) + (rgb[2] * 0.0722);

const getAuthoredBounceReceiverIndices = (snapshot, count) => {
  const hasMaterial = snapshot.hasAuthoredBounceMaterial;
  const albedo = snapshot.authoredDiffuseAlbedo;
  const area = snapshot.authoredSurfaceArea;
  if (!hasMaterial || !albedo || !area) {
    throw new Error("Authored one bounce needs explicit authored diffuse albedo and surface-area arrays");
  }
  const receivers = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    const normal = at3(snapshot.normal, offset);
    if (
      snapshot.hasAuthoredNormal?.[index]
      && hasMaterial[index]
      && area[index] > 0
      && lengthSq(normal) > 0
    ) receivers.push(index);
  }
  return receivers;
};

const validateAuthoredOneBounceAvailability = (snapshot, count) => {
  const receivers = getAuthoredBounceReceiverIndices(snapshot, count);
  if (!receivers.length) {
    throw new Error("Authored one bounce needs at least one authored normal with explicit material provenance");
  }
  if (receivers.length > STATIC_BAKE_MAX_AUTHORED_BOUNCE_PATHS) {
    throw new Error(`Authored one bounce is unavailable: ${receivers.length.toLocaleString()} authored receivers exceed the ${STATIC_BAKE_MAX_AUTHORED_BOUNCE_PATHS.toLocaleString()} all-receiver path budget`);
  }
  return receivers;
};

const getAuthoredBounceAlbedo = (snapshot, index) => {
  const offset = index * 3;
  return [
    Math.max(finite(snapshot.authoredDiffuseAlbedo[offset]), 0),
    Math.max(finite(snapshot.authoredDiffuseAlbedo[offset + 1]), 0),
    Math.max(finite(snapshot.authoredDiffuseAlbedo[offset + 2]), 0),
  ];
};

const getAuthoredBounceSourceFlux = ({ index, lightColor, lightPosition, snapshot, transmission, intensity }) => {
  const offset = index * 3;
  const position = at3(snapshot.center, offset);
  const toLight = [lightPosition[0] - position[0], lightPosition[1] - position[1], lightPosition[2] - position[2]];
  const distanceSq = Math.max(lengthSq(toLight), STATIC_BAKE_DISTANCE_SQ_EPSILON);
  const directIrradiance = intensity * Math.max(finite(transmission[index]), 0) * authoredLambert(snapshot, index, lightPosition) / distanceSq;
  const scale = directIrradiance
    * Math.max(finite(snapshot.authoredSurfaceArea[index]), 0)
    * Math.max(finite(snapshot.opacity[index]), 0)
    / Math.PI;
  const albedo = getAuthoredBounceAlbedo(snapshot, index);
  return [
    albedo[0] * lightColor[0] * scale,
    albedo[1] * lightColor[1] * scale,
    albedo[2] * lightColor[2] * scale,
  ];
};

const getCoarseNormalDirectionKey = (snapshot, index) => {
  const normal = at3(snapshot.normal, index * 3);
  const absolute = [Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])];
  let axis = 0;
  if (absolute[1] > absolute[axis]) axis = 1;
  if (absolute[2] > absolute[axis]) axis = 2;
  return `${axis}:${normal[axis] < 0 ? "-" : "+"}`;
};

const selectClusterRepresentative = (candidates, start, end) => {
  let representative = candidates[start];
  let representativeEnergy = luminance(representative.flux);
  const flux = [0, 0, 0];
  for (let candidateIndex = start; candidateIndex < end; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];
    const energy = luminance(candidate.flux);
    flux[0] += candidate.flux[0];
    flux[1] += candidate.flux[1];
    flux[2] += candidate.flux[2];
    if (energy > representativeEnergy) {
      representative = candidate;
      representativeEnergy = energy;
    }
  }
  return { flux, groupKey: representative.groupKey, index: representative.index };
};

// Spatial compression is deliberately limited to a coherent source group:
// stable item identity plus a coarse authored-normal direction.  Each group
// retains at least one representative, so flux never crosses an item boundary
// or arrives through an incompatible-facing representative.
const selectAuthoredBounceSources = ({ bvh, lightColor, lightPosition, maxSources, receivers, snapshot, transmission, intensity }) => {
  const groups = new Map();
  let nonfiniteCount = 0;
  const receiverMask = new Uint8Array(snapshot.count);
  receivers.forEach((index) => { receiverMask[index] = 1; });
  const mortonOrder = bvh.mortonOrder?.length === bvh.count ? bvh.mortonOrder : bvh.order;
  for (let position = 0; position < mortonOrder.length; position += 1) {
    const index = mortonOrder[position];
    if (!receiverMask[index]) continue;
    const flux = getAuthoredBounceSourceFlux({ index, lightColor, lightPosition, snapshot, transmission, intensity });
    if (!flux.every(Number.isFinite)) {
      nonfiniteCount += 1;
    } else if (luminance(flux) > 0) {
      const groupKey = `${bvh.itemKey[index]}:${getCoarseNormalDirectionKey(snapshot, index)}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = { candidates: [], groupKey, totalEnergy: 0 };
        groups.set(groupKey, group);
      }
      group.candidates.push({ flux, groupKey, index });
      group.totalEnergy += luminance(flux);
    }
  }
  const coherentGroups = [...groups.values()];
  const candidateCount = coherentGroups.reduce((sum, group) => sum + group.candidates.length, 0);
  const effectiveCap = Math.min(maxSources, candidateCount);
  if (coherentGroups.length > effectiveCap) {
    throw new Error(`Authored one bounce is unavailable: ${coherentGroups.length.toLocaleString()} coherent source groups exceed the ${effectiveCap.toLocaleString()} source/path cap; no cross-group flux compression is permitted`);
  }
  coherentGroups.forEach((group) => { group.allocation = 1; });
  let remaining = effectiveCap - coherentGroups.length;
  while (remaining > 0) {
    let selected = null;
    for (const group of coherentGroups) {
      if (group.allocation >= group.candidates.length) continue;
      if (!selected) {
        selected = group;
        continue;
      }
      const groupPriority = group.totalEnergy / group.allocation;
      const selectedPriority = selected.totalEnergy / selected.allocation;
      const groupDensity = group.candidates.length / group.allocation;
      const selectedDensity = selected.candidates.length / selected.allocation;
      if (
        groupPriority > selectedPriority
        || (groupPriority === selectedPriority && groupDensity > selectedDensity)
        || (groupPriority === selectedPriority && groupDensity === selectedDensity && group.groupKey < selected.groupKey)
      ) selected = group;
    }
    if (!selected) break;
    selected.allocation += 1;
    remaining -= 1;
  }
  const sources = [];
  for (const group of coherentGroups) {
    for (let cluster = 0; cluster < group.allocation; cluster += 1) {
      const start = Math.floor((cluster * group.candidates.length) / group.allocation);
      const end = Math.floor(((cluster + 1) * group.candidates.length) / group.allocation);
      sources.push(selectClusterRepresentative(group.candidates, start, end));
    }
  }
  return { nonfiniteCount, sourceClusterGroupCount: coherentGroups.length, sources };
};

const getAuthoredSurfaceCosine = (snapshot, index, direction) => {
  const normal = at3(snapshot.normal, index * 3);
  const normalLengthSq = lengthSq(normal);
  const directionLengthSq = lengthSq(direction);
  if (!(normalLengthSq > 0) || !(directionLengthSq > 0)) return 0;
  return Math.max(dot(normal, direction) / Math.sqrt(normalLengthSq * directionLengthSq), 0);
};

const prepareAuthoredOneBounce = ({ bvh, lightColor, lightPosition, receivers, snapshot, transmission, intensity }) => {
  const allReceivers = receivers ?? validateAuthoredOneBounceAvailability(snapshot, snapshot.count);
  const maxSourcesByPaths = Math.floor(STATIC_BAKE_MAX_AUTHORED_BOUNCE_PATHS / allReceivers.length);
  if (maxSourcesByPaths < 1) {
    throw new Error(`Authored one bounce is unavailable: ${allReceivers.length.toLocaleString()} authored receivers exceed the ${STATIC_BAKE_MAX_AUTHORED_BOUNCE_PATHS.toLocaleString()} all-receiver path budget`);
  }
  const selection = selectAuthoredBounceSources({
    bvh,
    intensity,
    lightColor,
    lightPosition,
    maxSources: Math.min(STATIC_BAKE_MAX_AUTHORED_BOUNCE_SOURCES, maxSourcesByPaths),
    receivers: allReceivers,
    snapshot,
    transmission,
  });
  return {
    plannedPaths: selection.sources.length * allReceivers.length,
    receivers: allReceivers,
    selectedSourceIndices: Uint32Array.from(selection.sources.map((source) => source.index)),
    sourceClusterGroupCount: selection.sourceClusterGroupCount,
    sourceNonfiniteCount: selection.nonfiniteCount,
    sources: selection.sources,
  };
};

const evaluateAuthoredBouncePath = ({ bvh, receiverIndex, snapshot, source }) => {
  const sourceIndex = source.index;
  const sourcePosition = at3(snapshot.center, sourceIndex * 3);
  const receiverPosition = at3(snapshot.center, receiverIndex * 3);
  const toReceiver = [
    receiverPosition[0] - sourcePosition[0],
    receiverPosition[1] - sourcePosition[1],
    receiverPosition[2] - sourcePosition[2],
  ];
  const distanceSq = lengthSq(toReceiver);
  const sourceSigma = bvh.supportRadius[sourceIndex] / STATIC_BAKE_SUPPORT_SIGMA;
  const receiverSigma = bvh.supportRadius[receiverIndex] / STATIC_BAKE_SUPPORT_SIGMA;
  const nearFieldDistance = 2 * Math.max(sourceSigma, receiverSigma);
  if (!(distanceSq >= nearFieldDistance * nearFieldDistance)) return null;
  // The direct pass already evaluated light-to-source transmission for every
  // possible source.  Always evaluate this second exact leg before cosine
  // rejection so every non-near-field planned path has both visibility legs.
  const visibility = evaluateBvhTransmission({
    bvh,
    lightPosition: sourcePosition,
    receiverIndex,
    snapshot,
    sourceIndex,
  });
  const sourceCosine = getAuthoredSurfaceCosine(snapshot, sourceIndex, toReceiver);
  const receiverCosine = getAuthoredSurfaceCosine(snapshot, receiverIndex, [-toReceiver[0], -toReceiver[1], -toReceiver[2]]);
  if (!(sourceCosine > 0) || !(receiverCosine > 0)) return [0, 0, 0];
  const denominator = Math.max(distanceSq, nearFieldDistance * nearFieldDistance, STATIC_BAKE_DISTANCE_SQ_EPSILON);
  const scale = sourceCosine * receiverCosine * visibility.transmission / denominator;
  return [source.flux[0] * scale, source.flux[1] * scale, source.flux[2] * scale];
};

const createBounceDiagnostics = ({ nonfiniteCount, plannedPaths, receivers, selectedSourceIndices, sourceClusterGroupCount, testedPaths, totalIndirectLuminance }) => ({
  authoredBounceReceiverCount: receivers.length,
  nonfiniteCount,
  plannedPaths,
  selectedSourceCount: selectedSourceIndices.length,
  sourceClusterGroupCount,
  testedPaths,
  totalIndirectLuminance,
});

const applyAuthoredOneBounceSync = ({ bakedLinearRgb, bvh, lightColor, lightPosition, onProgress, receivers, shouldCancel, snapshot, transmission, intensity }) => {
  const prepared = prepareAuthoredOneBounce({ bvh, intensity, lightColor, lightPosition, receivers, snapshot, transmission });
  let nonfiniteCount = prepared.sourceNonfiniteCount;
  let testedPaths = 0;
  let totalIndirectLuminance = 0;
  let processed = 0;
  onProgress?.({ phase: "bounce", processed, total: prepared.plannedPaths });
  for (const source of prepared.sources) {
    for (const receiverIndex of prepared.receivers) {
      if (shouldCancel?.()) return { canceled: true, phase: "bounce", processed, total: prepared.plannedPaths };
      processed += 1;
      const transport = evaluateAuthoredBouncePath({ bvh, receiverIndex, snapshot, source });
      if (!transport) continue;
      testedPaths += 1;
      const albedo = getAuthoredBounceAlbedo(snapshot, receiverIndex);
      const increment = [transport[0] * albedo[0], transport[1] * albedo[1], transport[2] * albedo[2]];
      if (!increment.every(Number.isFinite)) {
        nonfiniteCount += 1;
        continue;
      }
      const offset = receiverIndex * 3;
      bakedLinearRgb[offset] += increment[0];
      bakedLinearRgb[offset + 1] += increment[1];
      bakedLinearRgb[offset + 2] += increment[2];
      totalIndirectLuminance += luminance(increment);
    }
    onProgress?.({ phase: "bounce", processed, total: prepared.plannedPaths });
  }
  return {
    canceled: false,
    diagnostics: createBounceDiagnostics({
      nonfiniteCount,
      plannedPaths: prepared.plannedPaths,
      receivers: prepared.receivers,
      selectedSourceIndices: prepared.selectedSourceIndices,
      sourceClusterGroupCount: prepared.sourceClusterGroupCount,
      testedPaths,
      totalIndirectLuminance,
    }),
    selectedSourceIndices: prepared.selectedSourceIndices,
  };
};

const applyAuthoredOneBounceAsync = async ({ bakedLinearRgb, bvh, lightColor, lightPosition, onProgress, receivers, shouldCancel, snapshot, transmission, intensity, yieldToEventLoop }) => {
  const prepared = prepareAuthoredOneBounce({ bvh, intensity, lightColor, lightPosition, receivers, snapshot, transmission });
  let nonfiniteCount = prepared.sourceNonfiniteCount;
  let testedPaths = 0;
  let totalIndirectLuminance = 0;
  let processed = 0;
  onProgress?.({ phase: "bounce", processed, total: prepared.plannedPaths });
  for (const source of prepared.sources) {
    for (const receiverIndex of prepared.receivers) {
      if (shouldCancel?.()) return { canceled: true, phase: "bounce", processed, total: prepared.plannedPaths };
      processed += 1;
      const transport = evaluateAuthoredBouncePath({ bvh, receiverIndex, snapshot, source });
      if (transport) {
        testedPaths += 1;
        const albedo = getAuthoredBounceAlbedo(snapshot, receiverIndex);
        const increment = [transport[0] * albedo[0], transport[1] * albedo[1], transport[2] * albedo[2]];
        if (!increment.every(Number.isFinite)) {
          nonfiniteCount += 1;
        } else {
          const offset = receiverIndex * 3;
          bakedLinearRgb[offset] += increment[0];
          bakedLinearRgb[offset + 1] += increment[1];
          bakedLinearRgb[offset + 2] += increment[2];
          totalIndirectLuminance += luminance(increment);
        }
      }
      // The Worker yields and checks cancel at least every 1,024 paths.  The
      // copy in bakedLinearRgb stays private until the whole job completes.
      if (processed % 1024 === 0) {
        onProgress?.({ phase: "bounce", processed, total: prepared.plannedPaths });
        await yieldToEventLoop();
        if (shouldCancel?.()) return { canceled: true, phase: "bounce", processed, total: prepared.plannedPaths };
      }
    }
  }
  onProgress?.({ phase: "bounce", processed, total: prepared.plannedPaths });
  return {
    canceled: false,
    diagnostics: createBounceDiagnostics({
      nonfiniteCount,
      plannedPaths: prepared.plannedPaths,
      receivers: prepared.receivers,
      selectedSourceIndices: prepared.selectedSourceIndices,
      sourceClusterGroupCount: prepared.sourceClusterGroupCount,
      testedPaths,
      totalIndirectLuminance,
    }),
    selectedSourceIndices: prepared.selectedSourceIndices,
  };
};

/**
 * Synchronous deterministic reference used by tests and worker jobs. Every
 * visible input splat is evaluated as both receiver and BVH occluder; there is
 * no sampling, proxy, or leaf-count cap.
 */
export function bakeAllSplatsDirectLight({ light, mode = STATIC_BAKE_MODE.DIRECT, onProgress, shouldCancel, snapshot } = {}) {
  const count = validateStaticBakeSnapshot(snapshot);
  if (mode !== STATIC_BAKE_MODE.DIRECT && mode !== STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE) {
    throw new Error(`Unsupported static bake mode: ${mode}`);
  }
  if (mode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE && light?.genericPolicy !== STATIC_BAKE_GENERIC_POLICY.PRESERVE) {
    throw new Error("Authored one bounce requires generic captured radiance to stay preserved");
  }
  const authoredBounceReceivers = mode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE
    ? validateAuthoredOneBounceAvailability(snapshot, count)
    : null;
  if (shouldCancel?.()) return { canceled: true, phase: "indexing", processed: 0, total: count };
  const lightPosition = at3(light?.position, 0);
  const lightColor = at3(light?.color, 0);
  const intensity = Math.max(finite(light?.intensity), 0);
  const bvh = createDeterministicSplatBvh(snapshot);
  reportBuildProgress(onProgress, "complete", count, count);
  const bakedLinearRgb = new Float32Array(snapshot.linearRgb);
  const transmission = new Float32Array(count);
  const opticalDepth = new Float32Array(count);
  const genericPolicy = light?.genericPolicy ?? STATIC_BAKE_GENERIC_POLICY.PRESERVE;
  const shadowFloor = clamp(finite(light?.shadowFloor), 0, 1);
  let authoredReceiverCount = 0;
  let authoredNormalCount = 0;
  let genericVisibilityModulatedCount = 0;
  let testedCandidates = 0;
  for (let index = 0; index < count; index += 1) {
    if (shouldCancel?.()) return { canceled: true, phase: "baking", processed: index, total: count };
    const visibility = evaluateBvhTransmission({ bvh, lightPosition, receiverIndex: index, snapshot });
    transmission[index] = visibility.transmission;
    opticalDepth[index] = visibility.opticalDepth;
    testedCandidates += visibility.testedCandidates;
    if (snapshot.hasAuthoredNormal?.[index]) authoredNormalCount += 1;
    const lambert = authoredLambert(snapshot, index, lightPosition);
    if (lambert > 0) {
      const offset = index * 3;
      const position = at3(snapshot.center, offset);
      const toLight = [lightPosition[0] - position[0], lightPosition[1] - position[1], lightPosition[2] - position[2]];
      const distanceSq = Math.max(lengthSq(toLight), STATIC_BAKE_DISTANCE_SQ_EPSILON);
      const strength = (intensity * visibility.transmission * lambert) / distanceSq;
      bakedLinearRgb[offset] = snapshot.linearRgb[offset] * (1 + (lightColor[0] * strength));
      bakedLinearRgb[offset + 1] = snapshot.linearRgb[offset + 1] * (1 + (lightColor[1] * strength));
      bakedLinearRgb[offset + 2] = snapshot.linearRgb[offset + 2] * (1 + (lightColor[2] * strength));
      authoredReceiverCount += 1;
    } else if (!snapshot.hasAuthoredNormal?.[index]
      && genericPolicy === STATIC_BAKE_GENERIC_POLICY.VISIBILITY_MODULATION) {
      const offset = index * 3;
      const modulation = shadowFloor + ((1 - shadowFloor) * visibility.transmission);
      bakedLinearRgb[offset] = snapshot.linearRgb[offset] * modulation;
      bakedLinearRgb[offset + 1] = snapshot.linearRgb[offset + 1] * modulation;
      bakedLinearRgb[offset + 2] = snapshot.linearRgb[offset + 2] * modulation;
      genericVisibilityModulatedCount += 1;
    }
    onProgress?.({ phase: "baking", processed: index + 1, total: count });
  }
  if (mode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE) {
    const bounce = applyAuthoredOneBounceSync({
      bakedLinearRgb,
      bvh,
      intensity,
      lightColor,
      lightPosition,
      onProgress,
      receivers: authoredBounceReceivers,
      shouldCancel,
      snapshot,
      transmission,
    });
    if (bounce.canceled) return bounce;
    return {
      bakedLinearRgb,
      bvhNodeCount: bvh.nodeCount,
      canceled: false,
      diagnostics: {
        authoredReceiverCount,
        authoredNormalCount,
        genericVisibilityModulatedCount,
        genericVisibilityOnlyCount: count - authoredNormalCount,
        testedCandidates,
        ...bounce.diagnostics,
      },
      opticalDepth,
      processed: count,
      selectedSourceIndices: bounce.selectedSourceIndices,
      total: count,
      transmission,
    };
  }
  return {
    bakedLinearRgb,
    bvhNodeCount: bvh.nodeCount,
    canceled: false,
    diagnostics: {
      authoredReceiverCount,
      authoredNormalCount,
      genericVisibilityModulatedCount,
      genericVisibilityOnlyCount: count - authoredNormalCount,
      testedCandidates,
    },
    opticalDepth,
    processed: count,
    total: count,
    transmission,
  };
}

/** Cooperative equivalent for the Worker and local-file main-thread fallback. */
export async function bakeAllSplatsDirectLightAsync({
  chunkSize = 128,
  indexingChunkSize = 4096,
  light,
  mode = STATIC_BAKE_MODE.DIRECT,
  onProgress,
  shouldCancel,
  snapshot,
  precomputedVisibility = null,
  yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0)),
} = {}) {
  const count = validateStaticBakeSnapshot(snapshot);
  if (mode !== STATIC_BAKE_MODE.DIRECT && mode !== STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE) {
    throw new Error(`Unsupported static bake mode: ${mode}`);
  }
  if (mode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE && light?.genericPolicy !== STATIC_BAKE_GENERIC_POLICY.PRESERVE) {
    throw new Error("Authored one bounce requires generic captured radiance to stay preserved");
  }
  const authoredBounceReceivers = mode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE
    ? validateAuthoredOneBounceAvailability(snapshot, count)
    : null;
  const lightPosition = at3(light?.position, 0);
  const lightColor = at3(light?.color, 0);
  const intensity = Math.max(finite(light?.intensity), 0);
  const safeChunkSize = Math.max(1, Math.floor(finite(chunkSize, 128)));
  if (precomputedVisibility && (precomputedVisibility.snapshot !== snapshot
    || precomputedVisibility.bvh?.count !== count
    || precomputedVisibility.transmission?.length !== count
    || precomputedVisibility.opticalDepth?.length !== count
    || precomputedVisibility.transmission.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
    || precomputedVisibility.opticalDepth.some((value) => !Number.isFinite(value) || value < 0))) {
    throw new Error("Precomputed visibility does not match the immutable bake snapshot");
  }
  const bvh = precomputedVisibility?.bvh ?? await createDeterministicSplatBvhAsync(snapshot, {
    chunkSize: Math.max(1, Math.floor(finite(indexingChunkSize, 4096))),
    onProgress,
    shouldCancel,
    yieldToEventLoop,
  });
  if (bvh?.canceled) return bvh;
  const bakedLinearRgb = new Float32Array(snapshot.linearRgb);
  const transmission = new Float32Array(count);
  const opticalDepth = new Float32Array(count);
  const genericPolicy = light?.genericPolicy ?? STATIC_BAKE_GENERIC_POLICY.PRESERVE;
  const shadowFloor = clamp(finite(light?.shadowFloor), 0, 1);
  let authoredReceiverCount = 0;
  let authoredNormalCount = 0;
  let genericVisibilityModulatedCount = 0;
  let testedCandidates = 0;
  for (let start = 0; start < count; start += safeChunkSize) {
    const end = Math.min(start + safeChunkSize, count);
    for (let index = start; index < end; index += 1) {
      if (shouldCancel?.()) return { canceled: true, phase: "baking", processed: index, total: count };
      const visibility = precomputedVisibility
        ? { transmission: precomputedVisibility.transmission[index], opticalDepth: precomputedVisibility.opticalDepth[index], testedCandidates: 0 }
        : evaluateBvhTransmission({ bvh, lightPosition, receiverIndex: index, snapshot });
      transmission[index] = visibility.transmission;
      opticalDepth[index] = visibility.opticalDepth;
      testedCandidates += visibility.testedCandidates;
      if (snapshot.hasAuthoredNormal?.[index]) authoredNormalCount += 1;
      const lambert = authoredLambert(snapshot, index, lightPosition);
      if (lambert > 0) {
        const offset = index * 3;
        const position = at3(snapshot.center, offset);
        const toLight = [lightPosition[0] - position[0], lightPosition[1] - position[1], lightPosition[2] - position[2]];
        const distanceSq = Math.max(lengthSq(toLight), STATIC_BAKE_DISTANCE_SQ_EPSILON);
        const strength = (intensity * visibility.transmission * lambert) / distanceSq;
        bakedLinearRgb[offset] = snapshot.linearRgb[offset] * (1 + (lightColor[0] * strength));
        bakedLinearRgb[offset + 1] = snapshot.linearRgb[offset + 1] * (1 + (lightColor[1] * strength));
        bakedLinearRgb[offset + 2] = snapshot.linearRgb[offset + 2] * (1 + (lightColor[2] * strength));
        authoredReceiverCount += 1;
      } else if (!snapshot.hasAuthoredNormal?.[index]
        && genericPolicy === STATIC_BAKE_GENERIC_POLICY.VISIBILITY_MODULATION) {
        const offset = index * 3;
        const modulation = shadowFloor + ((1 - shadowFloor) * visibility.transmission);
        bakedLinearRgb[offset] = snapshot.linearRgb[offset] * modulation;
        bakedLinearRgb[offset + 1] = snapshot.linearRgb[offset + 1] * modulation;
        bakedLinearRgb[offset + 2] = snapshot.linearRgb[offset + 2] * modulation;
        genericVisibilityModulatedCount += 1;
      }
    }
    onProgress?.({ phase: "baking", processed: end, total: count });
    if (end < count) await yieldToEventLoop();
  }
  if (mode === STATIC_BAKE_MODE.AUTHORED_ONE_BOUNCE) {
    const bounce = await applyAuthoredOneBounceAsync({
      bakedLinearRgb,
      bvh,
      intensity,
      lightColor,
      lightPosition,
      onProgress,
      receivers: authoredBounceReceivers,
      shouldCancel,
      snapshot,
      transmission,
      yieldToEventLoop,
    });
    if (bounce.canceled) return bounce;
    return {
      bakedLinearRgb,
      bvhNodeCount: bvh.nodeCount,
      canceled: false,
      diagnostics: {
        authoredReceiverCount,
        authoredNormalCount,
        genericVisibilityModulatedCount,
        genericVisibilityOnlyCount: count - authoredNormalCount,
        testedCandidates,
        ...bounce.diagnostics,
      },
      opticalDepth,
      processed: count,
      selectedSourceIndices: bounce.selectedSourceIndices,
      total: count,
      transmission,
    };
  }
  return {
    bakedLinearRgb,
    bvhNodeCount: bvh.nodeCount,
    canceled: false,
    diagnostics: {
      authoredReceiverCount,
      authoredNormalCount,
      genericVisibilityModulatedCount,
      genericVisibilityOnlyCount: count - authoredNormalCount,
      testedCandidates,
    },
    opticalDepth,
    processed: count,
    total: count,
    transmission,
  };
}

/** Mode-oriented aliases keep the established direct API source-compatible. */
export function bakeAllSplatsStaticLight(options = {}) {
  return bakeAllSplatsDirectLight(options);
}

export async function bakeAllSplatsStaticLightAsync(options = {}) {
  return bakeAllSplatsDirectLightAsync(options);
}

export function createStaticBakeJobToken() {
  let active = true;
  return Object.freeze({ cancel: () => { active = false; }, isActive: () => active });
}

/** Keep a caller-owned original snapshot recoverable if any setter fails. */
export function runStaticBakeColorTransaction({ applyBaked, restoreOriginal } = {}) {
  try {
    return { error: null, result: applyBaked?.(), rollbackError: null, rolledBack: false };
  } catch (error) {
    try {
      restoreOriginal?.();
      return { error, result: null, rollbackError: null, rolledBack: true };
    } catch (rollbackError) {
      return { error, result: null, rollbackError, rolledBack: false };
    }
  }
}
