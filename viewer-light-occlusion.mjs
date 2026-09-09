import {
  createDeterministicSplatBvhAsync,
  evaluateBvhTransmission,
  validateStaticBakeSnapshot,
} from "./viewer-static-lighting.mjs";

/**
 * The live occlusion buffer has a deliberately bounded, all-or-nothing shape.
 * These are scalar transmission entries, not RGB entries.
 */
export const LIGHT_OCCLUSION_MAX_LIGHTS = 8;
export const LIGHT_OCCLUSION_MAX_SCALAR_SLOTS = 8_000_000;
export const LIGHT_OCCLUSION_MAX_TEXTURE_WIDTH = 1024;

const DEFAULT_CHUNK_SIZE = 128;
const DEFAULT_INDEXING_CHUNK_SIZE = 4096;

const positiveInteger = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(1, Math.floor(number)) : fallback;
};

const nonnegativeSafeInteger = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Light occlusion ${name} must be a non-negative safe integer`);
  }
  return value;
};

const highestPowerOfTwoAtMost = (value) => {
  let power = 1;
  while ((power * 2) <= value) power *= 2;
  return power;
};

const createCanceledResult = ({
  bvhNodeCount = 0,
  diagnostics = {},
  lightCount,
  lightIds,
  phase,
  processed,
  scalarSlots,
  total,
}) => ({
  canceled: true,
  diagnostics: {
    bvhNodeCount,
    lightCount,
    scalarSlots,
    testedCandidates: 0,
    ...diagnostics,
  },
  lightCount,
  lightIds,
  phase,
  processed,
  total,
  // Cancellation deliberately exposes no partly-filled visibility buffer.
  transmission: null,
});

export const validateLights = (lights) => {
  if (!Array.isArray(lights) || lights.length === 0) {
    throw new Error("Light occlusion needs at least one light sample");
  }
  if (lights.length > LIGHT_OCCLUSION_MAX_LIGHTS) {
    throw new Error(`Light occlusion supports at most ${LIGHT_OCCLUSION_MAX_LIGHTS} light samples; no partial sampling is performed`);
  }
  const ids = [];
  const positions = [];
  const directions = [];
  const seenIds = new Set();
  lights.forEach((light, index) => {
    const id = light?.id;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error(`Light occlusion light ${index + 1} needs a nonempty id`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Light occlusion light ids must be unique: ${id}`);
    }
    const position = light?.position;
    if (!position || position.length < 3 || ![position[0], position[1], position[2]].every(Number.isFinite)) {
      throw new Error(`Light occlusion light ${id} needs a finite [x, y, z] position`);
    }
    seenIds.add(id);
    ids.push(id);
    positions.push([position[0], position[1], position[2]]);
    const d = light?.direction;
    if (light?.type === 'directional' && (!d || d.length !== 3 || !d.every(Number.isFinite) || !(Math.hypot(...d) > 0))) {
      throw new Error(`Light occlusion light ${id} needs a finite nonzero direction`);
    }
    directions.push(light?.type === 'directional' ? d.map(v => v / Math.hypot(...d)) : null);
  });
  return { lightIds: Object.freeze(ids), positions, directions };
};

/**
 * Plans a scalar texture for the interleaved [flat splat * lightCount + light]
 * visibility buffer.  It intentionally does not allocate a GPU texture.
 */
export function getLightOcclusionTextureLayout({ splatCount, lightCount, maxTextureSize } = {}) {
  const safeSplatCount = nonnegativeSafeInteger(splatCount, "splatCount");
  const safeLightCount = nonnegativeSafeInteger(lightCount, "lightCount");
  if (safeLightCount < 1 || safeLightCount > LIGHT_OCCLUSION_MAX_LIGHTS) {
    throw new Error(`Light occlusion requires 1 to ${LIGHT_OCCLUSION_MAX_LIGHTS} lights`);
  }
  const texelCount = safeSplatCount * safeLightCount;
  if (!Number.isSafeInteger(texelCount)) {
    throw new Error("Light occlusion texture texel count exceeds the safe integer range");
  }
  if (texelCount > LIGHT_OCCLUSION_MAX_SCALAR_SLOTS) {
    throw new Error(`Light occlusion exceeds the ${LIGHT_OCCLUSION_MAX_SCALAR_SLOTS.toLocaleString()} scalar slot budget`);
  }
  if (!Number.isSafeInteger(maxTextureSize) || maxTextureSize < 1) {
    throw new Error("Light occlusion texture needs a positive device maxTextureSize");
  }
  const maxWidth = highestPowerOfTwoAtMost(Math.min(LIGHT_OCCLUSION_MAX_TEXTURE_WIDTH, maxTextureSize));
  let width = 1;
  while (width < texelCount && width < maxWidth) width *= 2;
  const height = Math.max(1, Math.ceil(texelCount / width));
  if (height > maxTextureSize) {
    const capacity = width * maxTextureSize;
    throw new Error(`Light occlusion texture needs ${texelCount.toLocaleString()} texels, exceeding the ${capacity.toLocaleString()} texel device capacity`);
  }
  return Object.freeze({ height, texelCount, width });
}

/**
 * Computes live point-light visibility only.  Every visible snapshot splat is
 * both a receiver and a BVH occluder.  The reused kernel is a conservative
 * spherical max-sigma Gaussian optical-depth approximation, not exact
 * anisotropic or physically based point-light occlusion.
 */
export async function computeAllSplatLightTransmissionAsync({
  chunkSize = DEFAULT_CHUNK_SIZE,
  indexingChunkSize = DEFAULT_INDEXING_CHUNK_SIZE,
  lights,
  onProgress,
  shouldCancel,
  snapshot,
  yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0)),
} = {}) {
  // Keep the exact static-bake transform rejection and owned-world snapshot
  // contract.  Validation is intentionally complete before BVH indexing.
  const total = validateStaticBakeSnapshot(snapshot, { requireRgb: false });
  const { lightIds, positions, directions } = validateLights(lights);
  const lightCount = lightIds.length;
  const scalarSlots = total * lightCount;
  if (!Number.isSafeInteger(scalarSlots) || scalarSlots > LIGHT_OCCLUSION_MAX_SCALAR_SLOTS) {
    throw new Error(`Light occlusion needs ${scalarSlots.toLocaleString()} scalar slots, exceeding the ${LIGHT_OCCLUSION_MAX_SCALAR_SLOTS.toLocaleString()} all-or-nothing budget`);
  }
  if (shouldCancel?.()) {
    return createCanceledResult({
      lightCount,
      lightIds,
      phase: "indexing",
      processed: 0,
      scalarSlots,
      total,
    });
  }

  const reportIndexingProgress = typeof onProgress === "function"
    ? (progress) => onProgress({ ...progress, lightCount, scalarSlots })
    : undefined;
  const bvh = await createDeterministicSplatBvhAsync(snapshot, {
    chunkSize: positiveInteger(indexingChunkSize, DEFAULT_INDEXING_CHUNK_SIZE),
    onProgress: reportIndexingProgress,
    shouldCancel,
    yieldToEventLoop,
  });
  if (bvh?.canceled) {
    return createCanceledResult({
      lightCount,
      lightIds,
      phase: bvh.phase ?? "indexing",
      processed: bvh.processed ?? 0,
      scalarSlots,
      total,
    });
  }

  // This is the only result allocation.  No RGB buffer is copied, changed, or
  // returned by this visibility-only operation.
  const transmission = new Float32Array(scalarSlots);
  const safeChunkSize = positiveInteger(chunkSize, DEFAULT_CHUNK_SIZE);
  let testedCandidates = 0;
  for (let start = 0; start < total; start += safeChunkSize) {
    const end = Math.min(start + safeChunkSize, total);
    for (let flatIndex = start; flatIndex < end; flatIndex += 1) {
      if (shouldCancel?.()) {
        return createCanceledResult({
          bvhNodeCount: bvh.nodeCount,
          diagnostics: { testedCandidates },
          lightCount,
          lightIds,
          phase: "occlusion",
          processed: flatIndex,
          scalarSlots,
          total,
        });
      }
      const outputOffset = flatIndex * lightCount;
      for (let lightIndex = 0; lightIndex < lightCount; lightIndex += 1) {
        if (shouldCancel?.()) {
          return createCanceledResult({
            bvhNodeCount: bvh.nodeCount,
            diagnostics: { testedCandidates },
            lightCount,
            lightIds,
            phase: "occlusion",
            processed: flatIndex,
            scalarSlots,
            total,
          });
        }
        const visibility = evaluateBvhTransmission({
          bvh,
          lightPosition: positions[lightIndex],
          lightDirection: directions[lightIndex],
          receiverIndex: flatIndex,
          snapshot,
        });
        transmission[outputOffset + lightIndex] = visibility.transmission;
        testedCandidates += visibility.testedCandidates;
      }
    }
    onProgress?.({
      lightCount,
      phase: "occlusion",
      processed: end,
      scalarSlots,
      total,
    });
    if (end < total) await yieldToEventLoop();
  }

  return {
    canceled: false,
    diagnostics: {
      bvhNodeCount: bvh.nodeCount,
      lightCount,
      scalarSlots,
      testedCandidates,
    },
    lightCount,
    lightIds,
    processed: total,
    total,
    transmission,
  };
}
