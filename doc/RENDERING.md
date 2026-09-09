# Rendering and lighting

[Back to README](../README.md)

## Renderer backends

| Backend | Gaussian path | SH / color | Lighting and shadow boundary |
| --- | --- | --- | --- |
| Spark 2.1 (default) | Existing native Spark renderer | Source-dependent SH0–SH3 | Look-dev controls and selected-item animation remain active. Optional cached all-splat point-light occlusion supports static scenes; the shared static-baked SH0 below is also displayed. |
| PlayCanvas 2.22.0 | Public unified GSplat renderer; WebGPU preferred, WebGL2 compatibility | SH0, GPU-resident appearance | Exposure, point lights, cached occlusion and PCHIP tone curves run in Linear sRGB on GPU. Animation remains Spark only. |
| Three.js r186 | Official GaussianSplat + WebGPURenderer; GPU counting sort (official CPU sort on WebGL2 fallback) | SH0, GPU-resident appearance | Linear exposure, direct lights, visibility and curves run in a GPU pre-pass. Animation remains Spark only. |

Alternate backends consume only the copied snapshot. They never render through
Spark, and a failed backend activation leaves the currently active backend in
place with a visible status message. The previous canvas is retained until its
replacement is ready; the visible-only snapshot is captured after lazy vendor
loading so scene edits made during loading are not lost. PlayCanvas and Three.js are separate
classic-script bundles loaded only on first selection, so Spark startup does
not evaluate either vendor. The Three backend asserts
`THREE.REVISION === "186"`; selecting it still reports the expected
multiple-Three warning because Spark r180 and the comparison renderer coexist.
All three generated bundles are minified at build time; this changes delivery
and parse cost only, not renderer parameters or lighting math.

For imported splats whose normals are inferred from covariance, GPU appearance
updates with the camera. CPU-compatibility snapshots refresh after navigation
settles so face-forward lighting does not remain captured from an old side.

Three receives exact world-space Gaussian covariance, including non-uniform
scale, shear, and reflection. Covariance is packed once per snapshot or edited
item, then reused for GPU counting sort and official projection. The separate
static-bake transform restrictions below still apply.

The old custom Three GLSL projection and per-frame CPU attribute sort are removed.
Visible items are flattened into one world-space `GaussianSplat` for global
ordering. The official addon is pinned to npm `three@0.186.0`; its renderer,
opacity compensation, projection and sorting are used directly. A single
build-time guard avoids upstream `atan2(0,0)` for circular projections, which
otherwise disappeared on the tested GPU. `tools/build-three-r186.mjs` fails closed
if the upstream source no longer matches; no files in node_modules are patched.

`viewer-three-native.mjs` isolates revision-checked private storage access because
r186 has no public dynamic splat color/geometry hook. The GPU appearance pre-pass
writes the addon's native packed RGBA8 stream, while normals, curves and visibility
remain float32. WebGL2 uses full CPU appearance snapshots, never silent truncation.
The Three bundle follows the official example's isolated sRGB working/output
space for encoded splat compositing. Appearance is explicitly computed in Linear
sRGB and encoded once. Export remains independent, sRGB by default. RGBA8 native
color precision and the fixed 2-sigma support mean pixel-exact Spark parity is not
promised; SH1–SH3 are not yet forwarded by this viewer's snapshot contract.

## Renderer controls and transforms

**Renderer → Rendering settings** is collapsed on startup. It shows settings
for the active backend, with per-control descriptions, upstream default values,
and an official reference link. Changes apply immediately and survive backend
switches and scene replacements in the current page. Reloading the page or
**Reset defaults** restores the exposed defaults; reset affects only the active
backend. Input ranges are viewer guardrails, not limits promised by upstream.

Controls are ordered **Quality / Performance → Effects → Other**. Quality
starts with the shared viewer preset, explicit pixel ratio (0 = automatic),
frame-rate cap, and selected Spark item's SH degree. A pixel ratio of 2 costs
roughly four times the pixels of 1. Shared controls have their own reset button;
engine reset leaves them unchanged. Allocation-only and unsupported pipeline
options are listed with reasons under **Quality options unavailable here**;
the panel does not claim to expose every engine API.

- [Spark 2.1.0](https://sparkjs.dev/docs/spark-renderer/): Gaussian support,
  pixel radius, alpha cutoff, blur, falloff, focal adjustment, clipping, sorting,
  2DGS, depth of field, LoD budget, LoD scale, inflation and foveation cones.
  LoD controls require source LoD trees. A blank LoD budget restores the engine's
  platform-dependent automatic budget.
  The existing Quality preset also updates `maxStdDev`; Falloff is shared with
  the Splats tab.
- [PlayCanvas 2.22.0](https://api.playcanvas.com/engine/classes/GSplatParams.html):
  Work-buffer precision (compact/large), Gaussian antialiasing, radial sorting, pixel-size cutoff, forward alpha cutoff,
  and 2DGS. Flat snapshots do not use streamed LoD; additional WebGPU-specific
  controls are not yet exposed in this panel.
- [Three.js GaussianSplat](https://threejs.org/docs/pages/GaussianSplat.html):
  object sorting, material depth testing and wireframe. The official addon fixes
  Gaussian support at 2 sigma and antialiasing kernel variance at 0.3, so obsolete
  custom cutoff/alpha/blur controls are removed. Spark's r180 host stays isolated.

These are display settings, separate from the shared look-dev appearance baked
into exported PLY files. Additional Three.js output tone mapping is omitted to
preserve encoded splat compositing; shared exposure and tone curves remain active.

**Splats → Move / Rotate / Scale** enables the selected gizmo directly. A
transparent helper pass displays it above all three backends without routing
alternate splats through Spark. Scale handles apply uniform XYZ scaling, matching
the single Scale input and saved transform contract. Brush editing and alignment
point picking still require Spark.

## Color and PLY interchange

- Untagged imported splats are treated as **sRGB**. Built-in primitives and
  explicitly tagged legacy linear exports retain their Linear sRGB meaning.
- Exposure, lighting, LUTs, and tone curves use Linear sRGB. Spark decodes after
  source SH evaluation and encodes after grading; individual SH coefficients
  are not passed through a nonlinear transfer function. Alternate backends
  receive the same exposure/light/bounce/tone result as a linear SH0 appearance
  snapshot and encode once, with tone mapping disabled.
- Display and PLY export use the exact sRGB transfer function, not gamma 2.2.
  Native encoded-color Gaussian blending is retained for splat-viewer
  compatibility; coverage, filtering, and sorting can still differ by backend.
- Default **Export** writes sRGB SH0 appearance, including exposure, lighting,
  and grading, regardless of the active renderer.
  Reopening this file starts from baked colors: do not reapply the same lighting
  or grading. Match the external viewer's background, camera, and exposure.
- Active animation, diagnostic modes, view-dependent SH, nonstandard falloff,
  and opacity above 1 cannot currently be preserved by this SH0 exporter.
  Save explains the required reset instead of silently exporting another look.
  SH/falloff checkboxes record metadata only; they do not export SH1–SH3.

## Light types and occlusion

**Light → type → Add** creates Point, Directional, or rectangular Area lights.
All three renderers share the same Linear-sRGB shading and sRGB color export.
Point retains inverse-square falloff. Directional has no distance falloff;
its position moves only the helper. RX/RY/RZ are XYZ Euler degrees, with local
`-Z` as the direction of emission. Area additionally exposes width/height in
native scene units, not assumed meters. Its outline shows the actual rectangle.

Area is a one-sided diffuse-emitter approximation using four deterministic
midpoint samples. Each sample has its own receiver-facing factor, emitter-facing
factor, inverse-square attenuation and all-splat visibility; contributions are
summed, not averaged visibility multiplied by center lighting. Intensity is
total normalized source strength divided among samples, independent of size,
not calibrated luminance. Four samples can show discrete shadow lobes; this is
not an exact area integral or path-traced soft shadow.

Directional rays are parallel and span twice the scene BVH diagonal from each
receiver toward the source, not rays to an arbitrary distant point. They retain
same-item sigma bias but no segment-relative endpoint floor: an unrelated far
splat must not enlarge receiver bias. Geometry and direction key the cache;
moving the directional helper reuses visibility.

Static Bake and legacy shadow/bounce previews remain **point-light only** and
are disabled for visible Area/Directional lights. Normal color export supports
these new lights; it does not serialize editable light objects.
The models follow the [PBRT distant-light](https://www.pbr-book.org/4ed/Light_Sources/Distant_Lights)
and [area-light](https://pbr-book.org/4ed/Light_Sources/Area_Lights) conventions,
with the explicit low-sample and nonphysical captured-radiance limits above.

In any renderer, add a light and enable **Light → Occlusion**. Every visible
splat is included as both a receiver and a possible blocker; this is not the
legacy 32-proxy preview. WebGPU compute traverses a cached BVH and caches a scalar
transmission value for each splat/light pair. Renderers read these values by stable source index
and attenuates only the added direct light, leaving the original RGB/SH intact.

- Moving a light or splat, editing geometry/opacity, or changing visibility
  invalidates the cache immediately and schedules a refresh after input settles.
  Light-only edits retain geometry buffers and reuse unchanged lights. Geometry
  edits rebuild the BVH. Camera motion and light intensity/color changes reuse
  the applied cache without dispatching visibility work.
- **Update Shadows** retries explicitly. **Cancel Shadows** stops pending or
  running work. Until a fresh cache is ready, added light is unoccluded and the
  status explains whether work is queued, running, canceled, or unavailable.
- The opt-in path supports up to 8 shadow samples and 8,000,000 splat/sample
  pairs, subject to the GPU texture-size limit. Exceeding a limit rejects the
  whole update rather than sampling a subset or silently dropping blockers.
  Point and Directional consume one sample; Area consumes four (e.g. two Areas,
  or one Area plus four Point/Directional lights). No blockers are subsampled.
- Active animation/modifiers, paged or covariance-only splat storage, static
  Bake are not supported by this cache. Clear the
  animation/Bake to refresh it. As with static Bake, visible
  transforms must be rigid or uniformly scaled; shear/reflection are rejected.
- WebGPU is preferred wherever the browser exposes a usable device, including
  eligible local-file contexts. HTTPS or localhost is recommended. Missing GPU
  support or storage/range limits use an explicit **CPU fallback** with a reason;
  shader/validation failures are reported, not hidden behind fallback.
- The device, pipeline and immutable geometry buffers persist between updates.
  Bounded dispatches allow cancellation; stale or partial results are never
  published. All resources are released on page exit or geometry invalidation
  as appropriate. Device loss can be recovered by **Update Shadows**.
- BVH preparation still runs cooperatively on CPU. Numerically ambiguous hard
  endpoint/support cutoffs are marked on GPU and checked with the float64 CPU
  reference; the UI reports the number of CPU boundary checks. This avoids
  changing the optical model at discontinuous boundaries.
- Transmission is unitless (`NoColorSpace`). It is read back once per bounded
  batch and uploaded to the active renderer's texture. The compute device is
  not shared with PlayCanvas's or Three.js's display device. Spark still uses WebGL.
  The status duration includes setup,
  trace, transfer and atlas preparation, not final-frame GPU completion.

Run the small browser regression at `tests/webgpu-occlusion.html` via the local
server. It checks actual WGSL against the CPU reference, including a hard-cutoff
rounding regression, multiple lights/batches, cancellation and device recovery.
Implementation order and current evidence are in [TODO](TODO.md).

### GPU appearance and static Bake

Alternate backends retain original Linear sRGB and world-normal textures between
geometry edits. Ordinary exposure/light/tone edits upload only a 4 KiB parameter
row per item; they do not recapture or relight every splat on CPU. Visibility
textures update only when the cache or light mapping changes. PlayCanvas uses
the public work-buffer modifier and parameter invalidation APIs. Topology edits
recreate its backend asynchronously while keeping the old canvas until ready;
this avoids stale unified-sort buffers in the host-driven rendering loop.

Up to eight direct-light samples and 32 points per tone-curve channel use this GPU path.
Legacy sampled shadows and authored one-bounce preview use the complete CPU
compatibility appearance path, as do larger curve/light configurations; none are
silently truncated. Picking and export retain the CPU reference. Export remains
sRGB, never raw Linear-sRGB bytes. No new color-space conversion is introduced.

Static **All-splat direct** Bake uses GPU visibility and optical depth, then the
existing CPU linear-RGB assembly and reversible write transaction. Authored
one-bounce Bake remains the separate Worker path. Bake diagnostics distinguish
these execution paths. GPU appearance adds 64 bytes per receiver plus parameters;
device texture-size limits are checked rather than dropping receivers.

This is cached visibility, not a full-scene ray trace every frame or physical
global illumination. The optical-depth kernel approximates each Gaussian using
its largest scale as a spherical support radius. All blockers are considered,
but thin/anisotropic splats can produce broader shadows than their exact shape.
Imported radiance is not relit into albedo, and this feature does not add bounce.

## Static lighting

The production static-light path is separate from each live renderer, so one
bake result is shared by Spark, PlayCanvas, and Three.js:

- **All-splat direct** builds a deterministic packed BVH over every visible
  splat and evaluates Gaussian optical depth between the selected point light
  and every receiver. There is no 32-proxy cap in this path.
- Work runs in a module Worker with staged progress and cancellation. Under
  `file://`, or when a module Worker is unavailable, the same exact direct and
  authored-bounce kernels run through a cooperative main-thread fallback.
- The result replaces SH0 RGB reversibly. `Clear / Restore` restores the exact
  pre-bake RGB, and scene/light/transform changes mark or cancel stale work.
- Imported generic 3DGS RGB/SH is captured radiance, not diffuse albedo.
  **Preserve captured radiance** is therefore the default. The optional generic
  visibility modulation is explicitly nonphysical.
- **Direct + authored one bounce** is experimental and limited to built-in Cube
  and Macbeth splats carrying explicit diffuse-albedo, normal, and surface-area
  provenance. Generic splats may occlude both path legs, but never become
  bounce emitters or receivers. Sources are compressed into at most 96
  item/normal-coherent clusters and total source-to-receiver work is capped at
  192,000 paths.
- Static baking currently accepts rigid or uniformly scaled items. A visible
  non-uniformly scaled, sheared, or mirrored item is rejected rather than
  silently using an invalid Gaussian bound or flipped authored normal.

The two live controls labelled **Legacy sampled shadow (32 proxies)** and
**Legacy 6-VPL bounce preview** remain opt-in diagnostics only. They are disabled
by default and are not the production all-splat bake.

### Reference performance

Historical development measurements, not a current performance guarantee.

Pure Node reference measurements recorded on a deterministic sparse fixture
(LCG seed `0x20260811`; wide XYZ distribution; sigma `0.02..0.10`). These are
development benchmark results, not assertions run by `npm test`:

| Splats | Packed BVH nodes | Broad-phase candidates | Build + trace |
| ---: | ---: | ---: | ---: |
| 2,000 | 255 | 106,784 | 17.3 ms |
| 100,000 | 16,383 | 14,522,564 | 625.5 ms |
| 1,000,000 | 131,071 | 397,204,700 | 22.5 s |

The 1M run used about 163 MiB RSS and completed inside a 60-second guard. Dense,
heavily overlapping Gaussian scenes can cost more than this sparse reference.
The same 100k fixture completed in about 0.65 s in a Chrome module Worker after
switching cooperative yields from timer-clamped tasks to `MessageChannel`;
its SHA-256 output remained
`8d96721a61e9f9425a6ef88aced999a5cb99414f695698478bfde16b150319cc`.

## Additional constraints

- Lights affect splats only in Beauty mode; diagnostic modes remain unlit.
- The Three.js backend is pinned to official npm `three@0.186.0`, runtime `186`.
  Re-review the guarded native adapter and circular-projection fix on upgrades.
- Authored bounce grouping assumes the supported Cube axis normals and Macbeth
  `+Z` normal. Oblique authored materials require a tighter normal-coherence key
  before they can be added safely.
