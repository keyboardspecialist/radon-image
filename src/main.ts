import './style.css';
import { loadCore, makePhantom, type Core } from './wasm';
import { Renderer, type Result, type LineStyle } from './renderer';
import { MusicControls, musicMarkup } from './music';

const icons = {
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>',
  play: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="m7 4 9 6-9 6z"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 16V4m-4 4 4-4 4 4M5 15v5h14v-5"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 4v12m-4-4 4 4 4-4M5 16v4h14v-4"/></svg>',
  grid: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3" y="3" width="14" height="14" rx="1"/><path d="M3 10h14M10 3v14"/></svg>',
};

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="topbar">
    <a class="brand" href="./" aria-label="Radon home"><span class="brand-mark">r<span>·</span></span>radon<span class="brand-divider"></span><span class="brand-caption">PROJECTION LAB</span></a>
    <div class="topbar-right"><span class="version">EXPERIMENT 001</span><button class="text-button" id="guide-toggle" aria-expanded="false">How it works <span>↗</span></button></div>
  </header>

  <main>
    <section class="intro">
      <div><div class="eyebrow"><span class="tiny-cross">+</span> A DIFFERENT ANGLE ON IMAGES</div><h1>Small regions. <span>One reconstructed image.</span></h1><p>Image → local Radon transforms → merged projections → reconstructed image.</p></div>
      <div class="engine-badge"><span class="status-dot" id="engine-dot"></span><span id="engine-status">Connecting to GPU</span><span class="badge-separator">/</span><span>WASM + WEBGPU</span></div>
    </section>

    <div id="error" class="error" role="alert" hidden></div>

    <section class="guide" id="guide" hidden>
      <div><span class="step-number">01</span><h3>Project the leaves</h3><p>Split the image into square tiles. A fragment shader integrates rays through each tile at every angle, producing a mini sinogram.</p></div>
      <div><span class="step-number">02</span><h3>Shift, then sum</h3><p>Four child tiles become one parent. Shift each child projection by its center’s dot product with the ray normal, interpolate, and add.</p></div>
      <div><span class="step-number">03</span><h3>Repeat to the root</h3><p>Repeat the 2 × 2 merge until one sinogram describes the entire image. Select any stage below to inspect its local transforms.</p></div>
      <div><span class="step-number">04</span><h3>Reconstruct the image</h3><p>Apply a Ram–Lak ramp filter to each root projection, then backproject across all angles. The inverse shaders read only the transforms, never the source image.</p></div>
      <code>R<sub>parent</sub>(θ, s) = Σ R<sub>child</sub>(θ, s − Δx cos θ − Δy sin θ)</code>
      <p class="guide-note">WebAssembly rasterizes the phantom and plans geometry. Projection, merge, filtering, and reconstruction all use fragment-render passes into float32 textures. This is approximate filtered backprojection: limited angles, quadrature, and repeated interpolation cause blur and ringing. Reconstruction is shown at the original intensity scale, without min/max normalization.</p>
    </section>

    <section class="workspace" aria-label="Transform workspace">
      <div class="comparison" aria-label="Reconstruction and sinogram comparison">
      <article class="panel output-panel">
        <div class="panel-header"><h2><span class="panel-number">02</span> <span id="output-title">Reconstructed image</span></h2><span class="tag" id="output-tag">FILTERED BACKPROJECTION</span></div>
        <div class="output-toolbar"><span class="header-note">FROM ROOT PROJECTIONS</span><button id="save-image" class="text-button" title="Save the original, unstylized reconstruction at source resolution" disabled>${icons.download} Save image</button></div>
        <div class="reconstruction-frame"><div class="reconstruction-stage"><canvas id="reconstruction" aria-label="Image reconstructed from the root Radon transform"></canvas><div id="loading" class="loading"><span class="spinner"></span><span id="loading-text">Preparing the renderer</span></div></div></div>
        <div class="panel-footer"><span id="output-dim">Reconstructing from projections…</span><span id="image-readout">SOURCE INTENSITY SCALE</span></div>
      </article>

      <article class="panel sinogram-panel">
        <div class="panel-header"><h2><span class="panel-number">03</span> <span id="sinogram-title">Full sinogram</span></h2><span class="tag" id="sinogram-tag">ROOT LEVEL</span></div>
        <div class="output-toolbar"><span class="header-note">ANGLE × DETECTOR</span><button id="root-level" class="text-button" disabled>Full transform ↗</button></div>
        <div class="sinogram-frame"><div class="axis-y"><span>−ρ</span><span>DETECTOR POSITION</span><span>+ρ</span></div><div class="sinogram-stage" id="sinogram-stage"><canvas id="sinogram" aria-label="Radon transform sinogram; horizontal axis is projection angle, vertical axis is detector position"></canvas><div id="crosshair" class="crosshair" hidden></div><div id="sinogram-loading" class="loading"><span class="spinner"></span><span>Preparing projections</span></div></div><div class="axis-x"><span>0°</span><span>PROJECTION ANGLE θ</span><span>180°</span></div></div>
        <div class="panel-footer"><span id="sinogram-dim">— detectors × — angles</span><span id="hover-readout">HOVER TO EXPLORE</span></div>
      </article>

      <div class="projection-style" id="projection-style">
        <div class="projection-style-heading"><label id="lines-label" for="lines-toggle">Build image from coarse rays</label><button id="lines-toggle" class="switch" role="switch" aria-labelledby="lines-label" aria-checked="false" aria-controls="line-controls" disabled><span></span></button></div>
        <div id="line-controls" hidden>
          <div class="line-sliders"><div><div class="range-label"><label for="line-directions">Directions</label><output id="line-directions-value">64</output></div><input type="range" id="line-directions" min="2" max="180" step="1" value="64" /></div><div><div class="range-label"><label for="line-count">Rays across image</label><output id="line-count-value">48</output></div><input type="range" id="line-count" min="8" max="128" step="1" value="48" /></div><div><div class="range-label"><label for="line-width">Ray width</label><output id="line-width-value">35%</output></div><input type="range" id="line-width" min="0.1" max="1" step="0.05" value="0.35" /></div></div>
          <p>Only coarse projection rays—no image underneath. Overlaps accumulate density. Saved PNG remains the standard reconstruction.</p>
          ${musicMarkup}
        </div>
      </div>
      </div>

      <aside class="panel settings-panel">
        <div class="panel-header"><h2>Transform settings</h2><span class="settings-symbol">⌘</span></div>
        <div class="settings-content">
          <label class="field-label" for="preset">INPUT</label><select id="preset"><option value="0">Shepp–Logan phantom</option><option value="1">Geometric shapes</option></select>
          <button id="upload" class="upload-button">${icons.upload} Upload image <span>↗</span></button><input id="file" type="file" accept="image/*" hidden />
          <div class="control-divider"></div>
          <label class="field-label" for="resolution">IMAGE RESOLUTION <span>px</span></label><div class="segmented" id="resolution" role="group" aria-label="Image resolution"><button data-value="128">128</button><button data-value="256" class="selected" aria-pressed="true">256</button><button data-value="512">512</button></div>
          <label class="field-label" for="leaf-size">LEAF TILE SIZE <span>px</span></label><select id="leaf-size"><option value="2">2 × 2</option><option value="4">4 × 4</option><option value="8">8 × 8</option><option value="16" selected>16 × 16</option><option value="32">32 × 32</option></select>
          <label class="field-label" for="angles">PROJECTION ANGLES</label><select id="angles"><option value="2">2 angles · 90° steps</option><option value="4">4 angles · 45° steps</option><option value="8">8 angles · 22.5° steps</option><option value="16">16 angles · 11.25° steps</option><option value="32">32 angles · 5.625° steps</option><option value="45">45 angles · 4° steps</option><option value="60">60 angles · 3° steps</option><option value="90">90 angles · 2° steps</option><option value="180" selected>180 angles · 1° steps</option><option value="360">360 angles · 0.5° steps</option></select>
          <div class="control-divider"></div>
          <div class="display-heading">SINOGRAM DISPLAY <span>does not recompute</span></div>
          <div class="range-label"><label for="gain">Exposure</label><output id="gain-value">4.0×</output></div><input type="range" id="gain" min="0.5" max="10" step="0.1" value="4" />
          <div class="color-row"><span>Color mapping</span><button id="color-toggle" class="switch" role="switch" aria-label="Color mapping" aria-checked="true"><span></span></button></div>
          <button id="run" class="run-button" disabled>${icons.play}<span>Reconstruct image</span><kbd>↵</kbd></button>
          <div class="auto-note" id="run-note">Settings apply when you run</div>
        </div>
      </aside>

      <div class="details-row">
      <article class="panel source-panel">
        <div class="panel-header"><h2><span class="panel-number">01</span> Source image</h2><button id="grid-toggle" class="icon-button active" title="Toggle tile grid" aria-label="Toggle tile grid" aria-pressed="true">${icons.grid}</button></div>
        <div class="source-stage"><canvas id="source" width="512" height="512" aria-label="Grayscale source image and tile boundaries"></canvas><span class="canvas-corner top-left"></span><span class="canvas-corner bottom-right"></span><span class="source-label" id="source-label">SHEPP–LOGAN PHANTOM</span></div>
        <div class="panel-footer"><span id="source-dim">256 × 256 px</span><span><span class="small-dot"></span> GRAYSCALE</span></div>
      </article>
      <article class="panel pyramid-panel"><div class="panel-header"><h2><span class="panel-number">04</span> The merge pyramid</h2><span class="header-note">SELECT A LEVEL TO INSPECT</span></div><div class="pyramid" id="pyramid"></div><div class="pyramid-footer"><span><span class="legend-square"></span> local sinogram</span><span>4 children ${icons.arrow} 1 parent</span><span id="pass-count">5 render passes</span></div></article>
      </div>
    </section>

    <section class="metrics" aria-label="Transform statistics"><div><span class="metric-label">ROUND-TRIP TIME</span><strong id="metric-time">—<small> ms</small></strong><span class="metric-note">Forward + filter + backprojection</span></div><div><span class="metric-label">LEAF REGIONS</span><strong id="metric-leaves">—</strong><span class="metric-note" id="metric-leaf-note">Independent local projections</span></div><div><span class="metric-label">MERGE STAGES</span><strong id="metric-merges">—</strong><span class="metric-note">Bottom-up · 2 × 2 reduction</span></div><div><span class="metric-label">TEXTURE MEMORY</span><strong id="metric-memory">—<small> MiB</small></strong><span class="metric-note">Pyramid + inverse textures</span></div><button id="export" class="export-button" disabled>${icons.download}<span>Export sinogram<small>Raw float32 + metadata</small></span>${icons.arrow}</button></section>

    <footer class="page-footer"><span><span class="footer-mark">r·</span> Built one projection at a time.</span><span id="adapter-name">LOCAL COMPUTATION · NO UPLOADS</span><span class="footer-tech">WASM <span>×</span> WGSL <span>×</span> WEBGPU</span></footer>
  </main>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sourceCanvas = $<HTMLCanvasElement>('source');
const outputCanvas = $<HTMLCanvasElement>('reconstruction');
const sinogramCanvas = $<HTMLCanvasElement>('sinogram');
const sourceContext = sourceCanvas.getContext('2d')!;
const sourceImage = document.createElement('canvas');
const sourceImageContext = sourceImage.getContext('2d')!;
let core: Core;
let renderer: Renderer;
let result: Result | undefined;
let selectedLevel = 0;
const lineStyle: LineStyle = { enabled: false, directions: 64, rays: 48, width: 0.35 };
let reconstructionPixels: Float32Array | undefined;
let qualityLabel = 'SOURCE INTENSITY SCALE';
let resolution = 256;
let gain = 4;
let color = true;
let grid = true;
let busy = false;
let ready = false;
let uploaded: ImageBitmap | undefined;
let uploadName = '';
let hovered: { x: number; y: number } | undefined;
const music = new MusicControls($('music-controls'), drawReconstruction);

function inspectCoordinates() {
  if (!result || !hovered) return;
  const level = result.levels[selectedLevel];
  const tx = Math.min(level.grid - 1, Math.floor(hovered.x * level.grid));
  const ty = Math.min(level.grid - 1, Math.floor(hovered.y * level.grid));
  const gap = level.grid > 1 ? 0.018 : 0;
  const u = Math.max(0, Math.min(0.99999, (hovered.x * level.grid - tx - gap) / (1 - 2 * gap)));
  const v = Math.max(0, Math.min(0.99999, (hovered.y * level.grid - ty - gap) / (1 - 2 * gap)));
  return { tx, ty, theta: Math.floor(u * result.angles) * Math.PI / result.angles, rho: Math.floor(v * level.bins) - (level.bins - 1) * 0.5 };
}

function showError(message: string) {
  $('error').textContent = message;
  $('error').hidden = false;
}

function drawSource() {
  const size = sourceCanvas.width;
  sourceContext.clearRect(0, 0, size, size);
  sourceContext.drawImage(sourceImage, 0, 0, size, size);
  const level = result?.levels[selectedLevel];
  const cells = level?.grid ?? 1;
  const tile = size / cells;
  if (grid && cells > 1) {
    sourceContext.strokeStyle = 'rgba(169, 218, 156, 0.35)';
    sourceContext.lineWidth = 1;
    sourceContext.beginPath();
    for (let i = 1; i < cells; i++) {
      sourceContext.moveTo(i * tile, 0); sourceContext.lineTo(i * tile, size);
      sourceContext.moveTo(0, i * tile); sourceContext.lineTo(size, i * tile);
    }
    sourceContext.stroke();
  }
  if (hovered && level) {
    const { tx, ty, theta, rho: detector } = inspectCoordinates()!;
    const rho = detector * size / result!.size;
    const cx = (tx + 0.5) * tile, cy = (ty + 0.5) * tile;
    sourceContext.save();
    sourceContext.strokeStyle = '#c4eca3'; sourceContext.lineWidth = 2;
    sourceContext.strokeRect(tx * tile + 1, ty * tile + 1, tile - 2, tile - 2);
    sourceContext.beginPath(); sourceContext.rect(tx * tile, ty * tile, tile, tile); sourceContext.clip();
    const x = cx + rho * Math.cos(theta), y = cy + rho * Math.sin(theta);
    sourceContext.beginPath();
    sourceContext.moveTo(x + Math.sin(theta) * size * 2, y - Math.cos(theta) * size * 2);
    sourceContext.lineTo(x - Math.sin(theta) * size * 2, y + Math.cos(theta) * size * 2);
    sourceContext.stroke(); sourceContext.restore();
  }
}

function redraw() {
  drawReconstruction();
  drawSinogram();
  drawSource();
}

function drawReconstruction() {
  if (!result || !ready || busy) return;
  const style = music.modulate(lineStyle, result.angles);
  for (const [key, id, value] of [
    ['directions', 'line-directions', String(style.directions)],
    ['rays', 'line-count', String(style.rays)],
    ['width', 'line-width', `${Math.round(style.width * 100)}%`],
  ] as const) {
    const slider = $<HTMLInputElement>(id);
    // Do not move a handle under the user's pointer while setting a base value.
    if (document.activeElement !== slider) slider.value = String(style[key]);
    slider.title = `Resting value: ${key === 'width' ? `${Math.round(lineStyle[key] * 100)}%` : lineStyle[key]}`;
    $(`${id}-value`).textContent = value;
  }
  $('image-readout').textContent = imageReadout(style);
  renderer.draw(result.levels.length - 1, gain, color, 'reconstruction', style);
}

function drawSinogram() {
  if (result && ready) renderer.draw(selectedLevel, gain, color, 'sinogram', undefined, sinogramCanvas);
}

function updateReconstruction() {
  if (!result) return;
  music.setActive(lineStyle.enabled && ready && !busy);
  $('line-controls').hidden = !lineStyle.enabled;
  $('output-tag').textContent = lineStyle.enabled ? 'RAY DENSITY' : 'FILTERED BACKPROJECTION';
  $('output-dim').textContent = `${result.size} × ${result.size} px · from root projections`;
  $('image-readout').textContent = imageReadout();
  $('image-readout').title = lineStyle.enabled ? 'Coarse filtered projection rays alone accumulate image density. No reconstructed-image texture is bound. The standard reconstruction and exports are unchanged.' : 'PSNR compares raw float32 reconstruction with the source, using peak intensity 1. No fitted scaling or normalization.';
  outputCanvas.setAttribute('aria-label', lineStyle.enabled ? 'Image formed entirely from overlapping coarse projection rays' : 'Image reconstructed from the root Radon transform');
  drawReconstruction();
}

function selectLevel(index: number) {
  if (!result) return;
  selectedLevel = index;
  hovered = undefined;
  $('crosshair').hidden = true;
  const level = result.levels[index];
  const final = index === result.levels.length - 1;
  $('sinogram-title').textContent = final ? 'Full sinogram' : 'Local sinograms';
  $('sinogram-tag').textContent = final ? 'ROOT LEVEL' : `LEVEL ${index} · ${level.grid} × ${level.grid}`;
  $('sinogram-dim').textContent = `${level.bins} detectors × ${result.angles} angles${final ? '' : ` · ${level.grid ** 2} tiles`}`;
  $('hover-readout').textContent = 'HOVER TO EXPLORE';
  document.querySelectorAll<HTMLButtonElement>('.level').forEach((button, i) => {
    button.classList.toggle('selected', i === index);
    button.setAttribute('aria-pressed', String(i === index));
  });
  redraw();
}

function imageReadout(style = lineStyle) {
  return style.enabled ? `${Math.min(style.directions, result?.angles ?? style.directions)} DIRECTIONS · RAYS ONLY` : qualityLabel;
}

function buildPyramid() {
  if (!result) return;
  $('pyramid').innerHTML = result.levels.map(level => {
    const visibleGrid = Math.min(level.grid, 4);
    return `${level.index ? `<span class="merge-arrow">${icons.arrow}</span>` : ''}<button class="level" data-level="${level.index}" aria-pressed="false" aria-label="Level ${level.index}: ${level.grid ** 2} regions of ${level.tile} by ${level.tile} pixels"><span class="level-top">L${level.index}<span>${level.index === 0 ? 'LEAF' : level.grid === 1 ? 'ROOT' : 'MERGE'}</span></span><span class="mini-grid" style="--cells:${visibleGrid}">${'<i></i>'.repeat(visibleGrid ** 2)}</span><strong>${level.grid} × ${level.grid}</strong><span class="level-size">${level.tile} × ${level.tile} px</span></button>`;
  }).join('');
  $('pyramid').querySelectorAll<HTMLButtonElement>('.level').forEach(button => button.addEventListener('click', () => selectLevel(Number(button.dataset.level))));
  $('pass-count').textContent = `${result.levels.length} forward + 2 inverse passes`;
}

function preparePixels(size: number): Uint8ClampedArray {
  if ($<HTMLSelectElement>('preset').value === 'upload' && uploaded) {
    const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'black'; context.fillRect(0, 0, size, size);
    const scale = Math.min(size / uploaded.width, size / uploaded.height);
    const w = uploaded.width * scale, h = uploaded.height * scale;
    context.drawImage(uploaded, (size - w) / 2, (size - h) / 2, w, h);
    const image = context.getImageData(0, 0, size, size);
    for (let i = 0; i < image.data.length; i += 4) {
      const value = Math.round(0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2]);
      image.data[i] = value; image.data[i + 1] = value; image.data[i + 2] = value; image.data[i + 3] = 255;
    }
    return image.data;
  }
  return makePhantom(core, size, Number($<HTMLSelectElement>('preset').value));
}

async function run() {
  if (!ready || busy) return;
  busy = true;
  music.setActive(false);
  $('error').hidden = true;
  $('loading').hidden = false;
  $('sinogram-loading').hidden = false;
  $('loading-text').textContent = 'Projecting, merging, reconstructing';
  $<HTMLButtonElement>('run').disabled = true;
  $<HTMLButtonElement>('export').disabled = true;
  $<HTMLButtonElement>('save-image').disabled = true;
  $('run').classList.remove('dirty');
  $('run-note').textContent = 'Computing on your GPU…';
  const size = resolution;
  const leaf = Number($<HTMLSelectElement>('leaf-size').value);
  const angles = Number($<HTMLSelectElement>('angles').value);
  // Prevent controls from changing while the displayed source and GPU pyramid
  // are being replaced; display-only controls remain responsive.
  const controls = document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('#preset, #leaf-size, #angles, #resolution button, #upload, #root-level, #lines-toggle, .level');
  controls.forEach(control => control.disabled = true);
  try {
    const pixels = preparePixels(size);
    const next = await renderer.transform(core, pixels, size, leaf, angles);
    reconstructionPixels = await renderer.readReconstruction();
    let squaredError = 0;
    for (let i = 0; i < reconstructionPixels.length; i++) squaredError += (reconstructionPixels[i] - pixels[i * 4] / 255) ** 2;
    const rmse = Math.sqrt(squaredError / reconstructionPixels.length);
    qualityLabel = `PSNR ${rmse === 0 ? '∞' : (-20 * Math.log10(rmse)).toFixed(1)} dB`;
    result = next;
    const directionSlider = $<HTMLInputElement>('line-directions');
    directionSlider.max = String(Math.min(180, angles));
    lineStyle.directions = Math.min(lineStyle.directions, angles);
    directionSlider.value = String(lineStyle.directions);
    $('line-directions-value').textContent = String(lineStyle.directions);
    sourceImage.width = size; sourceImage.height = size;
    sourceImageContext.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
    $('source-dim').textContent = `${size} × ${size} px`;
    $('source-label').textContent = $<HTMLSelectElement>('preset').value === 'upload' ? uploadName : Number($<HTMLSelectElement>('preset').value) === 1 ? 'GEOMETRIC SHAPES' : 'SHEPP–LOGAN PHANTOM';
    $('metric-time').innerHTML = `${result.milliseconds.toFixed(1)}<small> ms</small>`;
    $('metric-leaves').textContent = String(result.levels[0].grid ** 2);
    $('metric-leaf-note').textContent = `${leaf} × ${leaf} px per local projection`;
    $('metric-merges').textContent = String(result.levels.length - 1);
    $('metric-memory').innerHTML = `${(result.bytes / 2 ** 20).toFixed(2)}<small> MiB</small>`;
    buildPyramid(); updateReconstruction(); selectLevel(result.levels.length - 1);
    $('run-note').textContent = 'Reconstructed from the merged transform';
  } catch (error) { showError(error instanceof Error ? error.message : String(error)); $('run-note').textContent = 'Could not compute this transform'; }
  finally {
    busy = false;
    $('loading').hidden = true;
    $('sinogram-loading').hidden = true;
    $<HTMLButtonElement>('run').disabled = !ready;
    $<HTMLButtonElement>('export').disabled = !result || !ready;
    $<HTMLButtonElement>('save-image').disabled = !result || !ready;
    controls.forEach(control => control.disabled = false);
    music.setActive(lineStyle.enabled && ready);
    drawReconstruction();
  }
}

function markDirty() { $('run').classList.add('dirty'); $('run-note').textContent = 'Settings changed · run to update'; }
$('resolution').querySelectorAll<HTMLButtonElement>('button').forEach(button => {
  button.setAttribute('aria-pressed', String(Number(button.dataset.value) === resolution));
  button.addEventListener('click', () => {
    resolution = Number(button.dataset.value);
    $('resolution').querySelectorAll('button').forEach(b => { b.classList.toggle('selected', b === button); b.setAttribute('aria-pressed', String(b === button)); });
    markDirty();
  });
});
['preset', 'leaf-size', 'angles'].forEach(id => $(id).addEventListener('change', markDirty));
$('run').addEventListener('click', run);
$('root-level').addEventListener('click', () => { if (result) selectLevel(result.levels.length - 1); });
$('lines-toggle').addEventListener('click', () => {
  if (!ready || !result) return;
  lineStyle.enabled = !lineStyle.enabled;
  $('lines-toggle').setAttribute('aria-checked', String(lineStyle.enabled));
  updateReconstruction();
});
$('line-directions').addEventListener('input', () => {
  if (!ready) return;
  lineStyle.directions = Number($<HTMLInputElement>('line-directions').value);
  drawReconstruction();
});
$('line-count').addEventListener('input', () => {
  if (!ready) return;
  lineStyle.rays = Number($<HTMLInputElement>('line-count').value);
  drawReconstruction();
});
$('line-width').addEventListener('input', () => {
  if (!ready) return;
  lineStyle.width = Number($<HTMLInputElement>('line-width').value);
  drawReconstruction();
});
['line-directions', 'line-count', 'line-width'].forEach(id => $(id).addEventListener('blur', drawReconstruction));
document.addEventListener('keydown', event => {
  const target = event.target as HTMLElement;
  if (event.key === 'Enter' && target === document.body) void run();
});
$('gain').addEventListener('input', () => { gain = Number($<HTMLInputElement>('gain').value); $('gain-value').textContent = `${gain.toFixed(1)}×`; drawSinogram(); });
$('color-toggle').addEventListener('click', () => { color = !color; $('color-toggle').setAttribute('aria-checked', String(color)); drawSinogram(); });
$('grid-toggle').addEventListener('click', () => { grid = !grid; $('grid-toggle').setAttribute('aria-pressed', String(grid)); $('grid-toggle').classList.toggle('active', grid); drawSource(); });
$('guide-toggle').addEventListener('click', () => { $('guide').hidden = !$('guide').hidden; $('guide-toggle').setAttribute('aria-expanded', String(!$('guide').hidden)); });
$('upload').addEventListener('click', () => $<HTMLInputElement>('file').click());
$('file').addEventListener('change', async () => {
  const file = $<HTMLInputElement>('file').files?.[0];
  if (!file) return;
  try {
    const bitmap = await createImageBitmap(file);
    uploaded?.close(); uploaded = bitmap; uploadName = file.name;
    const select = $<HTMLSelectElement>('preset');
    let option = select.querySelector<HTMLOptionElement>('option[value="upload"]');
    if (!option) { option = document.createElement('option'); option.value = 'upload'; select.append(option); }
    option.textContent = file.name; select.value = 'upload'; markDirty();
  } catch { showError('That image could not be decoded. Try a PNG, JPEG, or WebP file.'); }
  $<HTMLInputElement>('file').value = '';
});

$('sinogram-stage').addEventListener('pointermove', event => {
  if (!result || busy) return;
  const rect = sinogramCanvas.getBoundingClientRect();
  hovered = { x: Math.max(0, Math.min(0.99999, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(0.99999, (event.clientY - rect.top) / rect.height)) };
  const { theta, rho } = inspectCoordinates()!;
  $('hover-readout').textContent = `θ ${(theta * 180 / Math.PI).toFixed(1)}° · ρ ${rho.toFixed(1)}`;
  const cursor = $('crosshair'); cursor.hidden = false; cursor.style.left = `${hovered.x * 100}%`; cursor.style.top = `${hovered.y * 100}%`;
  drawSource();
});
$('sinogram-stage').addEventListener('pointerleave', () => { hovered = undefined; $('crosshair').hidden = true; $('hover-readout').textContent = 'HOVER TO EXPLORE'; drawSource(); });

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  // Keep the URL alive until the browser has consumed the download navigation.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

$('save-image').addEventListener('click', () => {
  if (!result || !reconstructionPixels || busy) return;
  const size = result.size;
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(size, size);
  for (let i = 0; i < reconstructionPixels.length; i++) {
    const value = Math.round(Math.max(0, Math.min(1, reconstructionPixels[i])) * 255);
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = value;
    image.data[i * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  canvas.toBlob(blob => {
    if (blob) download(blob, `radon-${size}-reconstructed.png`);
    else showError('Could not encode the reconstructed image as PNG.');
  }, 'image/png');
});

$('export').addEventListener('click', async () => {
  if (!result || busy) return;
  const button = $<HTMLButtonElement>('export'); button.disabled = true;
  const snapshot = result;
  const levelIndex = selectedLevel;
  try {
    const level = snapshot.levels[levelIndex];
    const floats = await renderer.readLevel(levelIndex);
    // Single portable file avoids browsers blocking multiple automatic downloads.
    const metadata = {
      format: 'radon-f32-v1', dtype: 'float32', byteOrder: 'little-endian',
      imageSize: snapshot.size, level: levelIndex, tileSize: level.tile, grid: level.grid,
      detectors: level.bins, angles: snapshot.angles, width: level.width, height: level.height,
      atlasColumns: level.columns,
      detectorSpacing: 1, detectorOrigin: -(level.bins - 1) / 2,
      angleStart: 0, angleStep: Math.PI / snapshot.angles, angleUnit: 'radians',
      layout: 'row-major tiles: tileIndex = tileY * grid + tileX; x = (tileIndex % atlasColumns) * detectors + detector; y = floor(tileIndex / atlasColumns) * angles + angle',
      values: 'Unnormalized line integrals of [0, 1] source intensity in source-pixel units',
      payload: 'After the first newline, raw little-endian float32 values follow',
    };
    const header = JSON.stringify(metadata) + '\n';
    const payload = new ArrayBuffer(floats.length * 4);
    const view = new DataView(payload);
    floats.forEach((value, index) => view.setFloat32(index * 4, value, true));
    download(new Blob([header, payload], { type: 'application/octet-stream' }), `radon-${snapshot.size}-level-${levelIndex}.radon`);
  } catch (error) { showError(`Export failed: ${String(error)}`); }
  finally { button.disabled = busy || !ready; }
});

const resizeObserver = new ResizeObserver(entries => {
  for (const entry of entries) {
    if (entry.target === outputCanvas) drawReconstruction();
    if (entry.target === sinogramCanvas) drawSinogram();
  }
});
resizeObserver.observe(outputCanvas);
resizeObserver.observe(sinogramCanvas);

async function initialize() {
  try {
    core = await loadCore();
    const preview = makePhantom(core, 256, 0);
    sourceImage.width = 256; sourceImage.height = 256;
    sourceImageContext.putImageData(new ImageData(preview as Uint8ClampedArray<ArrayBuffer>, 256, 256), 0, 0); drawSource();
    renderer = new Renderer(outputCanvas, message => {
      ready = false; music.setActive(false); showError(message); $<HTMLButtonElement>('run').disabled = true; $<HTMLButtonElement>('export').disabled = true; $<HTMLButtonElement>('save-image').disabled = true; $('engine-status').textContent = 'GPU disconnected'; $('engine-dot').classList.add('failed');
    });
    await renderer.initialize();
    renderer.attachCanvas(sinogramCanvas);
    ready = true;
    $('engine-status').textContent = 'GPU connected'; $('engine-dot').classList.add('connected');
    $('adapter-name').textContent = renderer.adapterName.toUpperCase();
    await run();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    $('loading').hidden = true; $('sinogram-loading').hidden = true; $('engine-status').textContent = 'GPU unavailable'; $('engine-dot').classList.add('failed');
    $('run-note').textContent = 'A WebGPU-capable browser is required';
  }
}
void initialize();
