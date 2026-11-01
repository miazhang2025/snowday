# Snow Day: Technical Writeup

*A real-time, interactive snow simulation built on Three.js's WebGPU renderer and TSL (Three.js Shading Language).*

Snow Day is a browser toy. You walk around a winter valley about 400 m across, push snow with your hand, leave handprints, and press snowmen, towers and castle walls out of molds. Everything else in the scene runs live on the GPU: snowfall, accumulation, wind crust, self-shadowing, subsurface scattering and the ice-crystal glints. There is no build step. The page is plain ES modules plus an import map pointing at `three@0.185.1` on jsDelivr.

This document covers the whole system: architecture, the simulation, the shading model, the interaction and sculpting systems, the render pipeline, the asset pipeline, deployment, performance, and the debugging history behind the less obvious decisions.

---

## Contents

1. [At a glance](#1-at-a-glance)
2. [Runtime and stack](#2-runtime-and-stack)
3. [Repository layout](#3-repository-layout)
4. [Boot sequence](#4-boot-sequence)
5. [The frame](#5-the-frame)
6. [Configuration model](#6-configuration-model)
7. [Terrain](#7-terrain)
8. [The snowfield clipmap](#8-the-snowfield-clipmap)
9. [Snow shading](#9-snow-shading)
10. [Interaction: the hand](#10-interaction-the-hand)
11. [Molds and snow sculptures](#11-molds-and-snow-sculptures)
12. [Falling snow and spray](#12-falling-snow-and-spray)
13. [Props: batching, LOD and placement](#13-props-batching-lod-and-placement)
14. [Sky, environment lighting and shadows](#14-sky-environment-lighting-and-shadows)
15. [Aerial perspective](#15-aerial-perspective)
16. [Post-processing](#16-post-processing)
17. [UI, camera and product shell](#17-ui-camera-and-product-shell)
18. [Asset pipeline](#18-asset-pipeline)
19. [Deployment](#19-deployment)
20. [Performance](#20-performance)
21. [Debugging case studies](#21-debugging-case-studies)
22. [Known limitations](#22-known-limitations)
23. [Extension points](#23-extension-points)

---

## 1. At a glance

| | |
|---|---|
| Renderer | `THREE.WebGPURenderer`, node materials written in TSL |
| Snow simulation | 3-level camera-following clipmap, 448² cells per level, 5.8 cm → 93 cm cells, about 416 m simulated |
| Far field | Analytic "skirt" out to 1300 m (terrain plus equilibrium snow depth, no simulation) |
| Terrain | 1024² heightmap over 1024 m, generated on the CPU, shared bit-for-bit with the GPU |
| Interactive area | Innermost level (L0), 26 m window, follows the camera |
| Persistence | 2048² deformation stash at 12.5 cm per cell, ±128 m around the player |
| Sculptures | CPU signed-distance-field voxel grids meshed with Surface Nets, 9 mold shapes |
| Particles | Up to 90,000 falling flakes and 12,288 spray particles, simulated in compute |
| Props | About 1,950 glTF instances in `BatchedMesh`, 5 LODs, dithered crossfades |
| Shadows | 4-cascade CSM (2048² each) out to 260 m, plus ray-marched heightfield self-shadowing |
| Post | Pre-pass (depth/normal/velocity), GTAO, TRAA (FXAA fallback), god rays, bloom, lens vignette and corner softening |
| Code size | About 8,000 lines of JS across 20 modules, no dependencies other than three.js |
| Cold load | About 18.5 MB, almost all of it textures inside the five `.opt.glb` props |

---

## 2. Runtime and stack

- **three.js 0.185.1**, loaded via import map from jsDelivr (`three/webgpu`, `three/tsl`, `three/addons/`).
- **No bundler, no npm dependencies.** `package.json` only defines `npm run dev`, which runs `npx serve . -l 8123`.
- **Browser support:** Chrome/Edge 113+ or Safari 18+. Firefox needs `dom.webgpu.enabled`. WebGPU needs a secure context: `localhost` counts, a LAN IP does not.
- **Fonts:** Cormorant SC and DM Mono from Google Fonts.
- **Draco:** the decoder comes from the same three.js version on jsDelivr.

The project targets the WebGPU **spec-guaranteed limits** rather than whatever the adapter offers. The clearest example is the 8-storage-buffers-per-stage ceiling, which shaped one of the compute passes (see §8.6).

---

## 3. Repository layout

```
index.html            Import map, all DOM (HUD, panel, landing, photo dialog, tour, boot screen), all CSS
src/main.js           Boot, device gating, main loop, walking, enter fly-in, screenshot compositing
src/config.js         Constants, user params, every TSL uniform, time-of-day keyframes, refresh()
src/terrain.js        Procedural heightmap (CPU) + identical CPU/GPU bilinear sampler
src/snowfield.js      Clipmap levels, 7 compute passes, deformation stash, skirt, snow material, readback
src/sculpt.js         SDF voxel sculptures, Surface Nets mesher, merging, brushes, sculpture material
src/molds.js          9 mold SDFs, footprint atlas for the GPU base pad
src/interaction.js    Mouse → hand/mold: ray marching, gestures, stamping, spray emission
src/snowfall.js       Falling flakes and hand-thrown spray (compute + instanced sprites)
src/batch.js          BatchedMesh props, two LOD simplifiers, per-frame LOD and crossfade
src/models.js         glTF loading, "snowy" material conversion, dithered fade mask
src/scenery.js        Procedural fence (and legacy procedural pines/rocks, now off)
src/sky.js            Sky dome, analytic aerial perspective, PMREM/HDRI environment, CSM sun
src/postfx.js         Render pipeline: pre-pass, GTAO, TRAA/FXAA, god rays, bloom, lens
src/ground.js         Exposed-soil PBR material under the snow
src/ui.js             Control panel, shortcuts, tool buttons, language switch
src/i18n.js           English/Chinese dictionary and switching
src/landing.js        Landing overlay, title tilt and burst effects, "too slow" gate UI
src/tour.js           Four-step in-world onboarding
src/photo.js          Photo preview dialog: save, share
src/gate.js           Device checks and FPS measurement
tools/optimize-glb.py Per-slot texture downsizing and repacking for 8K glTF assets
tools/prep-ground.py  Packs soil textures into albedo + (normal.xy, roughness)
tools/shrink-hdri.py  Energy-preserving box downsample of the 4K HDRI to 1K
vercel.json           One-year immutable cache on /assets/*
```

---

## 4. Boot sequence

`main.js:start()` runs the following in order.

1. **`applyStatic()`** fills in localized text so the boot screen is readable before anything else loads.
2. **Gate 1, static device check** (`gate.js:checkDevice`):
   - Phones and tablets are blocked outright. This includes iPads that report a desktop Safari UA, detected via `maxTouchPoints`, and any device without `(any-pointer: fine)`. The camera needs a right mouse button and a scroll wheel.
   - No `navigator.gpu`, or no adapter, shows the WebGPU help text.
   - Software or fallback adapters (SwiftShader, llvmpipe, WARP…), adapters below the limits the scene actually uses (8 storage buffers per stage, 256-invocation workgroups, ≥64 MB storage bindings), fewer than 4 CPU threads, or less than 4 GB RAM are rated "weak". The user sees why and gets a **Try anyway** button. That choice is saved in `localStorage` (`snow.gate.override`).
3. **`init()`** sets up the scene:
   - `uploadTerrain()` runs first, because every later system asks "how high is this point?".
   - Renderer: `antialias: false`, `trackTimestamp: true`, ACES filmic tone mapping at exposure 0.90, `PCFSoftShadowMap`. Pixel ratio is capped at 1.0, 1.5 or 2.0 depending on the quality tier.
   - Sky dome, lights (CSM), procedural fence, snowfield, snowfall.
   - `OrbitControls`. Left button is reserved for the hand, right rotates, middle pans, wheel zooms. Polar angle is capped just above the horizon.
   - **One warm-up frame** (refresh, step, light, render) so the CSM cascades allocate their shadow maps. Then `bindGodrayShadow()`, and only after that `createPostFX()` (see §21.2 for why the order matters).
   - Interaction and UI are created, then the environment map is baked.
   - Async loads are queued: the HDRI and five prop GLBs. Any of them can fail without breaking the scene.
   - Flake and spray buffers are initialized, and the field starts **already full of snow** (`fillSnow(params.depth)`). An earlier version started bare, and the landing page opened onto dark soil.
4. **`placeLandingCamera()`** places the landing shot relative to the sun. The view direction is 50° off "back to the sun", on whichever side is closer to the original composition. That gives side light with long shadows: not squinting into the sun, and not flat front light.
5. **`prepare()`** waits until everything that would otherwise pop in has arrived. The progress bar follows along:
   - 0–45%: assets (HDRI and GLBs) via `Promise.allSettled`, then landing images and fonts decoded.
   - 50–100%: **40 warm-up frames.** Shader and pipeline compilation happens here, on first draw of each material. That is several seconds on a first visit, since Windows also translates WGSL to HLSL/DXIL. The frames also cover the post-HDRI environment re-bake and filling TRAA's history. `renderer.compileAsync` measured slower because it compiles every variant of every material, so it isn't used.
6. **Reveal.** The boot screen fades out while the canvas and landing overlay animate from a 24 px blur to sharp, so nothing appears piece by piece.
7. **Gate 2, measured FPS** (`runProbe`). The landing page is the real scene running, so its frame rate is the most honest benchmark available:
   - Wait for loads plus 1.5 s, then measure the **median** frame interval over 2 s.
   - Measurements are discarded and retried (up to 3 times) if the tab is hidden or fewer than 10 frames arrive. That means the main thread was blocked, not that the GPU is slow.
   - Below 30 FPS: drop to low quality and measure again. Still below 30: swap the ENTER button for an explanation plus **Enter anyway**.
8. **Enter.** Auto-rotation stops, the overlay fades, the camera flies in (§17.3), and first-time visitors get the tour once the fly-in lands.

`watchDeviceLoss()` listens on `device.lost` and shows a reload message for anything other than an intentional `destroyed`.

---

## 5. The frame

`main.js:animate()` runs the following steps every frame. The order matters.

```
timer → dt (clamped to 1/24 s), elapsed, per-frame seed
walk(dt)                     WASD/QE with exponential velocity smoothing
stepFly(dt)                  enter fly-in (yields if the user grabs the camera)
controls.update()
updateClipmap(target)        slide all level windows + stash window; skirt center
U.meanDepth / snowProgress   CPU estimate of how much snow has fallen
refreshSnow                  per level, coarse → fine: refill dirty cells
interaction.update(dt)       field readback poll, mold stamps, sculpt animation and remesh,
                             hand raycast, computeDeform / computeSprayEmit as needed
stashSnow                    stash refresh (only if window moved) + stash write from L0
stepSnow                     per level, coarse → fine: relax (A→B), accumulate (B→A)
lightSnow                    per level, coarse → fine: sun visibility, sky occlusion, cavity
props[i].update(camera)      LOD / cull / crossfade, a quarter of instances per frame
computeFlakeUpdate           falling snow
computeSprayUpdate           hand spray
(photo mode: hide cursor ring, mold preview and brush ball)
maybeBakeEnv()               PMREM re-bake, only if sky inputs changed, max 10 Hz
postfx.render()
(photo mode: restore; on the last settle frame, composite and save)
stats every 0.5 s            fps, GPU render/compute timestamps, flake count, grid, props
```

Coarse levels run before fine levels because the fine levels read the coarsest level's light buffer (§8.7).

---

## 6. Configuration model

`config.js` separates three things:

- **`params`**: a plain JS object that the UI reads and writes. Examples: intensity, wind, depth, softness, crust, SSS, hand size, mold size and firmness, time of day, overcast, haze, bloom, quality, effect toggles.
- **`U`**: every TSL `uniform()` that shaders read.
- **`refresh()`**: derives uniforms from params. Most of the physical tuning lives here. For example:
  - Softness lowers the angle of repose (`lerp(1.35, 0.42)`) and raises slump and self-smoothing rates.
  - Crust rate scales with wind speed.
  - The active flake count is `FLAKES × (0.05 + 0.95·intensity) × {0.4, 0.75, 1.0}` by quality tier.
  - Overcast desaturates and dims the sun, flattens the sky toward gray-blue, and suppresses sparkle and crystals.
  - `packRepose = 1.5 + 20·moldFirm` controls how steep packed snow can stand.

### Time of day

There are nine sky keyframes spanning 04:00 to 04:00 the next day. Each holds sun elevation and azimuth, sun color and intensity, zenith/horizon/fog colors, and ambient level. They are interpolated with smoothstep in sRGB space. Sun direction comes from elevation and azimuth. The default `timeOfDay = 0.76` is a low afternoon sun, chosen for the longest shadows.

`refresh()` builds a signature string from the inputs that affect the environment map (time, overcast, HDRI mix/tint/rotation/follow). The PMREM is re-baked only when that signature changes, so the steady-state cost is zero.

### Grid constants

```
GRID = 448, LEVELS = 3, LOD = 4
CELL0 = 26 / 448 ≈ 0.058 m            L0 span 26 m
cellOf(k) = CELL0 · 4^k               L1 0.232 m / 104 m, L2 0.929 m / 416 m
SNAP = CELL0 · 4^(LEVELS-1) ≈ 0.93 m  shared window alignment step
HOLE_LO/HI                            ring hole in L1/L2 = inner level's footprint, 0.75-cell overlap
BUILD_CEIL = 5 m                      height ceiling (tallest mold × max scale + margin)
```

---

## 7. Terrain

`terrain.js` builds one 1024² heightmap covering 1024 m (about 1 m per texel) on the CPU at startup.

**Shape.** The terrain is a sum of four value-noise fBm terms:

- broad undulation (shortest wavelength ≈ 58 m)
- ridged ranges masked to the northwest, giving a skyline (≈ 75 m)
- mid-scale bumps (≈ 15 m)
- fine bumps (≈ 11 m)

The whole sum is multiplied by `open = smoothstep(11, 105, r)`, so the center flattens into a shallow bowl around the play area with no cone tip. A Chebyshev-distance rim fade brings the edges back to flat, so clamped out-of-range samples don't leave an extruded silhouette on the horizon. **Every term's finest octave stays above 10 m.** The coarsest clipmap cell is 0.93 m, so anything shorter than about 8 m would alias into a cross-hatch on L2. Sub-8 m relief is the snow layer's job.

**Storage.** Each texel is a `vec4`: height, ∂h/∂x, ∂h/∂z, unused. Gradients are central differences computed on the CPU. The shader only interpolates and never differentiates. That costs 16 bytes per texel (16.8 MB) instead of 4, and it fixes a real artifact (§21.1).

**One sampler, two languages.** `terrainSample(xz)` (TSL, reads a storage buffer) and `terrainAt(x, z)` (JS, reads the same `Float32Array`) use identical **bilinear** weights. The GPU draws and the CPU places props, ray-picks the hand and keeps the camera above ground, and they agree to the bit. That was verified by reading GPU samples back and diffing them against the CPU: 12 of 12 points matched to 0.000.

---

## 8. The snowfield clipmap

### 8.1 Why a clipmap

The original field was one fixed 448² grid over 26 m. Covering 400 m at the same 5.8 cm resolution would take 7172² ≈ 51 M cells. Instead there are three windows of equal size that slide with the camera, each with cells 4× larger than the one inside it:

| Level | Cell | Span | Mesh | Role |
|---|---|---|---|---|
| L0 | 5.8 cm | 26 m | full grid | interactive |
| L1 | 23 cm | 104 m | ring (hole = L0) | simulated |
| L2 | 93 cm | 416 m | ring (hole = L1) | simulated |
| Skirt | n/a | to 1300 m | four strips | analytic |

All levels snap to one step, `SNAP` (the L2 cell), so grid lines always line up and each ring's hole exactly matches the level inside it. Coarser levels are biased down by 1.5 cm per level, so the finer level always wins in the overlap band and there's no z-fighting.

### 8.2 Three ideas that make it work

1. **Toroidal addressing.** When a window slides, no data moves. A world cell `(gx, gy)` maps to buffer index `mod(gy)·G + mod(gx)`, using floored mod so negative coordinates work. Neighbor reads clamp in *window* space before wrapping, otherwise the window edge would read the opposite row.
2. **Tags for dirty detection.** Each cell stores the world cell coordinate it currently represents. If that doesn't match, the cell is stale and gets refilled.
3. **One equilibrium function.** `snowBaseFrom(xz, terrain)` depends only on world position, never on cell size. All three levels converge toward it and the skirt uses it directly, so the seams agree. It encodes two pieces of physics:
   - **Steep slopes shed snow:** `1 − smoothstep(0.62, 1.60, |∇h|)`.
   - **Wind:** windward slopes are scoured and lee slopes load up, based on the dot product of the slope direction with the wind direction.
   - A slowly drifting `driftNoise` adds dunes. Its three octaves fade out by distance from the window center (λ≈10 m everywhere, λ≈4.5 m within 50 m, λ≈1.2 m within 14 m), so each wavelength spans at least 11 vertices on whichever level draws it. The criterion here is "no visible facets under Gouraud shading", which is much stricter than "no aliasing".

### 8.3 Per-level buffers

Each level has 448² = 200,704 cells:

| Buffer | Type | Meaning |
|---|---|---|
| `height` | f32 | snow depth (ping) |
| `height2` | f32 | relax output (pong) |
| `packed` | f32 | compaction 0..1 |
| `crust` | f32 | wind crust 0..1 |
| `surf` | f32 | absolute surface height = terrain + snow |
| `lightB` | vec4 | x sun visibility, y sky occlusion, z cavity |
| `tag` | vec2 | world cell this slot represents |
| `touch` | f32 | L0 only: has a hand touched this cell |

### 8.4 Compute passes

Each pass is a TSL `Fn` compiled once with `.compute(CELLS)`.

**`computeRefresh`** compares the tag and refills stale cells with `snowBase × snowProgress + stash.x`. That is the snow that has *actually fallen so far* plus any remembered deformation. Filling 0 would expose bare ground as you walk. Filling the full depth would make new ground thicker than the snow under your feet. It also seeds `packed` and `crust` from the stash.

**`computeFill`** handles Clear (C) and Fill (F). It writes `fillValue × (1 + drift noise)` everywhere and resets compaction, crust and touch.

**`computeRelax`** (height → height2) does angle-of-repose slumping. For each of the four neighbors, flux = `sign(d)·max(|d| − threshold, 0)`. Flux is antisymmetric, so mass is conserved. The threshold is `reposeSlope × cell`, so all levels slump to the same slope. A small Laplacian self-smoothing term is added on top. **Packed snow stands steeper:** `firm = smoothstep(0.955, 1.0, packed)` multiplies the threshold by `1 + firm·packRepose` and suppresses both slumping (92%) and smoothing (95%). The 0.955 cutoff is deliberately tight. Molds write exactly 1.0, while hand piles (0.7), berms (~0.5) and handprints (0.95) all fall below it. So freehand play feels the same as before (handprints still slowly soften), and only molded snow holds its shape.

**`computeAccumulate`** (height2 → height) does deposition. The rate is `depositRate × dt`, gated by `1 − smoothstep(0.45·base, base, h)` so cells converge to equilibrium instead of growing without bound. L1 and L2 (non-interactive) also pull quickly toward `base × snowProgress + stash`, so trails stay continuous across the L0 boundary. L0 must **not** read the stash, because it is the stash's source and would feed back on itself. The pass also:

- decays compaction as fresh snow covers it,
- grows crust at a wind-dependent rate while fresh snow buries it, which is how layering emerges,
- decays the `touch` flag as tracks get buried, which releases them from the stash,
- writes `surf` (absolute height), which coarse-level lighting uses to self-shadow distant hills.

**`computeDeform`** (L0 only, dispatched only while the hand is engaged) is covered in §10.

**`computeMold`** (L0 only) is covered in §11.6.

**`computeLighting`** ray-marches the heightfield directly. Doing this per cell rather than per pixel is the point: 448² cells against about 2 M screen pixels.

- **Sun visibility (x).** 14 steps along the sun's azimuth at quadratically growing distances (`0.055·n²·rel`: 10.8 m on L0, 173 m on L2), compared against `surf`. The reference height rises at the larger of the sun's slope and the ground's own slope along that direction. Without that, any slope steeper than the sun elevation would self-occlude, and the terminator would break into stripes. Facing away from the sun is NdotL's job, and the march only looks for *other* geometry casting shadow. Fine levels `min()` in the coarsest level's result. Everything fades to fully lit as the sun nears the horizon.
- **Sky occlusion (y).** HBAO-style: 6 azimuths × 4 radii (0.09–1.15 m × level scale), horizon angle measured **relative to the local tangent plane**. Measuring against the horizontal plane makes every uniform slope look occluded, and on L2 the nearest-neighbor jitter turns that into noise across the whole far field. The result is raised to the power 1.35. Fine levels multiply in the coarse result so the large-scale component matches everywhere and no brightness step shows at the seams.
- **Cavity (z).** Mean height above the tangent plane over all samples. Positive means "in a hollow", which lengthens the subsurface path (§9.3).

Coarse levels apply a 3×3 tent filter to `lightB` in the vertex shader to suppress per-cell moiré. L0 doesn't, so contact darkening inside handprints stays crisp.

### 8.5 The deformation stash

The clipmap has a cost: cells that slide out of the window are refilled at equilibrium, so footprints vanish. Walk 15 m and look back, and your trail stops in a straight line.

The fix is a separate **2048² world-space map at 12.5 cm per cell, covering 256 m**, which also follows the camera. It stores `vec2(height − equilibrium, compaction)`.

- **`computeStashWrite`** runs over only the roughly 212² stash cells under L0, not the whole map. Threads are organized by world coordinate because L0's footprint isn't contiguous in the toroidal buffer. Only cells with `touch > 0.02` are recorded. Otherwise natural wind drift would be frozen into the stash and pasted back, and dunes would stop moving.
- **`computeStashRefresh`** sweeps the full 2048² and clears cells whose tag doesn't match. The window snaps to 16 m (128 cells), so this runs only on frames where the window actually moves, roughly once every 60 frames while walking.
- **Tag packing.** World coordinates span ±4096 cells, and `x·16384 + y` would overflow float32's exact-integer range (1.67e7). The window moves in aligned 128-cell blocks, so the tag stores the block index (`bx·2048 + by`, max ≈1e6, exact) in one `float` instead of a `vec2`. That saves 16.8 MB.
- **Consumers.** The L0 refresh (walk away and back, the trail is still there) and L1/L2 accumulate (trails don't break where they cross into L1).
- **Clear** offsets the stash window by 3×N and sweeps, which invalidates everything.

Cost: 33.5 MB of data plus 16.8 MB of tags. The stash is half L0's resolution, so restored tracks come back slightly softer: berms survive, but handprint fingers blur into a palm shape.

### 8.6 The 8-storage-buffer ceiling

After the stash was added, L0's refresh pass bound **9** storage buffers. WebGPU only guarantees 8 per stage, and pipeline creation failed. The adapter offered 16 via `requiredLimits`, but relying on that would tie compatibility to specific hardware. The fix: refresh doesn't write `height2`, because relax recomputes it immediately afterwards. That brings the pass back to exactly 8: `tag / height / packed / crust / surf / terrain / stash / touch`. The pass is full. Count before adding anything to it.

### 8.7 Geometry and the skirt

Each level is a static `GRID × GRID` row-major vertex grid. The vertex index *is* the window coordinate. `positionNode` computes world position from the window origin, terrain and snow height, so the model matrix stays identity, `matrixAutoUpdate = false`, and frustum culling is off. L1 and L2 share one ring index buffer.

The **skirt** is four `PlaneGeometry` strips forming a frame from just inside L2's edge out to 1300 m. Its vertices evaluate `terrain + snowBase × snowProgress − 6 cm`. Its material is a cheap `MeshStandardNodeMaterial` that blends to soil texture on steep slopes. No shadows, no simulation.

### 8.8 CPU readback

`readSurface()` reads L0's `surf` buffer (448² floats, about 800 KB) asynchronously every 4 frames. The CPU then knows the *real* surface height: drifts, trenches, piles. The interaction module bilinearly samples it, using the same toroidal mapping as the GPU, to place molds and the hand. Outside L0, or before the first readback arrives, it falls back to `terrain + estimated mean depth`.

---

## 9. Snow shading

Snow uses `MeshSSSNodeMaterial` with IOR **1.31** (ice, F0 ≈ 0.018). The default 1.5 (F0 0.04) makes snow look like plastic. Every term below is a shared function in `snowfield.js` ("Snow surface shading"), called by both the ground and sculpture materials so the two can't drift apart (§11.7).

### 9.1 Three snow states

| State | Origin | Look |
|---|---|---|
| Fresh powder | just fell | whitest (0.90, 0.93, 0.98), roughness 0.68, most glints, most translucent |
| Wind crust | wind sinters the surface; new snow buries it | slightly grayer, roughness 0.38, few glints, strong grazing sheen, fine grain smoothed |
| Packed | pressed by the hand | darkest and bluest (0.70, 0.78, 0.90), roughness 0.30, almost no glints or transmission |

Any touch by the hand breaks the crust.

### 9.2 Surface detail

- **Wind ripples and grain** (`windGrainGrad`): two analytic-derivative value-noise layers in wind-aligned coordinates (5×19 and 13×47 cycles per metre), so ripples run perpendicular to the wind. Crust smooths the fine layer, depth strengthens relief, and compaction flattens it. Fade-out is keyed to **pixel footprint**, `fwidth(p.xz)`, not distance (§21.5). The threshold sits at about 3–14 cm per pixel, deliberately above Nyquist (2.5 cm). That keeps eye-level ripples at 10 m+, which is the scene's best texture, and leaves a little aliasing for TRAA to absorb.
- **Grit** (`snowGrit`): 5 mm and 2.4 cm albedo noise, the "sugar grain" look up close, also footprint-faded.
- **Crumbling edges:** on L0 only, steep snow faces get displaced by `noised(xz·26)` weighted by slope. Vertex displacement and normal perturbation use the *same* function with its analytic derivative, so they agree. Flat snow is untouched and steep edges crumble.
- **Strata:** horizontal layer lines by world height (38 per metre, with noise-wobbled layer surfaces), shown only where the *snow's own* slope is steep, which is to say on cut faces and never on hillsides.
- **Normals:** a 3×3 Sobel of the snow height plus the terrain gradient. Sobel rather than central differences, because central differences decouple odd and even cells and amplify any noise into a 2-cell checkerboard.
- **Distance roughness:** roughness ramps to 0.90 between 25 and 140 m. A pixel 100 m away covers more than 10 cm of snow with countless normal orientations, and fitting that with a narrow lobe amplifies vertex-normal interpolation error.

### 9.3 Subsurface scattering and Beer–Lambert color

Snow is a dense scattering medium. Light refracts into ice grains, random-walks dozens of times, and exits nearby. What gets modeled is not "transparency" but **how far the light travels**:

```
density   = 1 + 1.8·packed + 0.6·crust
path      = sssPath · clamp(depth/0.2, 0.06, 3) · density · (1 + 1.2·max(cavity, 0))
transmit  = exp(−[0.34, 0.065, 0.017] · path)       ice absorption, 1/m
```

Ice absorbs red about 20× more strongly than blue. That is why deep snow, holes and packed snow look blue. In this scene the blue is computed, not painted on. The result feeds three paths:

- **Isotropic wrap** (`thicknessAmbientNode`, not multiplied by NdotL): bleeds onto the shadow side, which is why the terminator is soft and snow doesn't look like plaster. Denser snow has a shorter mean free path and less wrap.
- **Forward lobe** (`thicknessColorNode`): thin snow and berm crests (negative cavity) glow when backlit.
- **Albedo hue:** the transmit color normalized to its blue channel, so it shifts hue without darkening. Hollows read blue even in pure ambient light.

All SSS terms are multiplied by snow cover. Without that, `thin = 1 − smoothstep(0.02, 0.17, depth)` equals **1** on bare ground, and exposed soil would glow (§21.6).

### 9.4 Ice-crystal glints, retroreflection and sheen

Glints go through `emissiveNode` (`snowSparkle`).

- **Three crystal scales** (52, 165 and 460 cells per metre), each faded by distance (38 m, 15 m and 5.5 m), so the far field doesn't dissolve into sparkle noise.
- Each crystal is a **point** inside its cell, not the whole cell, otherwise close up you see little squares. Each has a hashed facet normal, a hashed threshold controlled by the crystal-density slider, and a Blinn lobe of power 60–190.
- **Facet orientation is a wide distribution with a slight upward bias** (`mix(N, up, 0.28) + jitter·1.15–1.70`). The first version used perfectly flat platelets, which is physically plausible, but under a 20° sun the whole field had zero glints. Dry snow glints from every angle because facet orientation really is scattered. The upward bias keeps the "diamond road" toward the specular direction without switching off everything else.
- One crystal per cell can't match nature's astronomical counts, so a **wider lobe** compensates for the missing quantity.
- **Dispersion:** R/G/B use exponents 0.90, 1.00 and 1.14, so glint edges fringe slightly.
- Glints are scaled by "hoar" density (`1 − 0.92·packed − 0.5·crust`), heightfield sun visibility, cover, sun power and the sparkle slider. Snow in shadow doesn't glint, and pushed snow doesn't glint.
- **Retroreflection:** `dot(V, L)^2.5`. Snow brightens when you look along the sun's direction.
- **Grazing sheen:** `(1 − N·V)^4.5`, sky-colored, stronger on crust, faded 25–110 m away because it's extremely normal-sensitive at grazing angles.

### 9.5 Lighting hooks

- `aoNode = sky occlusion` affects **indirect light only**. This is the physical reason handprint interiors darken.
- `receivedShadowNode = shadow × sun visibility`. The heightfield march adds berm self-shadows (finer than any shadow map) and hill self-shadows beyond the CSM range.

### 9.6 Exposed ground

Where snow depth drops toward 0 (`cover = smoothstep(0.002, 0.032, depth)`), the shader blends to a real PBR soil (`ground.js`). The UVs are world-xz planar, 1.75 m per tile. That stretches on steep walls, but fine soil hides stretching and triplanar would cost 3× the samples. A low-frequency luminance variation breaks up the tiling, and roughness and normals come from the packed `ground_nr.jpg`.

### 9.7 Cursor feedback

On L0, the emissive term also draws the hand ring and the mold footprint outline (a distance-field line from the footprint atlas). The color pass draws a soft palm shadow under the hand. The preview code is wrapped in `If(moldActive)`, so it costs nothing while using the hand.

### 9.8 Debug views

`__snow.U.debugMode.value = 1…6` replaces the output with an unlit view of one intermediate value: sun visibility, sky occlusion, depth, normal, level index, or **pure Lambert** (`N·L`). Mode 6, the most normal-sensitive probe, is what located the far-field moiré.

---

## 10. Interaction: the hand

`interaction.js` turns the mouse into a hand, modeled as a sphere of radius `handSize`.

### 10.1 Picking the surface

The ground isn't a plane, so the code doesn't use `Plane.intersect`. `raycastGround` steps along the ray (0.25 m initial step, ×1.22 per step, max 6 m, up to 220 m) against `surfaceAt(x, z) = max(groundAt, sculpture top)`. It then bisects 8 times to millimetre precision. Sculptures are also hit-tested against their actual meshes with three's `Raycaster`, because the marching step can be half a metre at range and would skip over a tower top. The hit is clamped to the interactive L0 window and smoothed (lerp 0.75 while held, 0.45 otherwise), which gives the hand a little weight.

### 10.2 Click vs drag

A press shorter than 200 ms that moves less than 9 cm is a **click**: it stamps a handprint oriented away from the camera. Otherwise the hand "engages" once it has moved 9 cm or been held for 200 ms.

### 10.3 Gestures (`computeDeform`)

Each frame, the previous and current hand positions form a **segment**, so fast drags can't skip cells.

| Mode | Effect |
|---|---|
| **Push (1)** | Snow under the palm core is scraped away (`min(h, press·core)`) and redeposited in a Gaussian **berm ring** just outside the palm, biased toward the direction of travel and scaled by local availability. The ring's area is much larger than the core's, so the per-cell deposit is scaled down by 0.30, otherwise snow appears from nowhere. Sets compaction. |
| **Smooth (2)** | Pulls toward the 4-neighbor mean and slightly reduces compaction. Reads and writes the same buffer in place; races between neighbors are invisible for a smoothing operator. |
| **Pile (3)** | Adds snow under a soft disc; compaction 0.7. |
| **Print** (click) | A procedural hand SDF: elliptical palm, four finger capsules, thumb. Pressed to at most 82% of local depth, so shallow snow still shows the hand shape instead of punching through. Adds a small rim, compaction 0.95. |

Every mode breaks the crust and sets `touch`. The output is clamped to `max(3.5·targetDepth + 0.1, BUILD_CEIL)`. The pass writes **every** L0 cell unconditionally, so a low ceiling would shave every sculpture's base pad flat the moment you pushed anywhere.

**Unified hand.** The hand sphere affects ground and sculptures in the same frame: same position, radius and falloff curve. An earlier version picked one or the other by raycast result, and at a sculpture's foot it flickered between pushing the ground and pushing the sculpture.

### 10.4 Spray

When pushing faster than 0.85 m/s, `computeSprayEmit` launches up to 160 particles per frame from random points along the hand segment, pushed outward past the palm edge with velocity along the motion direction plus upward kick and jitter (§12).

### 10.5 Mean-depth estimate

The CPU keeps `estY`, which integrates `depositRate` with the same convergence gate as `computeAccumulate`. It feeds `U.snowProgress`, which is what refresh, L1/L2 and the skirt multiply equilibrium by.

---

## 11. Molds and snow sculptures

Molds work like sand-castle buckets: pick a shape, click, and a packed-snow sculpture appears. Hold and drag to lay a row; adjacent molds fuse together.

### 11.1 Why not write molds into the heightfield

The first version stamped a top-down height profile into the snowfield. That had two fundamental problems:

1. A heightfield has one height per (x, z), so **overhangs are impossible**: snowman necks, duck heads, bunny ears, igloo doorways.
2. Cells are 5.8 cm. Vertical walls became long thin triangles with normals jumping between cells, and the result was a checkerboard on every wall, worse the taller the shape.

So each mold is now a **3D signed distance field** meshed on the CPU, and the heightfield only gets a thin pad around the sculpture's foot.

### 11.2 Mold library (`molds.js`)

Nine shapes are written as analytic SDFs in normalized units (y up, base at y = 0, face toward −x, the camera):

`ball · snowman · duck · bunny · tower · wall · igloo · spire · star`

They're built from spheres, ellipsoids, capsules, boxes, cylinders, tori and an IQ-style 2D star, combined with polynomial **smooth union** (`smin`) for the pinched joins of packed snow, and `smax` carving for eye sockets, doorways and battlement gaps. Design rule: **every detail is snow relief** (eyes are dimples, buttons are bumps, the scarf is a ridge), never a different material. Extra touches include a 5% draft on towers and walls so they'd release from a real bucket, block-course grooves, an igloo brick pattern with staggered vertical joints, and a hollow igloo with a real doorway. A shared `lumps()` adds two octaves of low-amplitude value noise for a hand-patted surface.

Each entry also carries `foot` (base half-extents and radius, used for drag spacing and merge tests), `top` (used by the merge reveal animation) and `bounds` (the meshing box).

### 11.3 Voxel fields and Surface Nets (`sculpt.js`)

- **Mold field cache.** Each mold's SDF is sampled once on a 0.034-normalized voxel grid with 0.22 padding, then cached. At the default 55 cm size that's about 1.9 cm per voxel, 3× finer than the snow grid. The cache is warmed during idle time after boot, so the first click doesn't stall.
- **Sculpture.** Each sculpture has a local frame (origin at base center, x along its facing) and a voxel grid in metres, split into **24³ chunks**, one `Mesh` per chunk.
- **Surface Nets:**
  - One vertex per sign-changing voxel, placed at the mean of the zero crossings on its 12 edges.
  - Early-out: most voxels have all 8 corners on the same side, and the loop stops at the first sign difference, usually after 2–3 reads. This dominates remesh time.
  - Normals are the **trilinearly interpolated SDF gradient**, so surfaces are smooth with no faceting.
  - Quads are split along the shorter diagonal, with winding aligned to the gradient.
  - Each chunk also computes vertices for one ring of low-side neighbors, so adjacent chunks generate identical seam vertices and the seams close exactly.

### 11.4 Placement logic

`placeMold()` runs in this order:

1. The base height is the **lowest** ground sample over 8 points around the footprint, using real surface readback. On a slope the low side never floats, and the high side just sinks a little further. The base then sits 4% of the mold size below the surface.
2. If the cursor is on top of an existing sculpture, **stack**: merge into it at its top surface.
3. Else if any of 9 footprint sample points (corners, edge midpoints, center) falls inside a neighbor's grid and the scales are compatible (0.6–1.7×), **merge** with ground blending. Testing only the center would never detect end-to-end walls.
4. Otherwise create a **standalone** sculpture.

Standalone sculptures reuse the cached field directly, with grid points aligned and scaled by the mold size, so no resampling is needed. Their SDF is soft-unioned with the **ground** (`groundBlend`): the foot flares into a rounded fillet that follows the real readback surface down into the snow, the ground sheet is limited to within 1.5k of the sculpture, and it's cut flat underneath.

**Merging** trilinearly resamples the new mold into the host's grid, growing the host grid if needed (aligned, up to 260³ voxels; beyond that it falls back to standalone). A **rising cut plane** then reveals the new part over 0.32 s: each frame, `smin(base, smax(new, y − level))`, so the new shape fuses into the old one with a 7%-of-scale fillet.

New standalone sculptures animate in by scaling up from y = 0.001 with a 6% overshoot in width, like settling when unmolded.

### 11.5 Brushing sculptures

The hand edits the SDF directly, inside a sphere of radius R:

- **Push:** `F += rate·dt·w` (carve).
- **Pile:** `F −= rate·dt·w` (bulge). The grid grows if needed.
- **Smooth:** pull toward the 6-neighbor mean from a **snapshot**, so the result doesn't drift in the scan direction. On a distance field this is Laplacian smoothing: flats stay put, convex edges round off, concave corners fill in.

Falloff is `1 − smoothstep(r0, R, d)` with the same inner radius as the ground hand (0.22R, or 0.05R for pile), and the rate follows the press slider (about 6 × press m/s). Edits mark only the touched chunks dirty. Remeshing is **time-budgeted at 5 ms per frame** across all sculptures: a 50 cm hand can touch half a tower, a full remesh takes over 10 ms, and spreading it over frames keeps the frame rate steady.

### 11.6 Heightfield base pad (`computeMold`)

The sculpture mesh already has a ground fillet, but its intersection line with the snow surface would still show. So the GPU stamps a thin packed-snow pad that follows the **sculpture's true footprint**:

- **Footprint atlas.** For each mold, the CPU computes a 96² 2D distance field: the minimum SDF over slices y = 0…0.16. That captures bunny paws, duck belly and igloo porch. All nine are packed into one half-float atlas (9 rows), which the GPU samples bilinearly (`padSd`).
- **Profile:** `q = 1 − clamp(sd/padW)` and `rise = padH·q² − 0.4·(1 − q)²`. The outer rim keeps descending below the base height, because the base was estimated from nearby surface and the local snow may be a few centimetres lower. Descending guarantees a smooth join instead of a step. The silhouette is jittered by about a cell of noise to remove the machine-cut edge.
- **Idempotent:** the merge is `max(h, want)`, and `moldGrow` ramps 0 → 1 over 0.32 s while the pass re-runs every frame without stacking.
- Compaction is exactly 1.0 inside the outline, which clears relax's 0.955 gate so the pad holds its shape, and 0.3 outside so no blue ring forms. Crust is cleared and `touch` is set, so the pad persists via the stash.
- Molds stacked on sculptures skip the pad, since the heightfield can't reach them.

### 11.7 Sculpture material: same snow, same inputs

The sculpture material calls the **same** albedo, roughness, grain, glint and SSS functions as the ground. Identical formulas aren't enough on their own; the *inputs* have to match too:

1. **Ground-coupled vertex inputs.** In the vertex stage, each sculpture vertex samples L0's compaction, crust, depth, sun visibility and sky occlusion at its world xz. It blends from 100% ground values at the snow surface to the sculpture's own values (compaction 0.5, depth 0.3 m) 30 cm above. That removes the seam.
2. **Aligned texture space.** Triplanar with 4th-power weights. Up-facing surfaces use the **xz** projection, the same as the ground, so ripples, grit and glint cells continue across the join.

Additional details:

- Up-facing surfaces get a fresh coat (compaction pushed toward 0), like new snowfall on top.
- `receivedShadowPositionNode` offsets 4.5 cm along the normal. Smooth curved surfaces near the terminator otherwise get shadow acne stripes, and changing `normalBias` globally would detach all prop shadows.
- Transmission is ×0.3: sculptures have large vertical backlit faces where ground-level transmission would read as a cyan ice shell.
- **Snow bounce emissive:** the lower hemisphere of the environment map is darker than real lit snow, so downward-facing surfaces get `albedo × (sky + 0.12·sun) × down × 0.3 × occlusion`. Without this, a snowman's belly underside reads gray against the bright snow around it.

Ghost preview and brush ball use a transparent fresnel-rim `MeshBasicNodeMaterial` whose opacity is tied to a uniform, so photo mode can switch them off.

Up to 96 sculptures are kept. Any sculpture more than 130 m from the clipmap center is pruned, matching the stash's ±128 m reach.

---

## 12. Falling snow and spray

### 12.1 Falling flakes

`snowfall.js` keeps 90,000 slots in storage buffers (position, velocity, and a random vec4 for size, phase, brightness and spin). Only the first `activeFlakes` are simulated or drawn.

- **Simulation:** velocity relaxes toward `wind + terminal fall + flutter`. Terminal speed grows with flake size. Flutter is two pairs of sinusoids per flake, scaled inversely with size, so small flakes get blown around more. When a flake reaches the **current snow surface** (L0 `surf` inside the window, L1 outside), it respawns 13.5–15 m above the window-center ground. Flakes wrap around the camera-following field (radius ≈ 16 m), so snow follows you as you walk.
- **Rendering:** instanced `Sprite` with `SpriteNodeMaterial`. WebGPU's point primitive is fixed at 1 px.
  - Slight vertical stretch with fall speed, and slow rotational sway so the streak stays roughly vertical.
  - Color = sky ambient + sunlight × **forward scattering** (`(−V·L)^2.2`). Backlit snowfall glows, which is the difference between "white dots" and "it's snowing".
  - Each flake is a **tumbling ice platelet**. A time-rotating normal is tested against the sun half-vector using `|N·H|` (platelets reflect from both faces), with a broad lobe (power 16) for shimmer plus a narrow lobe (power 90) for occasional bright flashes, and dispersion.
  - Per-flake edge softness gives a depth-of-field feel.
  - Large flakes 1–10 m away reveal a **six-armed dendrite silhouette** (three crossing arms). It's disabled at distance, where it would only add flicker.
  - Fade in from 0.3 to 1.7 m (don't smear the lens), fade out from 24 to 44 m (overdraw).

### 12.2 Hand spray

There are 12,288 slots in a ring buffer, with up to 160 emitted per frame and a lifetime of 0.45–1.2 s.

- **Physics:** gravity at −5.4 m/s², wind, very strong drag (`1 − 2.6·dt`, floored at 0.2). Particles die on contact with the surface.
- **Rendering:** a noisy puff that grows with age. Stronger forward scattering than flakes, a fast-tumbling whole-puff glint (it was knocked loose, not falling), and noise-picked internal specks that each glint. The aim is a handful of ice crystals rather than a gray blob.

Both share the crystal-density slider with ground glints.

---

## 13. Props: batching, LOD and placement

### 13.1 BatchedMesh

Each glTF is loaded once. Every mesh's world matrix is baked into its geometry, then everything is uniformly scaled to `targetHeight`, and the origin is moved to the bottom-center of the bounding box. Each material becomes one `THREE.BatchedMesh` holding all LODs and all instances: one pipeline bind, one vertex/index bind, one matrix texture, and culling and sorting in a tight loop.

> On the WebGPU backend, three implements `BatchedMesh` as a loop of `drawIndexed` calls inside one render pass, not true multi-draw. `renderer.info.render.drawCalls` still counts visible instances. What batching saves is state changes and per-object JS overhead, not GPU draw count.

### 13.2 Two simplifiers, chosen per material

| Kind | Method | Why |
|---|---|---|
| Closed solids (rock, stump) | **Vertex clustering** on a spatial grid (attributes averaged, normals renormalized, tangent handedness preserved, degenerate triangles dropped) | Smears UV seams slightly but never opens holes |
| Alpha cutouts (pine needles, grass) | **Drop smallest-area triangles** | Vertex attributes untouched, so UVs and alpha edges stay crisp. Degrades by losing leaves, which is how foliage LOD should degrade |

Swap them and both fail: clustering mashes leaf cards into blobs, and dropping triangles punches holes in rocks.

Five levels (1 / 0.62 / 0.38 / 0.22 / 0.12). More levels mean a smaller visual jump at each switch:

```
pine    3494 / 2166 / 1328 /  769 /  419 tris
rock1  20359 / 9991 / 7574 / 5046 / 3042
rock2   8296 / 6200 / 5010 / 3352 / 2020
stump  14948 /10705 / 8692 / 6360 / 3949
plant    226 /  140 /   86 /   50 /   27
```

### 13.3 Screen-space thresholds

LOD is selected by **projected height ratio** `h/d`, not distance, so a 4 m tree and a 0.8 m tuft are judged on the same scale. At 1600×900 with a 52° vertical FOV, `pixels ≈ (h/d) × 923`:

```
LOD1 0.049 ≈ 45 px    LOD2 0.030 ≈ 28 px    LOD3 0.020 ≈ 18 px
LOD4 0.013 ≈ 12 px    cull 0.008 ≈ 7 px
```

The first guess was 0.075 (69 px). At that threshold, trees 60 m away immediately lost two-thirds of their needle cards and the midground visibly thinned. Thresholds have to be set in pixels, not by feel. Each instance's threshold is jittered ±16%, so a forest doesn't drop LOD in one synchronized wave. Evaluation is spread across 4 frames.

### 13.4 Dithered crossfades

Every instance has **two slots**. On a level change, the spare slot receives the new geometry, the two crossfade over 0.3 s, and then the old slot hides. Cull and reappear use the same path. The extra cost is a matrix texture twice as large (hundreds of KB). Only 20–38 of the ~1,949 instances are mid-transition while moving, and 0 when still.

- The fade value lives in the **alpha channel of BatchedMesh's per-instance color texture** (RGB stays white, so props aren't tinted). three writes it into the `vBatchColor` varying, and the material reads it with `varyingProperty('vec4', 'vBatchColor').w`. The color texture must exist before material compilation, or the varying never gets written and the whole batch vanishes.
- **Dither dissolve:** `maskNode = fade > IGN(screenCoordinate)` (interleaved gradient noise). TRAA averages the dither over time into a smooth fade. `maskNode` also applies in the shadow pass, so shadows fade with their trees.
- **Gotcha:** three multiplies `batchColor` into `colorNode` *including alpha*, so a cutout material's `alphaTest` threshold must also be multiplied by `fade`. Otherwise a tree vanishes all at once the moment fade drops below the cutoff.
- **Distance-relaxed alpha test:** the cutoff drops from the source value to 0.10 between 25 and 130 m, so needle cards don't erode with distance and trees don't thin out in the midground. The proper fix is alpha-to-coverage, which needs MSAA, which conflicts with GTAO/TRAA depth (§16).

### 13.5 Snowy materials

`snowyVersionOf()` clones any glTF material into a `MeshStandardNodeMaterial` while keeping maps (base, normal, roughness, metalness, AO, emissive, alpha). Up-facing surfaces (`normalWorld.y` plus small high-frequency noise plus `coatBias`) blend toward snow white and roughness 0.88, with a faint cold backlit emissive. Only RGB is mixed: mixing a vec4 would push alpha to 1 and turn leaf cards into opaque squares.

### 13.6 Scatter

`main.js:scatter()` uses a seeded LCG and places points by `sqrt`-uniform radius, so density is uniform by **area**. It rejects slopes above 0.55 and the terrain rim. There are two layers per prop: a dense near ring (the "set dressing" the camera usually sees) and a sparse outer field out to 340–380 m. Single-layer scattering left the near field either empty or the far field too expensive, since the two areas differ by two orders of magnitude. Outer layers are **clumped**: clump centers are scattered first, then instances placed around them with an approximately Gaussian spread. That reduced draw calls by 40% (1654 → 999) at equal quality and looks more natural.

| Prop | Height | Instances (near + far) | Clumps |
|---|---|---|---|
| Pine | 4.2 m | 26 + 560 | 34 |
| Rock 1 | 0.95 m | 10 + 180 | n/a |
| Rock 2 | 0.45 m | 14 + 300 | 40 |
| Stump | 1.15 m | 9 + 220 | 30 |
| Grass | 0.85 m | 30 + 600 | 46 |

### 13.7 Grounding props on slopes

Assembly aligns the bounding-box base to y = 0, which is a **flat** base, and placement originally used only the center's terrain height. Measured overhang on the downhill side reached 2.11 m (max) and 0.39 m (median) for rock1. The fix has three parts:

1. **`alignSlope`**: tilt toward the terrain normal. Rocks get 1.0 (they lie on the slope), trees 0.12 (they grow vertically), stumps 0.55. This took median overhang from 0.39 m to −0.08 m.
2. **Lower until contact.** Tilting fits a *plane*, but terrain curves. A rock on a convex ridge still floated 1.6 m. So the code samples two rings of 8 points around the rotated footprint and takes the **lowest** solution. That is deliberately *not* rigid-body rest, which would take the highest contact point and lift the edges. With 20 cm of snow on top, burying a little is invisible and floating a little is obvious.
3. **`sink`**: bury a further 2–7% of height so the contact isn't a hairline gap.

`footprint` scales the contact radius. A pine's bounding box is its canopy, but only its trunk touches the ground (0.12).

Result: every one of the 1,949 instances has negative maximum overhang. The least-buried one is still 1 cm underground.

---

## 14. Sky, environment lighting and shadows

### 14.1 Sky dome

A back-faced 320 m sphere with a TSL color function:

- zenith-to-horizon gradient
- horizon blended into fog color, so the fully fogged far snowfield doesn't meet the sky at a hard edge
- sun or moon core plus a wide halo
- stretched fBm stratus clouds near the horizon
- stars at night, gated by low sun power

Physical atmosphere was tried: a ray-marched scattering version ran yellow near the horizon and looked less clean, so it was removed.

### 14.2 Environment map (IBL)

The same sky function is rendered into a 10 m bake sphere (linear HDR, not tone-mapped) and run through `PMREMGenerator` (256) into `scene.environment`. Snow's albedo of about 0.9 makes interreflection matter much more than for typical materials (concavities can differ 2× from a hemisphere-light approximation), so the full IBL path is worth it here.

- **Below the horizon:** the bake blends in `groundRadiance`, computed as `0.85 × (mean sky + sun·max(sunY, 0)/π)`. Bounced light from below therefore matches the actual snow.
- **HDRI blend:** `winter_lake_1k.exr` (Poly Haven, shrunk from 4K) loads asynchronously. The bake mixes procedural sky and HDRI by `hdriMix`. The HDRI only provides **indirect** light; the visible dome, sun and fog stay procedural.
  - **Sky tinting:** the HDRI is multiplied per channel by `currentSkyMean / hdriMean` (weighted by `hdriTint`). HDRI detail survives, but warm/cool follows the time-of-day slider.
  - **Sun alignment:** on load, the code scans the upper half of the image (subsampled to about 512 wide) for the brightest azimuth and rotates the HDRI so its sun matches the scene's directional light. A mismatch between HDRI highlight direction and shadow direction is the most common HDRI giveaway.
- **`envLight`** (default 0.40) exists because the sky keyframes are display colors tuned to look right, not physical radiance. Used as irradiance directly, they'd be several times brighter than the sun and flatten the snow into featureless white.
- A very weak hemisphere light (0.14 × ambient) and ambient light (0.03–0.08) prevent pure black on backfaces.

### 14.3 Cascaded shadow maps

A single map can't serve both ends: near contact detail wants about 2 cm texels, while forest shadows want 250 m of coverage. An earlier ±110 m / 4096² map was 5.4 cm near the camera and still empty beyond 110 m.

`CSMShadowNode` splits the **view frustum** by depth into 4 cascades, each 2048² (about the same memory as one 4096²):

| Cascade | Range | Texel | `normalBias` |
|---|---|---|---|
| 0 | 0–21 m | ~2.0 cm | 0.035 |
| 1 | 21–57 m | ~4.9 cm | 0.09 |
| 2 | 57–125 m | ~10.7 cm | 0.20 |
| 3 | 125–260 m | ~22 cm | 0.40 |

- The splits are custom. The default "practical" scheme puts cascade 0 at 57 m, which is too coarse up close.
- `fade = true` crossfades between cascades. CSM handles texel snapping itself.
- **Depth bias is 0 everywhere; only `normalBias` (in world metres, ≈1.8 × texel) is used.** §21.3 explains why.
- `far` is 800 and `lightMargin` 150. Beyond 260 m, shadows are already half lost to haze and not worth another pass.
- The cascades are initialized eagerly with `csm._init({ camera, renderer })`. Don't assign `csm.camera` yourself: `setup()` only initializes when `camera === null`, and pre-filling it leaves every cascade empty (`Cannot read properties of undefined (reading 'oneMinus')`).
- The sun casts shadows only when `sunPower > 0.35`.

The heightfield ray march (§8.4) supplements CSM with snow-on-snow detail and far-hill shadows beyond 260 m.

---

## 15. Aerial perspective

This is implemented as `scene.fogNode`, which overrides the `FogExp2` object. That object is kept only because other code writes its color.

The original approach was a UE-style 3D LUT, and it was **rejected**. LUTs exist because cameras fly kilometres high through orders of magnitude of density change. Here the camera stays near the ground with view distances of 0–1300 m, where the scattering integral has a **closed form**. A LUT would be strictly worse: more memory plus trilinear error. The analytic version is about 30 ALU ops.

1. **Air column with exponential height falloff:**
   `∫₀^d exp(−(y₀ + t·ωy)/H) dt = H/ωy · (exp(−y₀/H) − exp(−y₁/H))`.
   As ωy → 0 this becomes 0/0. Its limit is the horizontal form `d·exp(−y₀/H)`, so both are computed and blended smoothly across |ωy| < 0.02. The result: valleys hazy, ridges clear. `hazeHeight` is H.
2. **Phase functions:** Rayleigh `(1 + cos²θ)` and Mie Henyey–Greenstein. A pure g = 0.76 single-scatter HG peaks at **143×** its 90° value toward the sun. That's physically correct for single scattering, but real haze is multiply scattered, and the first version blew everything past 150 m into white when looking toward the sun. The fix is g = 0.62 blended 45% with isotropic (representing multiple scattering), which gives a peak of about 10×, with a hard clamp at 7×.
3. **Spectral extinction:** 26% Rayleigh with λ⁻⁴ ratios (0.428 : 1 : 2.441), so distant dark objects go blue.

The phase function is **normalized to 1 at 90° from the sun**. Overall brightness and hue still come from the keyframed `fogColor`, so the art-directed sky stays intact and the physics only adds angular variation and spectral extinction.

---

## 16. Post-processing

```
pre-pass (opaque only) ──> packed normal (8-bit), depth, velocity
scene pass ──────────────> color, with GTAO injected into indirect lighting
      ├─ TRAA (or FXAA when TAA is off)
      ├─ lens corner softening (samples raw scene texture)
      ├─ + god rays × sun tint × strength
      ├─ + bloom
      └─ × vignette
```

- **Opaque-only pre-pass.** 90k transparent flakes in the normal/velocity buffers would make GTAO think there's geometry in the air and send TRAA's reprojection the wrong way.
- **GTAO** at half resolution with temporal filtering, radius 1.1 m, 12 samples. It is injected through `builtinAOContext` so it darkens **indirect light only**; multiplying final color would also darken direct sunlight. The heightfield AO only knows about snow; GTAO handles rocks, trees and models pressed into snow.
- **No MSAA.** A multisampled depth buffer can't feed GTAO/TRAA depth sampling (it triggers a `copyTextureToTexture` sample-count mismatch). Antialiasing is TRAA's job, with FXAA as the fallback when TAA is toggled off. Glints and wind ripples are **shading** aliasing, which MSAA can't fix anyway; only temporal accumulation can.
- **God rays** at half resolution, 40 steps, strength `0.32 × min(sunPower/2, 1.2)`. Strength was cut from 0.55 once the effect actually worked (§21.2), because it stacked with aerial perspective toward the sun.
- **Bloom:** strength `0.55 × slider`, radius 0.62, threshold 0.86.
- **Lens:**
  - Normalized radius corrected for aspect ratio, so the vignette is a circle rather than an ellipse.
  - **Corner softening** is wrapped in `If(edge > 0.003)`. Whole wavefronts in the center take the false branch and skip the 9 taps, so the center costs nothing. Offsets are a percentage of frame height (max 1%), so the effect is resolution-independent, and x offsets are divided by aspect for a round kernel. It's applied *before* god rays and bloom, which are already soft. That lets it sample the scene pass texture directly instead of costing an extra full-screen pass.
  - Measured effect: center sharpness unchanged, corner/center sharpness 1.37 → 1.12, corner/center brightness 0.90 → 0.82. FPS with the effect off, default or maxed was within noise (53–57).
  - The vignette is applied last, including over bloom, because it models lens light falloff and isn't part of the scene.
- Toggling TAA, AO or rays **rebuilds the pipeline** (a brief hitch). Numeric options update uniforms in place.

---

## 17. UI, camera and product shell

### 17.1 Visual identity

The palette comes from the OG image: coral sunlight (`#E8907E`), lavender sky (`#CFC6D6`), ice-blue shadows (`#4D74C4`) and ink (`#3A3550`). Panels use frosted-glass gradients. Type is Cormorant SC (display) with DM Mono (UI). Primary buttons are image buttons with hover variants (`assets/UI/*.png`).

### 17.2 Panel and shortcuts (`ui.js`)

The panel is generated from a declarative `GROUPS` table: Hand, Mold, Snowfall, Accumulation and Environment slider groups, plus gesture buttons, a mold picker (picking a mold switches to mold mode), and actions: clear, fill, reset view, pause snow, defaults, TAA/AO/rays toggles, low/medium/high quality.

- Groups collapse on header click or Enter/Space. The keyboard handler calls `stopPropagation()`, because otherwise Space would bubble up and toggle snowfall. Collapsed state persists in `localStorage` (`snow.groups`).
- Every change runs `refresh()` and then `applySettings()` (lights, fog, post).
- There are three top-right tools (help, camera, panel), and only one can be open at a time. The open one's icon becomes its close button; state lives in `body[data-open]`.

| Key | Action |
|---|---|
| Left drag / click | push / handprint (or place a mold in mold mode; drag to lay a row) |
| 1 / 2 / 3 / 4 | push / smooth / pile / mold |
| M | next mold |
| , / . | rotate mold ∓15° |
| [ / ] | hand size, or mold size in mold mode |
| W A S D, Q / E | walk, down/up; Shift sprints (9 → 46 m/s) |
| Right / middle drag, wheel | orbit / pan / zoom |
| C / F | clear / fill snow (also clears sculptures) |
| Space | toggle snowfall |
| H | toggle panel |
| R | reset view |
| P | take photo |

All shortcuts are ignored while `body` has `.landing` or `.viewing`.

### 17.3 Camera

- **Walking** translates both camera and orbit target along the camera's horizontal heading. Velocity approaches the target exponentially (`1 − exp(−dt·14)` when accelerating, `·9` when coasting), which gives about 0.15 s to reach speed and 0.25 s to glide to a stop, independent of frame rate. Diagonals are normalized. A terrain floor at +0.7 m keeps the camera above ground.
- **The clipmap follows `controls.target`, not the camera.** That is where the player is looking, and zooming out shouldn't drag the fine level away from it.
- **Enter fly-in:** there is no snap to a fixed home pose, because whatever angle the landing page had rotated to, a fixed pose would swing the camera around first. Azimuth continues at the landing rotation speed and eases to zero. `easeOutCubic` has slope 3/T at t = 0, so adding `v·T/3` to the target azimuth makes angular velocity continuous. Distance goes to 75% and elevation to about 13° over 1.8 s. Grabbing the camera cancels the fly-in.

### 17.4 Photo mode

The shutter captures the **canvas**, so DOM UI never appears in the photo. The cursor ring, mold outline, ghost and brush ball are drawn in the 3D scene, though, so they're switched off for the shot. TRAA's history would leave about 90% ghosting of them for a few frames, so the shutter waits **8 settle frames** (about 130 ms) before sampling. The capture must happen in the same rAF, immediately after `postfx.render()`, because WebGPU's swapchain image is unreadable after presentation. The frame is composited onto a 2D canvas with branding (top-left tagline and URL in DM Mono with a lavender shadow, title art bottom-left, all scaled by the short edge), then exported with `toBlob('image/png')`.

`photo.js` then shows a preview dialog with a white shutter flash and the date stamp:

- **Save** uses an anchor element that is actually attached to the document, because detached `download` anchors are silently ignored by Safari and Firefox.
- **Share** uses the Web Share API with files, and is shown only if `navigator.canShare` accepts files.
- Esc closes the dialog and Enter saves.

### 17.5 Landing page

The landing page is the live scene, auto-rotating at −0.35 (about 3 minutes per revolution). The title tilts toward the mouse with inertia and honors `prefers-reduced-motion`. Clicking the title triggers a "boing" plus a burst of nine snowflake sprites. Enter or Space enters the scene. The overlay can be replaced by the slow-device message (§4).

### 17.6 Onboarding tour

`tour.js` runs four card-less steps. Each one advances when the user **actually does it**:

1. **Push:** an ellipse projected onto the snow, the size of the hand, slides back and forth. Done after 0.6 s of engaged pushing. The ring is computed each frame by projecting `anchor ± R·right` and `anchor ± R·forward` to screen, so it really lies on the snow with correct perspective.
2. **Menu:** an arrow points to the Mold button, or to the panel icon first if the panel is closed.
3. **Place:** switches to the snowman, then shows a breathing ring on the snow. Done when `placedCount` increases.
4. **Photo:** closes the panel and points at the camera icon. Done when the preview opens.

The tour re-localizes on language change, can be skipped, and is remembered (`snow.tour.done`). It can be replayed from the help panel.

### 17.7 Internationalization

`i18n.js` holds an English/Chinese dictionary (English default, choice persisted as `snow.lang`). Static DOM uses `data-i18n` and `data-i18n-title`, and dynamic UI subscribes via `onLangChange`. Switching repaints text only and never rebuilds the DOM, so slider positions and scroll stay put. A HUD stats line is always visible:

```
fps · gpu ms (render / compute) · active flakes · LEVELS×GRID² grid → span · props
```

---

## 18. Asset pipeline

Source assets (8K textures, uncompressed GLBs, the 4K HDRI, about 360 MB total) are **not committed**. Two GLBs alone exceed GitHub's 100 MB hard limit. They are needed only to run the tools.

### `tools/optimize-glb.py`

Quixel and Poly Haven assets are about 99% texture. The script parses GLB chunks directly with PIL and no glTF library:

- Resizes each texture by **role**: albedo 2048, ORM 512–1024, normal 2048. 8K on a 0.85 m grass tuft is pointless, and ORM is low-frequency.
- Encodes ORM and normal maps with **4:4:4 chroma** (no subsampling). Their channels are independent data, and 4:2:0 would bleed R/B into G and corrupt roughness and normals.
- Drops slots the engine never reads (e.g. `KHR_materials_specular`, 7 MB in the grass asset).
- `--mask` converts foliage `alphaMode` from BLEND to MASK. Only alpha-tested materials write depth, enter the pre-pass, cast correct shadows, and get AO.
- `--set-normal` replaces bad normal slots. The grass asset's `normalTexture` was actually a grayscale **bump** map; the real tangent-space normal was in the source folder.
- Shares occlusion and metallicRoughness when they're the same packed image, rather than encoding it twice.

| Asset | Before | After | Triangles |
|---|---|---|---|
| rock1 (sandstone boulder) | 210.0 MB | 4.5 MB | 20,359 |
| rock2 (sandstone small) | 135.5 MB | 2.2 MB | 8,296 |
| plant (dry grass) | 97.9 MB | 3.6 MB | 226 |
| tree (dead stump) | 92.3 MB | 4.9 MB | 14,948 |
| stylized pine | 2.7 MB | 1.7 MB | 3,494 |

### `tools/prep-ground.py`

Packs a Quixel soil set into two 1024² JPEGs (1.13 MB total, from 21.3 MB):
- `ground_albedo.jpg`
- `ground_nr.jpg`: R, G = normal xy, B = roughness. z is reconstructed, the free channel holds roughness, and saving uses 4:4:4. AO was nearly all white (mean 0.98) and was dropped. Displacement is unused because the terrain heightfield provides height.

### `tools/shrink-hdri.py`

The HDRI is only ever baked into a 256 PMREM. Fixed-camera comparisons of 4K, 2K, 1K and 512 inputs all landed around 2.1 against the 4K reference, compared with a 1.16 noise floor from rendering 4K twice. They are indistinguishable. 1K was chosen for headroom: 15.02 MB → 1.42 MB. Downsampling uses an **integer box filter**, because bilinear filtering drops the few-pixel sun, which is hundreds of times brighter than the background, and dims the environment. Box filtering preserves energy exactly (measured mean deviation 0.00005%, from half-float storage).

### Cold-load budget (≈18.5 MB)

```
tree.opt.glb   4.88 MB    pine.opt.glb      1.65 MB
rock1.opt.glb  4.46 MB    winter_lake_1k    1.42 MB
plant.opt.glb  3.63 MB    ground_nr.jpg     0.71 MB
rock2.opt.glb  2.20 MB    ground_albedo.jpg 0.42 MB
code + page + icons  0.15 MB
```

---

## 19. Deployment

It's a static site on Vercel with Framework "Other", an empty build command, and the repo root as output.

- `vercel.json` sets `Cache-Control: public, max-age=31536000, immutable` on `/assets/*`. That means **changing an asset requires renaming it**; returning visitors would otherwise keep the old file for a year. The `.opt.glb` and `_1k.exr` names already carry version meaning.
- **Do not use Git LFS** to get around the 100 MB limit. Vercel doesn't fetch LFS objects by default, so the deploy would serve 130-byte pointer files and the loaders would fail.
- `.gitignore` excludes `assets/*.glb` and then re-includes `!assets/*.opt.glb`. The order matters.
- Linux file names are case-sensitive and Windows' aren't, so "works locally" doesn't guarantee "works deployed".
- On Vercel Hobby's 100 GB/month, the budget is about 5,100 full cold loads.

---

## 20. Performance

The reference machine is an RTX 5090 at 1600×900. It holds a steady 60 FPS, including after walking 270 m out.

| Part | Cost |
|---|---|
| Compute (3 × 200k-cell levels, ray-marched lighting, ~100k particles) | **0.60–0.70 ms**. The single-level 200k-cell version was 0.07–0.21 ms; 3× the cells plus refresh and cross-level coupling lands where expected |
| Typical frame | about 1,000 draw calls, about 4.2 M triangles, of which about 2.5 M are the three clipmap meshes |
| Sculpture remesh | at most 5 ms CPU per frame, budgeted |

**The render timestamps are not trustworthy.** In headless Chrome, the same configuration jumps between 2 and 12 ms and barely scales with resolution, which suggests presentation wait is included. Use draw calls and triangle counts, which are deterministic, to judge optimizations, and a GPU frame capture in a windowed browser for real costs.

**Approximate GPU memory:**

| Item | Size |
|---|---|
| Per clipmap level (5×f32 + vec4 + vec2, ×200,704 cells) | ~8.8 MB, ×3 |
| Deformation stash + tags | 33.5 + 16.8 MB |
| Terrain buffer | 16.8 MB |
| Shadow cascades | 4 × 2048² |
| Particles | a few MB |

**If it's slow,** disable in order of payoff: **god rays → AO → TAA**, then lower quality or snowfall intensity. The biggest structural knobs are `LEVELS`, `GRID` and `FLAKES` in `config.js`, plus the prop counts in `main.js`.

Quality tiers change the pixel-ratio cap (1.0 / 1.5 / 2.0) and the active-flake multiplier (0.4 / 0.75 / 1.0).

---

## 21. Debugging case studies

These are kept because each one changed a design decision, and most are invisible from reading the final code.

### 21.1 Far-field diamond moiré: the terrain interpolator

After the clipmap landed, the far field showed a diamond cross-hatch. Four guesses were ruled out: wind-ripple normals, drift noise, the sun-march reference height, and the sky-occlusion reference plane. Two measurements found the actual cause:

1. **A 2D FFT of a screenshot** gave a world-space period of **1.0 m**. That's the terrain texel, not the clipmap cell (0.93 m); the two are too close to tell apart by eye.
2. **The pure-Lambert debug probe** measured high-frequency energy of 2.40 against 2.36 for the full render, so the artifact came *entirely* from vertex normals and had nothing to do with the material. Splitting the normal into snow-only and terrain-only gave 0.94 versus **2.45**. Terrain.

The root cause was a **smoothstep-weighted** terrain interpolator. Smoothstep isn't exact for linearly varying fields: it goes slow-fast-slow inside each texel, which adds about 6% periodic ripple to the interpolated gradient, one period per texel. At 90 m, a 1 m texel is about 10 pixels, which is exactly the diamond pattern. Switching to **bilinear** (exact for linear fields, second-order error) cut high-frequency energy from 4.02 to 0.77, a **5.2×** reduction. Precomputed gradients, the Sobel snow normal and the coarse-level light tent filter were kept as well.

> Lesson: never reconstruct a sampled field with weights whose derivative vanishes at the ends. Those weights are for value noise; on a heightmap they quilt the terrain cell by cell.

### 21.2 God rays silently broken for a whole iteration

After CSM was added, every pipeline rebuild logged `Cannot read properties of null (reading 'depthTexture')` twice, and three fell back to a default material. The guesses were CSM init timing, `fade`, and a scene object, and all were wrong. Hiding objects one by one never changed the count, and forcing a global recompile showed zero errors. Pausing on **caught** exceptions (`Debugger.setPauseOnExceptions('caught')`) found the real throw site immediately: `GodraysNode.js:425`, `texture(this._light.shadow.map.depthTexture)`.

`GodraysNode` reads the **sun's own** shadow map, but with CSM the sun's shadow never renders, because each cascade has its own map. So god rays had been broken since CSM was introduced, and it went unnoticed because toggling them changed only **2.3%** of pixels. The fix points `sun.shadow.map`, `.camera` and `.matrix` at cascade index 2 (57–125 m, large enough for near and mid field, and fine for a low-frequency effect). They're object references that CSM updates in place each frame, so assigning them once is enough. This requires one warm-up render before building the pipeline, because cascade maps are allocated during first-render material setup. Afterwards, toggling god rays changed **94%** of pixels and the errors stopped.

> Lesson: break on the throw instead of guessing from source. Four rounds of guessing, one breakpoint.

### 21.3 Peter-panning: depth bias in an orthographic world

Every shadow was offset from its caster. `shadow.bias` applies in **normalized depth**, so for an orthographic shadow camera the world-space offset is `bias × (far − near)`. CSM sets only left/right/top/bottom and **inherits near/far** from the template, which had `far = 1400`:

```
cascade 0   −0.0006 × 1399 = −0.84 m
cascade 3   −0.0024 × 1399 = −3.36 m   (CSM also scales bias by cascade+1)
```

The fix: depth bias 0 everywhere, and only `normalBias`, which is in world metres and independent of depth range and cascade index, set per cascade at about 1.8× texel size. `far` was also tightened to 800 and `lightMargin` to 150. Verified at dawn and dusk sun angles with no acne.

### 21.4 Horizontal stripes were AO, not shadows

| Configuration | Stripe energy |
|---|---|
| Shadows on | 2.02 |
| Shadows off | 2.25 (not shadows) |
| Shadows on, AO off | **0.37** |

GTAO's 0.45 m radius projected to less than a pixel beyond 100 m, and at half resolution with temporal filtering it degenerated into stripes. A radius sweep gave 0.45 → 2.01, 0.80 → 0.55, 1.10 → 0.44 (AO-off floor 0.36). 1.1 m was chosen, which also suits "rock pressed into snow" better. A distance fade-out of AO was also tried and measured **no improvement** (2.02 → 2.06), so it was deleted.

> Lesson: a fix that sounds right but doesn't measure doesn't stay in the code.

### 21.5 Detail fade by pixel footprint, not distance

Distance-based ripple fading (12 → 55 m) left the lower half of the frame dead white when looking down from height: at the same 40 m, top-down and grazing views differ about 10× in footprint. `fwidth(positionWorld.xz)` accounts for resolution, FOV and grazing angle together (§9.2).

### 21.6 Two bugs exposed by the soil texture

Replacing the constant dark-gray "ground" with real PBR soil exposed two bugs:
- **SSS without cover:** bare soil glowed, because "thin snow" was maximal at zero depth.
- **Clear only cleared L0:** L1 and L2 ignored `snowProgress` and snapped straight back to full depth, so pressing C left a 26 m bare square with a straight edge. At boot it was the reverse: bare near, full far.

### 21.7 Props "floating" in screenshots

Several rounds were spent on what looked like floating rocks. On steep slopes with a close camera, nearby ground falls away fast and contact *looks* like a gap. A compute shader that read GPU `terrainSample` back for comparison against CPU `terrainY` (12 of 12 points identical) confirmed that the terrain matched and the real problem was placement (§13.7).

> Lesson: you can't judge contact by eye on a steep slope; you have to measure it.

---

## 22. Known limitations

- **No ray tracing.** WebGPU has no ray queries or acceleration structures yet. "Ray marching" here means heightfield self-shadowing and occlusion, plus screen-space GTAO and god rays.
- **Single-bounce indirect.** IBL from sky or HDRI only, with no object-to-object GI.
- **SSS is an analytic approximation.** Path length is estimated from depth, density and cavity, with no screen-space lateral diffusion.
- **Static HDRI.** Its baked-in terrain and clouds don't change with time of day; only the overall tint follows.
- **Screen-space limits.** GTAO and god rays only know what's on screen.
- **TRAA ghosts flakes slightly.** Particles move via storage buffers, and the velocity buffer doesn't know about them.
- **Glints show inside prop shadows.** Sparkle is emissive and evaluated before lighting, so it can't see the shadow map, and the heightfield march only knows snow-on-snow. Capturing `receivedShadowNode` via `toVar` didn't work because of evaluation order. A real fix means moving glints into the BRDF specular term.
- **The sky is keyframed, not a physical atmosphere** (a physical version was tried and rejected).
- **Smoothing races.** The ground smooth gesture reads and writes in place; neighbor races are theoretically present and visually invisible.
- **Single-scatter aerial perspective** with an isotropic multi-scatter floor; no volumetric shadowing (no light shafts from mountains or clouds through haze).
- **Shadows end at 260 m.**
- **Props are scattered once at startup.** There's no chunked streaming; all ~1,949 instance matrices stay resident. An unbounded world would need grid-based load and unload.
- **Interactivity is limited to L0 (26 m).** The stash preserves edits within ±128 m at half resolution. Nothing persists across reloads.
- **The stash never melts.** Only tracks still inside L0 get buried by new snow; tracks left outside stay frozen. A slow global decay pass would fix this.
- **Mean-depth fallback.** Outside readback coverage, the hand uses terrain plus mean depth, so it can be off by a few centimetres at very deep drifts or pits.
- **The terrain is bounded:** 1024 m, flattening within 100 m of the edge, then the unsimulated skirt. You won't see a seam, but there's nothing new out there.
- **Spray doesn't return mass** to the heightfield when it lands.
- **Desktop only.** Touch devices are blocked by design.

---

## 23. Extension points

`window.__snow` exposes the live system for debugging and tinkering:

```js
__snow.params / __snow.U / __snow.refresh() / __snow.applySettings()
__snow.renderer, scene, camera, controls, lights, env, postfx, props, interaction
__snow.fillSnow(depth)
__snow.U.debugMode.value = 6        // pure-Lambert probe (see §9.8)
```

**Loading a model** (gets shadows, pre-pass AO contact and optional snow coating; Draco supported):

```js
await __snow.loadModel('assets/cabin.glb', {
  position: [3, 0, -2], scale: 1.4, rotationY: 0.6,
  center: true,        // snap bounding-box base to y = 0
  snow: true,          // coat up-facing surfaces, keep original maps
  snowAmount: 1.6,     // coverage multiplier (roofs)
  coatBias: 0,         // >0 lets steeper faces hold snow
});

// Many instances, one download and parse, shared geometry and material:
await __snow.loadModel('assets/plant.opt.glb', {
  targetHeight: 0.85,
  instances: [[x, z, rotationY, scaleMul], /* … */],
});
```

For large instance counts, use `batchModel()` (as `main.js` does) to get BatchedMesh, LODs, crossfades and slope-aware grounding.

**Adding a mold:** write an SDF in normalized units in `molds.js` (base at y = 0, face −x, use `smin` for joins and `carve` for holes), add an entry to `MOLDS` with `foot`, `top` and `bounds`, and add an i18n key. The footprint atlas, voxel field cache, ghost preview and merge logic all pick it up automatically.

**Swapping the HDRI:** change `HDRI_URL` in `main.js`. Both `.exr` and `.hdr` are supported, and sun alignment and tinting are automatic.
