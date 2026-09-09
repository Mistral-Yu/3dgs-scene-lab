# Third-Party Notices

This repository bundles third-party runtime code under `vendor/` and in the
generated `viewer*.bundle.js` files, plus the sample data identified below.
Keep these notices with redistributed copies, including static-site releases.

## Included third-party components

### three.js

- Files:
  - `vendor/three/three.module.js`
  - `vendor/three/three.core.js`
  - `vendor/three/examples/jsm/controls/OrbitControls.js`
  - `vendor/three/examples/jsm/controls/TransformControls.js`
  - `vendor/three/examples/jsm/postprocessing/Pass.js` (r180)
  - `viewer.bundle.js` (Three.js r180)
  - `viewer-vendor-three-r186.bundle.js` (official Three.js r186 / npm 0.186.0,
    with a guarded circular-splat projection fix in `tools/build-three-r186.mjs`)
- Upstream:
  - https://github.com/mrdoob/three.js
- License:
  - MIT

Copyright 2010-2025 Three.js Authors (r180).
Copyright © 2010-2026 three.js authors (r186).
The MIT license text below applies to both copies.

### Spark 2.1.0

- File:
  - `vendor/spark/spark.module.js`
  - `viewer.bundle.js`
- Upstream:
  - https://github.com/sparkjsdev/spark/releases/tag/v2.1.0
- Distribution: `@sparkjsdev/spark@2.1.0`, `dist/spark.module.js`, copied without modification.
- npm tarball integrity: `sha512-BRw+MuMzx0B3K8fDLQygt2OHEhYUV+41RX7btq9pZ3rCVrq42o57jW34VAIvC7JO/84DJh/1AutACV9ym6BfVg==`.
- License:
  - MIT

Copyright © 2025 WORLD LABS TECHNOLOGIES, INC.
The MIT license text below applies to this runtime.

### PlayCanvas 2.22.0

- File: `viewer-vendor-playcanvas.bundle.js`
- Upstream: https://github.com/playcanvas/engine/tree/v2.22.0
- License: MIT

Copyright (c) 2011-2026 PlayCanvas Ltd.
The MIT license text below applies to this runtime.

### MIT license text for the runtime components above

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

### Colour - Nuke ColorChecker reference values

- File: `primitives/primitive-library.js`, `MACBETH_LINEAR_SRGB` values only.
- Source: pixel values sampled from
  https://github.com/colour-science/colour-nuke/blob/master/colour_nuke/resources/images/ColorChecker2014/sRGB_ColorChecker2014.exr
- The original EXR image is not bundled. The chart geometry is generated locally.
- Upstream license: https://github.com/colour-science/colour-nuke/blob/master/LICENSE

Copyright (C) 2013-2021, Colour Developers
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

 * Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
 * Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
 * Neither the name of the Colour Developers nor the
   names of its contributors may be used to endorse or promote products
   derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL COLOUR DEVELOPERS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### Stanford 3D Scanning Repository data

- File: `primitives/mesh-primitive-data.js` (encoded vertices and indices).
- Included derived models:
  - Bunny
  - dragon
- Upstream:
  - https://graphics.stanford.edu/data/3Dscanrep/
- License / usage note:
  - Source and acknowledgement: Stanford University Computer Graphics Laboratory.
    Bunny uses `bun_zipper_res2.ply`; dragon uses `dragon_vrip_res3.ply`.
    The meshes are converted into face-aligned Gaussian splats at runtime.
  - These models are NOT covered by this project's MIT license. Stanford permits
    research use and free redistribution with source acknowledgement. Commercial
    use or inclusion in a product for sale requires Stanford's permission, subject
    to the scholarly-publication exception described on the source page.
  - Follow Stanford's model-use guidance: dragon is culturally significant; do
    not animate, morph, break, explode, or melt it. Use a procedural primitive or
    Bunny for deformation/animation experiments instead. Tool availability is
    not permission to use third-party models outside their terms.

## Project license

The project's own source files are licensed under the repository `LICENSE` file.
Third-party code and derived sample data retain the terms identified above;
the MIT license does not relicense those assets or waive their restrictions.
