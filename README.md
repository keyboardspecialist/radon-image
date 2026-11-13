# Radon · projection lab

A greenfield WebAssembly + WebGPU renderer that **reconstructs an image from hierarchical Radon transforms**. Tile-local sinograms are built in a fragment shader, merged **2 × 2 → 1**, then inverted using **Ram–Lak filtered backprojection**. Projection, merge, filtering, and reconstruction all run in fragment shaders. No compute shaders, framework, server-side processing, or remote image uploads.

## Run

Requires Node.js 22.12+ (or 20.19+) and a WebGPU-capable browser. Chrome or Edge with hardware acceleration enabled is a good starting point.

```sh
npm install
npm run dev
```

Open **http://localhost:5173**. The dev command compiles the AssemblyScript core to WebAssembly automatically; Rust and Emscripten are not required.

```sh
npm run build       # WASM + TypeScript validation + production bundle
npm run preview     # serve the production bundle
npm test            # WASM/geometry and audio-analysis tests

npx playwright install chromium
npm run test:browser # real GPU numerical checks and browser interaction tests
```

To run browser tests against an installed Chrome instead:

```sh
PLAYWRIGHT_CHANNEL=chrome npm run test:browser
```

WebGPU requires a **secure context**: localhost or HTTPS. Plain HTTP on a LAN IP will generally not work. The page reports unsupported adapters and device errors instead of silently falling back to a different algorithm. Fonts and WASM are bundled locally.

## Explore

- Start with the modified Shepp–Logan phantom, geometric shapes, or a local image.
- Choose 128/256/512 px and **2/4/8/16/32 px leaf tiles**; click **Reconstruct image** to apply.
- Projection counts are **2, 4, 8, 16, 32, 45, 60, 90, 180, or 360**, uniformly covering `[0°, 180°)`. Low counts deliberately expose sparse-view bands and streaks rather than a smooth reconstruction.
- The reconstructed image and sinogram are shown **side by side**, with a source preview below. On narrow screens they stack vertically. The inverse reads the merged root sinogram, not the source image.
- Toggle **Build image from coarse rays** to form the picture entirely from overlapping projection bands, with no image layer underneath. Adjust **Directions** (2–180, capped by available angles), **Rays across image** (8–128), and **Ray width** (10–100% of ray spacing). Fewer rays produce coarser structure; more directions add overlaps and detail. Turning it off restores the standard reconstruction. These controls affect only the reconstructed-image panel.
- Click a pyramid level to inspect local transforms in the sinogram panel. The source grid follows the selected level, while the reconstructed image continues to show the full root reconstruction. **Full transform ↗** returns the sinogram to the root without changing coarse-ray settings.
- Hover a sinogram to see the corresponding ray clipped to its source region.
- Exposure and color controls are always available and affect only sinogram presentation. They never affect the reconstructed image, inverse, or raw data.
- **Save image** downloads a grayscale PNG of the reconstructed pixels at source resolution, without overlays or min/max normalization.
- Coarse-ray mode does not change saved standard PNGs, raw data, or the standard reconstruction. Its footer says **RAYS ONLY**, rather than presenting the standard image’s PSNR as a measurement of the coarse-ray result.
- Inside coarse-ray controls, enable **Music reactive**, **Load music**, then press **Play**. Tracks stay local and play through Web Audio. Each coarse-ray parameter can follow **bass**, **mids**, **treble**, **overall energy**, or **beat pulses**, or stay **Manual**. Set a signed **Amount** to add/subtract a percentage of the slider’s range; results are clamped to its limits (including the available projection angles). The sliders show live values during playback; adjusting one sets its resting value. Pausing, ending the track, or disabling reactivity restores those values. Turning coarse rays off stops animation but lets the track keep playing.
- **Export sinogram** saves any selected level as raw float32 integrals with a metadata header.

Images are aspect-fit into a black square and converted to grayscale. Uploaded image values use weighted sRGB channel values, without inverse-gamma conversion. Source pixel intensities are normalized to [0, 1].

## Algorithm

Use image coordinates with **x right, y down**, tile-local origin at the tile center, and

```text
n(θ) = (cos θ, sin θ)
R(θ, s) = ∫ f(s n(θ) + t (−sin θ, cos θ)) dt
```

Angles sample `[0, π)` without duplicating the endpoint. Detector samples are spaced one source pixel apart and centered around zero. Even detector counts put samples on half-integer offsets, matching pixel centers at axis-aligned angles. Each local detector domain covers the tile diagonal plus interpolation guard bins.

### 1. Leaf fragment pass

Each output fragment corresponds to one `(tile, angle, detector)` ray. Intersect the ray with the tile’s square, then integrate using midpoint quadrature with at most **0.5 source pixels per step**. Source reconstruction is bilinear, clamped to that leaf’s pixel centers; reads do not borrow energy from neighboring leaves.

### 2. Merge fragment passes

For each child, let `Δ` be its center relative to its parent’s center. Then:

```text
Rparent(θ, s) = Σchild Rchild(θ, s − Δ · n(θ))
```

The four offsets are `(±parentSize/4, ±parentSize/4)`. Each fragment manually linearly interpolates two child detector samples, sums the four translated projections, and writes one `r32float` texel. Children outside their detector domain contribute zero. There is no reprojection of the source at higher levels.

### 3. Repeat

Halve the tile grid in each dimension until the root covers the entire image. A 256 px image with 16 px leaves creates grids of **16² → 8² → 4² → 2² → 1**, requiring five projection render passes. All levels are retained for inspection.

### 4. Filter the root sinogram

Convolve each detector row with the discrete **Ram–Lak ramp filter** at unit detector spacing:

```text
h[0] = 1/4
h[k] = −1/(π k)² for odd k; 0 for nonzero even k
Q(θ, s) = (h * Rroot)(θ, s)
```

The fragment pass uses zero extension outside the detector domain, not circular convolution. The filtered sinogram stays signed and float32; clamping it would destroy the inverse.

### 5. Backproject into an image

For each output pixel center `x`, a fragment integrates all filtered projection angles, with linear detector interpolation:

```text
f̂(x) = (π / angleCount) Σθ Q(θ, x · n(θ))
```

The inverse bind groups contain only transform textures and geometry uniforms: **neither inverse pass can read the source image**. The result is a full-resolution `r32float` image. The source GPU texture is released after completion; the reconstruction and filtered root sinogram are retained independently. No min/max normalization or fitted intensity rescaling is applied. Only presentation and PNG export clamp pixel values to `[0, 1]`; `Renderer.readReconstruction()` returns the original signed float32 values.

**This is an approximate numerical round trip, not lossless encoding.** Repeated detector interpolation introduces smoothing; quadrature and finite angles cause blur, ringing, and streak artifacts. The forward GPU test on a uniform 64 px square with 8 px leaves measures roughly 1% relative RMS difference versus a direct full-image fragment pass, with less than 2% worst-angle mass error. A separate asymmetric two-Gaussian reconstruction test checks orientation, intensity gain, finite outputs, and error; zero-input and inverse linearity checks also run on the GPU. These are test-case checks, not universal error guarantees.

The viewer reports **PSNR** against the source using raw reconstructed float values and peak intensity 1. This comparison does not modify the reconstruction. The default 256 px Shepp–Logan phantom with 16 px leaves and 180 angles measures approximately 26.7 dB; sharp boundaries lose detail more readily than smooth structures.

### Optional coarse-ray reconstruction

A separate fragment shader box-averages groups of filtered detector bins into coarse projection samples. Each sample is backprojected as a finite-width straight band with a constant coefficient along its entire length. At every pixel, the shader sums all intersecting bands. The picture—including its shape and detail—comes from this accumulated ray density alone. The shader has **only a filtered-sinogram texture binding**: it cannot read or blend in the reconstructed image or the source. A GPU regression test destroys both the reconstructed-image and original sinogram textures before rendering this mode.

Filtered projection coefficients are signed: positive bands add density, negative bands subtract it, as in filtered backprojection. Density is normalized by angular spacing and beam coverage, then mapped to grayscale with a fixed exposure. There is no colored weave, glow, image mask, or strength blend. This intentionally coarse inverse introduces banding, crosshatching, and streaks; it is not the standard full-resolution inverse. At 100% ray width the gaps close; narrow rays leave more visible intersections. The shader runs only on redraw, without rerunning forward/filter passes. Music mode requests redraws while a track is playing with reactivity and coarse rays enabled; it stops the animation loop when paused, disabled, hidden, recomputing, or disconnected from the GPU.

### Music analysis

Web Audio's 2048-sample FFT is split into bass (30–250 Hz), mids (250 Hz–4 kHz), and treble (4–16 kHz), averaged in linear power. Overall energy uses time-domain RMS. Band levels have a fast attack and slower release. Beat pulses detect bass onsets above a recent energy floor, with a short cooldown and exponential decay; this is not tempo estimation, source separation, or a beat grid. Playback, seeking, and track replacement reset the detector. Audio is streamed from a local object URL rather than decoding the whole track into memory.

## Implementation

| File | Responsibility |
| --- | --- |
| `assembly/core.ts` | WASM pyramid geometry, child translations, antialiased phantom rasterization |
| `src/wasm.ts` | WASM loading and explicit buffer ownership |
| `src/atlas.ts` | Adaptive atlas packing for small leaves, with GPU texture-limit checks |
| `src/shaders.ts` | WGSL leaf integration, shifted merge, Ram–Lak filter, backprojection, and display |
| `src/renderer.ts` | WebGPU pipelines, atlas and reconstruction textures, render passes, float32 readback |
| `src/main.ts` | Source/reconstruction viewer, image import, PSNR, stage inspection, PNG and sinogram export |
| `src/audio.ts` | FFT band energy, RMS, bass-onset pulses, bounded parameter modulation |
| `src/music.ts` | Local track playback, analysis loop, meters, per-parameter assignments |
| `src/style.css` | Responsive lab interface |
| `tests/core.test.mjs` | WASM geometry, input validation, rasterization, memory reuse |
| `tests/audio.test.mjs` | Frequency bands, silence, attack/release, onset detection, signed modulation bounds |
| `tests/browser/app.spec.ts` | Forward/inverse GPU correctness, interactions, PNG and raw export, import, mobile, missing-WebGPU path |

Both GPU canvases share one device and one set of transform/reconstruction textures. `Renderer.attachCanvas()` attaches an additional view after initialization; `draw()` can target either canvas. Changing a view’s display controls does not rerun the transform or affect the other canvas. Resizing redraws the views at their individual sizes.

Each level uses a 2D atlas. A local sinogram is stored with **detectors along x and angles along y**. Usually atlas columns match the logical image grid. Small leaves can make that atlas too tall, so the layout automatically reflows into more columns while preserving logical row-major tile order. Atlas texels are:

```text
tileIndex = tileY * grid + tileX
x = (tileIndex % atlasColumns) * detectors + detectorIndex
y = floor(tileIndex / atlasColumns) * angles + angleIndex
```

The sinogram display shader transposes each cell so angle reads horizontally and detector position vertically. Local sinogram displays normalize by their region size for visibility; exports and reconstructed images do not. Device texture-size limits are checked before allocating the pyramid.

Smaller leaves increase texture memory substantially. Repacking makes combinations such as 256 px / 2 px leaves / 180 angles possible within the default texture dimension limit, but combinations exceeding total atlas capacity are still rejected with an actionable message.

The round-trip timing readout is wall-clock **queue submission → GPU completion** for forward projection, merging, filtering, and backprojection, not a timestamp-query benchmark. It excludes the subsequent PSNR readback, and can include pending queue work and first-use driver overhead. The memory readout covers retained float32 projection textures **plus the filtered root sinogram and reconstruction**, excluding source and transient resources.

## Export format

A `.radon` file contains one UTF-8 JSON line, terminated by `\n`, followed immediately by packed **little-endian float32** atlas data. Metadata includes image size, level, tile size, logical grid, `atlasColumns`, detector origin/spacing, angles, dimensions, and storage layout. Values are unnormalized line integrals in source-pixel units. For older exports without `atlasColumns`, use `grid` as the atlas column count. Any unused cells at the end of a reflowed atlas contain zeros.

Read in Python:

```python
import json
import numpy as np

with open("radon-256-level-4.radon", "rb") as f:
    meta = json.loads(f.readline())
    atlas = np.frombuffer(f.read(), dtype="<f4").reshape(meta["height"], meta["width"])

# Root atlas: [angle, detector]. Transpose for the same orientation as the viewer.
sinogram = atlas.T
```
