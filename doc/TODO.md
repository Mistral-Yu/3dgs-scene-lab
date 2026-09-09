# WebGPU lighting work

GPU-first processing is the direction; Spark currently displays through WebGL.
Do not describe a compute migration as a complete WebGPU renderer migration.

## Official Three.js migration — 2026-09-09

- [x] Verify official r186 release and pin npm `three@0.186.0` without lifecycle scripts.
- [x] Replace custom GLSL/CPU sort with official GaussianSplat / WebGPURenderer.
- [x] Retain GPU appearance via a version-guarded native color-buffer pre-pass;
  remove obsolete custom renderer controls, keep shared grading and sRGB export.
- [x] Reproduce and guard upstream circular-projection `atan2(0,0)` disappearance.
- [x] Actual GPU: 64 mixed-light/curve/visibility fixtures × 4 update passes,
  1,024 RGBA comparisons, maximum byte error 0; final neutral sRGB pixel 118.
- [x] Final UI: Macbeth/Sphere (1,152 splats), colored Area + tone curve +
  four-sample occlusion, transforms and Spark/PlayCanvas/Three switching.
  Fixed grid subdivision state on reactivation; no application/GPU errors.
- [x] Independent source review and 267 Node regressions passed; all bundles,
  syntax/HTML and whitespace checks passed. Release retained CPU arrays and
  deduplicate disposal of WebGL PBO textures, including failed-layout cleanup.

Upstream support is official; the dynamic-buffer adapter and one-line projection
guard remain viewer-maintained, pinned integration points. No large-scene test.
Browser acceptance used localhost WebGPU; native WebGL2 rendering and external
SuperSplat round-trip were not rerun. Browser policy blocked file:// validation.

## Area / Directional extension — 2026-09-08

- [x] Define parallel-ray and four-sample rectangle contracts, preserving point lighting.
- [x] Extend Spark, PlayCanvas WGSL/GLSL, Three GLSL and CPU color export together.
- [x] Extend WebGPU and CPU visibility, stable sample IDs, direction-aware reuse.
- [x] Add compact type-specific controls; guard point-only Bake/legacy previews.
- [x] Complete small-scene browser comparison, final regression and independent review.

New types use the existing eight-sample visibility budget (Area consumes four).
No large-scene test, physical GI claim, or static Area/Directional Bake support.

Verified: 1,152-splat Macbeth + Sphere scene, directional helper-position
invariance and direction reversal; narrow/wide rectangle, backface-off,
occlusion on/off, color edits, Spark / PlayCanvas WebGPU / Three appearance.
Nine-sample rejection and recovery passed. Alternate renderer light outlines
and arrows remain visible; helpers coincident with the camera are hidden without
disabling emission. No horizontal overflow in the 242px inspector.

Actual GPU: three additional mixed/parallel-ray fixtures, maximum transmission
error `2.3283064365386963e-9`; the original eight fixtures remain within `1e-4`.
The 64 appearance cases now mix Point, Directional and Area samples; maximum
Linear-sRGB error `1.0975358089027054e-7`. CPU export + independent PLY decode
cover new types, individual visibility and grading in sRGB on every backend.
This is not a fresh external SuperSplat round-trip.

Final Node regression: 259/259; bundle builds, syntax, HTML and whitespace checks
passed. Independent read-only review found an alternate-backend legacy-bounce
refresh omission; fixed, regression-tested and re-reviewed. Real PlayCanvas and
Three toggles now switch to CPU compatibility and return to GPU immediately.
The initial WGSL reserved-keyword compile failure was fixed and retested on GPU.

## Implementation order

- [x] 1. Implement a WebGPU compute BVH visibility kernel for every eligible splat.
  Preserve the existing max-sigma Gaussian optical-depth model, receiver identity,
  endpoint bias and all-or-nothing publication. Never silently sample blockers.
- [x] 2. Retain the device, pipeline and geometry buffers; cache visibility per
  light. Reuse unchanged geometry and lights without tracing again. Cancel stale
  jobs and report an explicit CPU compatibility fallback when WebGPU is absent.
- [x] 3. Integrate compute with live shadows and invalidate geometry separately
  from light movement. Keep linear-light RGB and sRGB export unchanged.
- [x] 4. Validate CPU/GPU agreement on small deterministic fixtures, cache reuse,
  cancellation, resource cleanup, and the real viewer. Run existing regressions.
  No large-scene stress test while another session is rendering.
- [x] 5. Extend the validated GPU visibility path to static direct Bake, retaining
  reversible RGB writes and numerical diagnostics. Authored one-bounce remains a
  separate migration because it also traces source-to-receiver paths.
- [x] 6. Migrate alternate-renderer appearance evaluation to GPU-resident streams
  and enable PlayCanvas WebGPU after lifecycle and visual parity tests. Measure
  end-to-end latency including transfers, not only dispatch time.
- [x] 7. Profile the remaining CPU BVH preparation and GPU-to-WebGL transfer.
  Choose GPU BVH construction or a shared GPU rendering path from evidence.
  Deep shadow maps / proxy meshes need separate quality validation before adoption.
- [x] 8. Evaluate spatially grouped dispatch before committing to a voxel grid.
  Trial removed: no useful improvement in the bounded comparison below.

## Acceptance contract

Visibility is a unitless transmission scalar, not an sRGB color. The first kernel
retains spherical max-sigma support; it is not exact anisotropic volumetric transport
or new indirect illumination. Compare float32 GPU values with the existing CPU
reference with an explicit tolerance and retain the maximum observed error.
Report unsupported devices and limits rather than silently dropping splats.
Hard endpoint/support cutoffs are discontinuous: GPU-marked ambiguous receivers
use sparse CPU float64 reference checks, counted explicitly in diagnostics. This
preserves the existing model instead of silently widening the shadow support.

## Verified checkpoint — 2026-09-08

- Actual in-app browser: 8 deterministic fixtures, maximum absolute transmission
  error `5.960464477539062e-7` against the CPU reference (tolerance `1e-4`).
- Largest fixture: 2,051 splats × 4 lights, multiple dispatches; 71/8,204 pairs
  required CPU boundary checks. All four lights reused on reorder; one moved
  light reused the other three. Queued/in-flight cancellation, geometry release
  and device recreation passed without browser error/warning logs.
- Illustrative same-scheduler run: CPU reference 157.6 ms, GPU path 35.5 ms,
  cached result assembly 0.2 ms. These include preparation/readback but not scene
  rendering; small fixtures can favor CPU. Not a large-scene/FPS benchmark.
- Initial viewer checkpoint: 720-splat Sphere, two lights, movement, opacity, light color /
  intensity, and Spark → PlayCanvas → Spark transitions checked. Light movement
  reused the other light; geometry changes cleared both. Alternate backends
  initially required Spark; the completed path now supports all three backends.
- Static GPU Bake: both captured-radiance policies matched CPU RGB and optical
  depth exactly in the small fixture. Viewer Bake processed 720 splats in 20 ms,
  including reversible application; Clear / Restore succeeded. No indirect-light
  claim: authored one-bounce remains the existing Worker compatibility path.
- GPU appearance: 64 actual-WGSL cases, 0–8 colored lights, exposure, transmission,
  authored/imported normals and PCHIP curves. Maximum absolute Linear-sRGB error
  `1.0516569604046566e-7` against the CPU reference (tolerance `1e-5`).
- Actual PlayCanvas WebGPU and Three.js WebGL: matching darkened tone curve,
  restore, light edits and all-splat cache. PlayCanvas intensity 0→20 visibly
  changed radiance; adding, moving and removing a second Sphere passed after
  fixing topology replacement. Shader declaration and parameter invalidation
  bugs found by visual testing were fixed. Only the expected two-Three-version
  warning was observed; no final application/GPU errors.
- Independent test review reproduced and verified fixes for device-loss races
  and float32 relative-coordinate collapse. Boundary cases use explicit fallback.
- Final automated regression: 254/254 Node tests, all three bundle builds,
  JavaScript syntax, HTML validation and `git diff --check` passed. The retained
  browser suite passed again after removing the dispatch-order experiment.
- PlayCanvas legacy-preview switching correctly selected CPU compatibility and
  returned to GPU appearance without application errors.

## Profiling decision and rejected experiment

Small in-app comparison, 2,051 receivers × 4 lights: CPU reference 141.6 ms;
WebGPU 36.7 ms including cooperative preparation/readback; cache reuse 0.2 ms.
The GPU path measured BVH 4.2 ms, packing/upload 1.6 ms, trace/readback plus sparse
CPU precision repair 30.7 ms, result assembly 0.1 ms; readback was 32,816 bytes.
This does not include final-frame GPU completion and is not a large-scene/FPS
claim. CPU BVH construction is not the dominant measured stage, so retain it and
prefer cached GPU appearance over a new GPU BVH builder in this iteration.

An adaptive spatial-order dispatch trial reused the BVH's leaf order to group
nearby receivers, without changing blockers or the optical model. Alternating
order, one warmup and three measured runs: randomized 2,051-receiver median
5.2 ms sequential vs 6.8 ms spatial; 65-receiver median 0.5 ms vs 0.5 ms.
Transmission was identical. The implementation and trial switch were removed.
This was **not** a fixed voxel-grid implementation or a claim that all grids are
slower. A future grid needs evidence on representative large scenes and careful
deduplication of splats that overlap cells; no heavy test was authorized now.

Research basis: [PBRT BVH](https://www.pbr-book.org/4ed/Primitives_and_Intersection_Acceleration/Bounding_Volume_Hierarchies)
describes subtree rejection and robustness; [PBRT acceleration chapter](https://pbrt.org/chapters/pbrt-2ed-chap4.pdf)
discusses duplicated primitive tests across grid voxels. Keep all blockers and
the current CPU/GPU equality gate for any future accelerator.

## Deliberate boundaries

- Spark display remains WebGL. Three and PlayCanvas prefer WebGPU with WebGL2
  compatibility. Visibility still crosses a readback/upload boundary; devices
  are not shared. Ordinary appearance edits no longer perform per-splat CPU RGB
  evaluation; geometry capture, BVH build, picking/export and Bake RGB assembly
  still use CPU. This is GPU-first, not an entirely GPU-only application.
- GPU appearance supports eight lights and 32 curve points/channel; legacy
  shadow/bounce previews or larger configurations use the full CPU reference,
  never truncation. Added appearance storage is 64 bytes per receiver.
- Large-scene performance/VRAM, all browsers/devices, and a new external-viewer
  export round-trip were not retested. The sRGB export contract is unchanged.
