export const DEFAULT_LIGHT_COLOR = {
  r: 1,
  g: 1,
  b: 1,
};

export const DEFAULT_LIGHT_HELPER_SCALE = 0.1;

// Viewer primitives keep their authored normal direction. Imported Gaussian
// orientations use the shortest covariance axis, face-forwarded to the camera;
// this is only a relightable approximation, not imported surface-normal data.
export const DIRECT_LIGHT_NORMAL_POLICY = Object.freeze({
  AUTHORED_ONE_SIDED: "authored-one-sided",
  IMPORTED_COVARIANCE_FACE_FORWARD: "imported-covariance-face-forward",
});
export const DIRECT_LIGHT_DISTANCE_SQ_EPSILON = 0.0001;
export const DIRECT_LIGHT_SHADOW_ENDPOINT_RADIUS_MULTIPLIER = 1.5;
export const DIRECT_LIGHT_MAX_PROXY_RADIUS_MULTIPLIER = 12;
export const ONE_BOUNCE_VPL_LIMIT = 6;
export const ONE_BOUNCE_VPL_GAIN = 0.15;
export const ONE_BOUNCE_VPL_NEAR_RADIUS_MULTIPLIER = 2;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const finiteNumber = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

const vector3 = (value = {}) => {
  if (Array.isArray(value)) {
    return [finiteNumber(value[0]), finiteNumber(value[1]), finiteNumber(value[2])];
  }
  return [
    finiteNumber(value.x),
    finiteNumber(value.y),
    finiteNumber(value.z),
  ];
};

const linearRgb = (value = {}) => {
  if (Array.isArray(value)) {
    return [finiteNumber(value[0]), finiteNumber(value[1]), finiteNumber(value[2])];
  }
  return [
    finiteNumber(value.r ?? value.x),
    finiteNumber(value.g ?? value.y),
    finiteNumber(value.b ?? value.z),
  ];
};

const dot = (left, right) =>
  (left[0] * right[0]) + (left[1] * right[1]) + (left[2] * right[2]);

const multiplyRgb = (left, right) => [
  left[0] * right[0],
  left[1] * right[1],
  left[2] * right[2],
];

const subtractVector3 = (left, right) => [
  left[0] - right[0],
  left[1] - right[1],
  left[2] - right[2],
];

const addScaledVector3 = (origin, direction, scale) => [
  origin[0] + (direction[0] * scale),
  origin[1] + (direction[1] * scale),
  origin[2] + (direction[2] * scale),
];

export function orientDirectLightNormal({
  cameraPosition,
  normal,
  normalPolicy = DIRECT_LIGHT_NORMAL_POLICY.AUTHORED_ONE_SIDED,
  position,
} = {}) {
  const surfaceNormal = vector3(normal);
  if (normalPolicy !== DIRECT_LIGHT_NORMAL_POLICY.IMPORTED_COVARIANCE_FACE_FORWARD) {
    return surfaceNormal;
  }
  const surfacePosition = vector3(position);
  const camera = vector3(cameraPosition);
  const toCamera = [
    camera[0] - surfacePosition[0],
    camera[1] - surfacePosition[1],
    camera[2] - surfacePosition[2],
  ];
  return dot(surfaceNormal, toCamera) < 0
    ? [-surfaceNormal[0], -surfaceNormal[1], -surfaceNormal[2]]
    : surfaceNormal;
}

export function clampLightColor(color = {}) {
  return {
    r: Number(clamp(Number(color.r) || 0, 0, 1).toFixed(4)),
    g: Number(clamp(Number(color.g) || 0, 0, 1).toFixed(4)),
    b: Number(clamp(Number(color.b) || 0, 0, 1).toFixed(4)),
  };
}

export function createDefaultLightState({ sceneLightSerial, radius } = {}) {
  const serial = Number.isFinite(sceneLightSerial) ? sceneLightSerial : 1;
  const safeRadius = Math.max(Number(radius) || 0, 1);
  return {
    color: clampLightColor(DEFAULT_LIGHT_COLOR),
    helperScale: DEFAULT_LIGHT_HELPER_SCALE,
    intensity: Math.max(safeRadius * safeRadius * 4, 12),
    name: `Point Light ${serial}`,
  };
}

/**
 * Expands a selected proxy to represent omitted Gaussian samples. The raw
 * radius remains the world-space max-axis scale; this factor only accounts for
 * deterministic sample decimation and is dimensionless.
 */
export function computeSampledGaussianProxyRadius({
  maxMultiplier = DIRECT_LIGHT_MAX_PROXY_RADIUS_MULTIPLIER,
  selectedSampleCount = 1,
  sourceSampleCount = 1,
  worldRadius = 0,
} = {}) {
  const sourceCount = Math.max(finiteNumber(sourceSampleCount, 1), 1);
  const selectedCount = Math.max(finiteNumber(selectedSampleCount, 1), 1);
  const multiplier = Math.min(
    Math.max(finiteNumber(maxMultiplier, DIRECT_LIGHT_MAX_PROXY_RADIUS_MULTIPLIER), 1),
    Math.max(Math.sqrt(sourceCount / selectedCount), 1),
  );
  return Math.max(finiteNumber(worldRadius), 0) * multiplier;
}

/**
 * Estimates one Gaussian sample's soft coverage of the light-to-receiver
 * segment. Both endpoints are shortened by a radius-relative bias, so a
 * sample at the receiver does not shadow itself while samples farther along
 * the segment can still do so. All distances use native, unspecified scene
 * units.
 */
export function evaluateGaussianSegmentCoverage({
  endpointBiasRadiusMultiplier = DIRECT_LIGHT_SHADOW_ENDPOINT_RADIUS_MULTIPLIER,
  lightPosition,
  occluderPosition,
  opacity = 1,
  radius = 0,
  receiverPosition,
} = {}) {
  const light = vector3(lightPosition);
  const receiver = vector3(receiverPosition);
  const occluder = vector3(occluderPosition);
  const segment = subtractVector3(receiver, light);
  const segmentLengthSq = dot(segment, segment);
  const safeRadius = Math.max(finiteNumber(radius), 0);
  const safeOpacity = clamp(finiteNumber(opacity, 1), 0, 1);
  if (!(segmentLengthSq > Number.EPSILON) || !(safeRadius > 0) || !(safeOpacity > 0)) {
    return 0;
  }

  const segmentLength = Math.sqrt(segmentLengthSq);
  const direction = [
    segment[0] / segmentLength,
    segment[1] / segmentLength,
    segment[2] / segmentLength,
  ];
  const endpointBias = Math.min(
    segmentLength * 0.25,
    safeRadius * Math.max(finiteNumber(endpointBiasRadiusMultiplier, DIRECT_LIGHT_SHADOW_ENDPOINT_RADIUS_MULTIPLIER), 0),
  );
  const biasedLight = addScaledVector3(light, direction, endpointBias);
  const biasedReceiver = addScaledVector3(receiver, direction, -endpointBias);
  const biasedSegment = subtractVector3(biasedReceiver, biasedLight);
  const biasedSegmentLengthSq = dot(biasedSegment, biasedSegment);
  if (!(biasedSegmentLengthSq > Number.EPSILON)) {
    return 0;
  }

  const toOccluder = subtractVector3(occluder, biasedLight);
  const rawT = dot(toOccluder, biasedSegment) / biasedSegmentLengthSq;
  if (!(rawT > 0 && rawT < 1)) {
    return 0;
  }
  const t = clamp(rawT, 0, 1);
  const closestPoint = addScaledVector3(biasedLight, biasedSegment, t);
  const closestDistance = subtractVector3(occluder, closestPoint);
  const softCoverage = clamp(1 - (dot(closestDistance, closestDistance) / (safeRadius * safeRadius)), 0, 1);
  return clamp(softCoverage * safeOpacity, 0, 1);
}

/**
 * Accumulates sampled Gaussian shadow coverage into finite transmission. This
 * is an approximate sample set rather than an analytic scene-geometry shadow.
 */
export function evaluateSampledLightTransmission({
  lightPosition,
  occluders = [],
  receiverPosition,
} = {}) {
  let transmission = 1;
  occluders.forEach((occluder) => {
    const coverage = evaluateGaussianSegmentCoverage({
      lightPosition,
      occluderPosition: occluder?.position ?? occluder?.occluderPosition,
      opacity: occluder?.opacity,
      radius: occluder?.radius,
      receiverPosition,
    });
    transmission = clamp(transmission * (1 - coverage), 0, 1);
  });
  return Number.isFinite(transmission) ? transmission : 1;
}

/**
 * Returns linear-RGB irradiance from a point or directional light sample. A missing or
 * zero-length normal deliberately returns black, and a coincident light has no
 * direction. Imported covariance normals are oriented by the selected policy.
 */
export function evaluateDirectPointLight({
  intensity = 0,
  lightColor = DEFAULT_LIGHT_COLOR,
  lightPosition,
  lightDirection,
  emissionDirection,
  normal,
  normalPolicy = DIRECT_LIGHT_NORMAL_POLICY.AUTHORED_ONE_SIDED,
  position,
  cameraPosition,
  visibility = 1,
  distanceSqEpsilon = DIRECT_LIGHT_DISTANCE_SQ_EPSILON,
} = {}) {
  const surfacePosition = vector3(position);
  const sourcePosition = vector3(lightPosition);
  const surfaceNormal = orientDirectLightNormal({
    cameraPosition,
    normal,
    normalPolicy,
    position,
  });
  const toLight = lightDirection ? vector3(lightDirection).map(v => -v) : [
    sourcePosition[0] - surfacePosition[0],
    sourcePosition[1] - surfacePosition[1],
    sourcePosition[2] - surfacePosition[2],
  ];
  const rawDistanceSq = dot(toLight, toLight);
  const normalLengthSq = dot(surfaceNormal, surfaceNormal);
  if (!(rawDistanceSq > 0) || !(normalLengthSq > 0)) {
    return [0, 0, 0];
  }

  const safeDistanceSq = lightDirection ? 1 : Math.max(
    rawDistanceSq,
    Math.max(finiteNumber(distanceSqEpsilon, DIRECT_LIGHT_DISTANCE_SQ_EPSILON), Number.EPSILON),
  );
  const facing = Math.max(
    dot(surfaceNormal, toLight) / Math.sqrt(normalLengthSq * rawDistanceSq),
    0,
  );
  const emitterNormal = emissionDirection ? vector3(emissionDirection) : null;
  const emissionFacing = emitterNormal
    ? Math.max(-dot(emitterNormal, toLight) / (Math.hypot(...emitterNormal) * Math.sqrt(rawDistanceSq) || 1), 0)
    : 1;
  const strength = (
    Math.max(finiteNumber(intensity), 0)
    * clamp(finiteNumber(visibility, 1), 0, 1)
    * facing
    * emissionFacing
  ) / safeDistanceSq;
  const color = linearRgb(lightColor);
  return [color[0] * strength, color[1] * strength, color[2] * strength];
}

/**
 * Keeps the baked linear-RGB base term and adds base-color-modulated direct
 * light. Imported splats use a camera-facing covariance-normal approximation.
 */
export function applyDirectLighting({
  baseLinearRgb,
  lights = [],
  normal,
  normalPolicy = DIRECT_LIGHT_NORMAL_POLICY.AUTHORED_ONE_SIDED,
  position,
  cameraPosition,
  distanceSqEpsilon = DIRECT_LIGHT_DISTANCE_SQ_EPSILON,
} = {}) {
  const base = linearRgb(baseLinearRgb);
  const directIrradiance = [0, 0, 0];
  if (!normal) {
    return base;
  }
  lights.forEach((light) => {
    if (light?.visible === false) {
      return;
    }
    const contribution = evaluateDirectPointLight({
      distanceSqEpsilon,
      intensity: light?.intensity,
      lightColor: light?.color,
      lightPosition: light?.position,
      lightDirection: light?.type === 'directional' ? light.direction : null,
      emissionDirection: light?.type === 'area-sample' ? light.direction : null,
      normal,
      normalPolicy,
      position,
      cameraPosition,
      visibility: light?.visibility,
    });
    directIrradiance[0] += contribution[0];
    directIrradiance[1] += contribution[1];
    directIrradiance[2] += contribution[2];
  });
  const directIncrement = multiplyRgb(base, directIrradiance);
  return [
    base[0] + directIncrement[0],
    base[1] + directIncrement[1],
    base[2] + directIncrement[2],
  ];
}

const linearLuminance = (rgb) => (
  (rgb[0] * 0.2126) + (rgb[1] * 0.7152) + (rgb[2] * 0.0722)
);

/**
 * Chooses a fixed, deterministic set of authored-normal virtual point lights.
 * Their flux is an intentionally small, unoccluded receiver-side preview: the
 * source uses the existing sampled transmission, but VPL-to-receiver paths do
 * not test visibility and can leak through occluders. After ranking, selected
 * source area/opacity weights are normalized so sample density cannot increase
 * total bounce energy. All radii and positions remain in native, unspecified
 * scene units.
 */
export function selectOneBounceVpls({
  candidates = [],
  enabled = false,
  gain = ONE_BOUNCE_VPL_GAIN,
  light,
  limit = ONE_BOUNCE_VPL_LIMIT,
} = {}) {
  if (!enabled || !light || light.visible === false) {
    return [];
  }
  const safeGain = Math.max(finiteNumber(gain, ONE_BOUNCE_VPL_GAIN), 0);
  const safeLimit = Math.max(Math.floor(finiteNumber(limit, ONE_BOUNCE_VPL_LIMIT)), 0);
  if (!(safeGain > 0) || !(safeLimit > 0)) {
    return [];
  }

  const selected = candidates
    .filter((candidate) => candidate?.hasAuthoredNormal)
    .map((candidate) => {
      const base = linearRgb(candidate.baseLinearRgb);
      const sourceRadius = Math.max(finiteNumber(candidate.surfaceRadius ?? candidate.radius), 0);
      const sourceOpacity = clamp(finiteNumber(candidate.opacity, 1), 0, 1);
      const sourceIrradiance = evaluateDirectPointLight({
        intensity: light.intensity,
        lightColor: light.color,
        lightPosition: light.position,
        normal: candidate.normal,
        normalPolicy: DIRECT_LIGHT_NORMAL_POLICY.AUTHORED_ONE_SIDED,
        position: candidate.position,
        visibility: candidate.visibility,
      });
      const sourceRadiance = multiplyRgb(base, sourceIrradiance).map((value) => Math.max(value, 0));
      const surfaceArea = Math.PI * sourceRadius * sourceRadius;
      const surfaceWeight = surfaceArea * sourceOpacity;
      const score = surfaceArea * Math.max(linearLuminance(sourceRadiance), 0);
      return {
        id: String(candidate.stableId ?? candidate.id ?? ""),
        normal: vector3(candidate.normal),
        ordinal: finiteNumber(candidate.ordinal),
        position: vector3(candidate.position),
        radius: sourceRadius,
        score,
        sourceRadiance,
        surfaceWeight,
      };
    })
    .filter((candidate) => (
      Number.isFinite(candidate.score)
      && candidate.score > 0
      && candidate.surfaceWeight > 0
    ))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.id !== right.id) {
        return left.id < right.id ? -1 : 1;
      }
      return left.ordinal - right.ordinal;
    })
    .slice(0, safeLimit);
  const totalSurfaceWeight = selected.reduce(
    (sum, candidate) => sum + candidate.surfaceWeight,
    0,
  );
  if (!(totalSurfaceWeight > 0)) {
    return [];
  }
  return selected.map((candidate) => ({
    flux: candidate.sourceRadiance.map(
      (value) => value * safeGain * (candidate.surfaceWeight / totalSurfaceWeight),
    ),
    id: candidate.id,
    normal: candidate.normal,
    ordinal: candidate.ordinal,
    position: candidate.position,
    radius: candidate.radius,
    score: candidate.score,
  }));
}

/**
 * Computes the receiver irradiance from the selected VPLs. This deliberately
 * has no receiver-path visibility term; the UI calls it a leaky preview rather
 * than global illumination. Imported covariance normals can receive this term
 * elsewhere in the viewer, but never enter selectOneBounceVpls as emitters.
 */
export function evaluateOneBounceVplIrradiance({
  enabled = false,
  nearRadiusMultiplier = ONE_BOUNCE_VPL_NEAR_RADIUS_MULTIPLIER,
  normal,
  position,
  vpls = [],
} = {}) {
  const receiverNormal = vector3(normal);
  const receiverPosition = vector3(position);
  const receiverNormalLengthSq = dot(receiverNormal, receiverNormal);
  if (!enabled || !(receiverNormalLengthSq > Number.EPSILON)) {
    return [0, 0, 0];
  }
  const nearMultiplier = Math.max(
    finiteNumber(nearRadiusMultiplier, ONE_BOUNCE_VPL_NEAR_RADIUS_MULTIPLIER),
    0,
  );
  const irradiance = [0, 0, 0];
  vpls.forEach((vpl) => {
    const emitterPosition = vector3(vpl?.position);
    const emitterNormal = vector3(vpl?.normal);
    const flux = linearRgb(vpl?.flux);
    const toEmitter = subtractVector3(emitterPosition, receiverPosition);
    const distanceSq = dot(toEmitter, toEmitter);
    const emitterNormalLengthSq = dot(emitterNormal, emitterNormal);
    const nearDistance = Math.max(finiteNumber(vpl?.radius), 0) * nearMultiplier;
    if (
      !(distanceSq > Math.max(nearDistance * nearDistance, Number.EPSILON))
      || !(emitterNormalLengthSq > Number.EPSILON)
      || !flux.some((value) => value > 0)
    ) {
      return;
    }
    const distance = Math.sqrt(distanceSq);
    const receiverFacing = Math.max(
      dot(receiverNormal, toEmitter) / Math.sqrt(receiverNormalLengthSq * distanceSq),
      0,
    );
    const emitterFacing = Math.max(
      -dot(emitterNormal, toEmitter) / Math.sqrt(emitterNormalLengthSq * distanceSq),
      0,
    );
    const strength = (receiverFacing * emitterFacing) / distanceSq;
    irradiance[0] += flux[0] * strength;
    irradiance[1] += flux[1] * strength;
    irradiance[2] += flux[2] * strength;
  });
  return irradiance.every(Number.isFinite) ? irradiance : [0, 0, 0];
}

export function applyOneBouncePreview({
  baseLinearRgb,
  enabled = false,
  normal,
  position,
  vpls = [],
} = {}) {
  const base = linearRgb(baseLinearRgb);
  const irradiance = evaluateOneBounceVplIrradiance({
    enabled,
    normal,
    position,
    vpls,
  });
  const increment = multiplyRgb(base, irradiance);
  return [
    base[0] + increment[0],
    base[1] + increment[1],
    base[2] + increment[2],
  ];
}
