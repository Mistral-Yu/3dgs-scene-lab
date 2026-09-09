# 3DGS Scene Lab

A local-first web workspace for viewing, aligning, brush editing, lighting, and
animating Gaussian splat scenes.

[Open demo](https://mistral-yu.github.io/3dgs-scene-lab/)

## Use

Open the demo or `index.html`, then add local `.ply`, `.spz`, `.splat`, or
`.ksplat` files with **Add File** or drag and drop. Built-in samples are available
for quick experiments without downloading a dataset.

## Features

- Spark, PlayCanvas, and official Three.js r186 GaussianSplat rendering backends.
- Scene transforms, alignment, brush editing, and splat export.
- Linear-sRGB grading, point/area/directional lights, cached occlusion, and point-light baking.
- Camera controls and a collapsible animation timeline.

Spark provides the full editing and look-development toolset. PlayCanvas and
Three.js display SH0 appearance snapshots with exposure, lights, occlusion,
bounce preview, and grading. Animation remains Spark-only. OBJ support is planned.

## Develop

```sh
npm ci
npm run build
npm run dev
```

Open `http://localhost:4173`. Run `npm run check` for tests, builds, and syntax/HTML
validation. On Windows, `npm run open` also launches the local HTML directly.

## Rendering notes

WebGPU-first occlusion considers all visible splats within documented limits and caches
visibility for static scenes. It is not per-frame ray tracing or full global
illumination. Imported splat colors are captured radiance, not diffuse albedo.

See [Rendering and lighting](doc/RENDERING.md) for backend differences,
supported transforms, baking, and limitations.

## License

Application code: [MIT](LICENSE). Bundled Stanford Bunny/dragon data has separate
research-use and redistribution terms; commercial use requires permission.
See [Third-party notices](THIRD_PARTY_NOTICES.md) for sample-data restrictions
and dependency licenses.
