# Third-party notices — `@displayxr/inline3d`

`@displayxr/inline3d` is Apache-2.0 (see `LICENSE`). It bundles no third-party code, but parts of
it are adapted from, or run on, the MIT-licensed projects below. Their notices follow.

| Project | Version | How it is used |
|---|---|---|
| [PlayCanvas engine](https://github.com/playcanvas/engine) | 2.22.3 | Optional peer (`playcanvas`): the default splat backend and the `./model` backend. Shader code in this package is **adapted** from it: the non-square-pixel footprint rewrite of `src/scene/shader-lib/glsl/chunks/gsplat/vert/gsplatCorner.js` (`js/inline3d-splat-playcanvas.js`), the quad-extent cap in `gsplatCommon.js` (`js/inline3d-splat-perf.js`), and the dissolve effect and its hash/noise/fbm helpers from `scripts/esm/gsplat/shader-effect-dissolve.mjs` (`js/inline3d-splat-effects.js`). Each adapted site carries a provenance comment. |
| [three.js](https://github.com/mrdoob/three.js) | ≥ 0.150 | Optional peer (`three`): the `./three` helpers, the Spark splat path, `./model`'s `engine: 'three'`. The PlayCanvas backend's `environment: 'room'` is **adapted** from `examples/jsm/environments/RoomEnvironment.js` (its scene numbers, re-rendered by ray casting in `js/inline3d-model-playcanvas.js`, `ROOM_ENVIRONMENT`). |
| [Spark](https://github.com/sparkjsdev/spark) | ≥ 2.0 | Optional peer (`@sparkjsdev/spark`): the Spark splat backend. |

## PlayCanvas engine — MIT

Copyright (c) 2011-2026 PlayCanvas Ltd.

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

## three.js — MIT

Copyright © 2010-2026 three.js authors

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

## Spark — MIT

Copyright © 2025 WORLD LABS TECHNOLOGIES, INC.

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

## Sample assets (repo samples only, not in the npm package)

The pages under `samples/` show these assets. None is in the published `@displayxr/inline3d`
package.

| Asset | Used by | Source | Credit and licence |
|---|---|---|---|
| Damaged Helmet (`DamagedHelmet.glb`) | `samples/model/` (tiles A and B), loaded at run time, not vendored | [KhronosGroup/glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/c6a6bd13ab2b3c685c7903d03561b8a9392f38b8/Models/DamagedHelmet) at commit `c6a6bd13ab2b3c685c7903d03561b8a9392f38b8`, via jsDelivr, unmodified | © 2018 ctxwing (rebuild and conversion to glTF 2.0), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode). Earlier version of the model ("Battle Damaged Sci-fi Helmet") © 2016 theblueturtle_, [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/legalcode). As stated in the asset's `README.md` and `LICENSE.md`. |
| Duck, Draco variant (`samples/model/assets/glTF-Draco/`) | `samples/model/` (tile C) | Khronos glTF-Sample-Assets | © Sony, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). |
| Butterfly splat (`samples/splat/assets/butterfly.sog`) | `samples/splat/`, `samples/model/` (tile B) | [Spark](https://sparkjs.dev/) `assets/splats/butterfly.spz`, converted to SOG with PlayCanvas splat-transform (177,132 gaussians, 3 SH bands kept) | Butterfly splat © World Labs (from Spark, sparkjs.dev), used with permission; converted to SOG. |
| Draco decoder (`vendor/draco/`) | `samples/model/` | three.js `examples/jsm/libs/draco/` | © The Draco Authors, Apache-2.0. |
