import { test, expect } from '@playwright/test';

test('GPU pyramid, stage inspection, controls, and raw export work end-to-end', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#engine-status')).toBeVisible();
  await expect(page.locator('#loading')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('#engine-status')).toHaveText('GPU connected');
  await expect(page.locator('.level')).toHaveCount(5);
  await expect(page.locator('#metric-leaves')).toHaveText('256');
  await expect(page.locator('#output-title')).toHaveText('Reconstructed image');
  await expect(page.locator('#sinogram-title')).toHaveText('Full sinogram');
  await expect(page.locator('#image-readout')).toContainText('PSNR');
  await expect(page.locator('#gain')).toBeEnabled();
  const imageBox = (await page.locator('#reconstruction').boundingBox())!;
  const sinogramBox = (await page.locator('#sinogram').boundingBox())!;
  expect(sinogramBox.x).toBeGreaterThanOrEqual(imageBox.x + imageBox.width);
  expect(Math.abs(imageBox.y - sinogramBox.y)).toBeLessThan(2);
  expect(Math.abs(imageBox.height - sinogramBox.height)).toBeLessThan(2);
  const imageBefore = await page.locator('#reconstruction').screenshot();
  const sinogramBefore = await page.locator('#sinogram').screenshot();
  await page.locator('#gain').fill('1');
  expect((await page.locator('#reconstruction').screenshot()).equals(imageBefore)).toBe(true);
  expect((await page.locator('#sinogram').screenshot()).equals(sinogramBefore)).toBe(false);
  await page.locator('#gain').fill('4');
  await page.locator('.level').first().click();
  await expect(page.locator('#sinogram-title')).toHaveText('Local sinograms');
  await expect(page.locator('#sinogram-tag')).toHaveText('LEVEL 0 · 16 × 16');
  await expect(page.locator('#output-title')).toHaveText('Reconstructed image');
  expect((await page.locator('#reconstruction').screenshot()).equals(imageBefore)).toBe(true);
  await page.locator('#sinogram').hover({ position: { x: 100, y: 100 } });
  await expect(page.locator('#hover-readout')).toContainText('ρ');
  await expect(page.locator('#image-readout')).toContainText('PSNR');
  await page.locator('#color-toggle').click();
  await expect(page.locator('#color-toggle')).toHaveAttribute('aria-checked', 'false');
  await page.locator('#resolution button[data-value="128"]').click();
  await page.locator('#preset').selectOption('1');
  await page.locator('#leaf-size').selectOption('32');
  await page.locator('#angles').selectOption('90');
  await page.locator('#run').click();
  await expect(page.locator('#run')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('.level')).toHaveCount(3);
  await expect(page.locator('#source-dim')).toHaveText('128 × 128 px');
  await expect(page.locator('#metric-leaves')).toHaveText('16');
  await expect(page.locator('#source-label')).toHaveText('GEOMETRIC SHAPES');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('radon-128-level-2.radon');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const file = Buffer.concat(chunks);
  const newline = file.indexOf(10);
  const meta = JSON.parse(file.subarray(0, newline).toString());
  expect(meta.dtype).toBe('float32');
  expect(meta.angles).toBe(90);
  expect(meta.grid).toBe(1);
  expect(file.length - newline - 1).toBe(meta.width * meta.height * 4);
  await page.locator('.level').first().click();
  await page.locator('#root-level').click();
  await expect(page.locator('#sinogram-title')).toHaveText('Full sinogram');
  await expect(page.locator('#output-title')).toHaveText('Reconstructed image');
  const pngPromise = page.waitForEvent('download');
  await page.locator('#save-image').click();
  const png = await pngPromise;
  expect(png.suggestedFilename()).toBe('radon-128-reconstructed.png');
  const pngStream = await png.createReadStream();
  const pngChunks: Buffer[] = [];
  for await (const chunk of pngStream!) pngChunks.push(Buffer.from(chunk));
  const pngFile = Buffer.concat(pngChunks);
  expect(pngFile.subarray(1, 4).toString()).toBe('PNG');
  expect(pngFile.readUInt32BE(16)).toBe(128);
  expect(pngFile.readUInt32BE(20)).toBe(128);
  expect(errors).toEqual([]);
});

test('smaller leaves and sparse angle counts work in both output views', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#engine-status')).toBeVisible();
  await expect(page.locator('#loading')).toBeHidden({ timeout: 60_000 });
  for (const [leaf, angles] of [[4, 8], [2, 2]]) {
    await page.locator('#leaf-size').selectOption(String(leaf));
    await page.locator('#angles').selectOption(String(angles));
    await page.locator('#run').click();
    await expect(page.locator('#run')).toBeEnabled({ timeout: 60_000 });
    await expect(page.locator('#error')).toBeHidden();
    await expect(page.locator('#metric-leaves')).toHaveText(String((256 / leaf) ** 2));
    await expect(page.locator('.level')).toHaveCount(Math.log2(256 / leaf) + 1);
    await expect(page.locator('#line-directions')).toHaveAttribute('max', String(angles));
    await expect(page.locator('#line-directions')).toHaveValue(String(angles));
    if (await page.locator('#lines-toggle').getAttribute('aria-checked') === 'false') await page.locator('#lines-toggle').click();
    await expect(page.locator('#image-readout')).toContainText(`${angles} DIRECTIONS`);
    await page.locator('.level').first().click();
    await expect(page.locator('#sinogram-title')).toHaveText('Local sinograms');
    await expect(page.locator('#sinogram-dim')).toContainText(`${angles} angles`);
    await expect(page.locator('#output-title')).toHaveText('Reconstructed image');
    await page.locator('#root-level').click();
    await expect(page.locator('#output-tag')).toHaveText('RAY DENSITY');
    await expect(page.locator('#error')).toBeHidden();
  }
});

test('small-leaf atlases reflow within GPU limits and preserve tile coordinates through merging', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#engine-status')).toBeVisible();
  await expect(page.locator('#loading')).toBeHidden({ timeout: 60_000 });
  const measurements = await page.evaluate(async () => {
    const atlasPath = '/src/atlas.ts';
    const { packAtlas } = await import(atlasPath);
    // Exercise capacity boundaries independently of the physical adapter.
    for (const grid of [1, 2, 8, 16, 32]) for (const bins of [6, 8, 10]) for (const angles of [2, 8, 16, 90, 360]) {
      const capacity = Math.floor(1024 / bins) * Math.floor(1024 / angles);
      if (grid * grid > capacity) {
        let rejected = false;
        try { packAtlas(grid, bins, angles, 1024); } catch { rejected = true; }
        if (!rejected) throw new Error('Oversized atlas was accepted.');
      } else {
        const atlas = packAtlas(grid, bins, angles, 1024);
        if (atlas.width > 1024 || atlas.height > 1024 || atlas.columns * atlas.height / angles < grid * grid) throw new Error('Invalid packed atlas capacity.');
      }
    }
    const rendererPath = '/src/renderer.ts', wasmPath = '/src/wasm.ts';
    const { Renderer } = await import(rendererPath);
    const { loadCore } = await import(wasmPath);
    const core = await loadCore();
    const errors: string[] = [];
    const renderer = new Renderer(document.createElement('canvas'), (message: string) => errors.push(message));
    await renderer.initialize();
    const results = [];
    for (const [size, leaf] of [[128, 2], [256, 4]]) {
      const pixels = new Uint8ClampedArray(size * size * 4);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = (x + 2 * y) % 256;
        pixels[i + 3] = 255;
      }
      const result = await renderer.transform(core, pixels, size, leaf, 180);
      const first = result.levels[0];
      const atlas = await renderer.readLevel(0);
      let error = 0;
      for (const [tx, ty] of [[0, 0], [1, 0], [0, 1], [first.grid - 1, first.grid - 1], [Math.floor(first.grid / 2), Math.floor(first.grid / 3)]]) {
        const index = ty * first.grid + tx;
        const x = index % first.columns * first.bins + first.bins / 2 - leaf / 2;
        const y = Math.floor(index / first.columns) * 180;
        let expected = 0;
        for (let dy = 0; dy < leaf; dy++) expected += pixels[((ty * leaf + dy) * size + tx * leaf) * 4] / 255;
        error = Math.max(error, Math.abs(atlas[y * first.width + x] - expected));
      }
      const root = result.levels[result.levels.length - 1];
      const full = await renderer.readLevel(result.levels.length - 1);
      const column = Math.floor(size / 3);
      let expected = 0;
      for (let y = 0; y < size; y++) expected += pixels[(y * size + column) * 4] / 255;
      const rootError = Math.abs(full[root.bins / 2 - size / 2 + column] - expected);
      const image: Float32Array = await renderer.readReconstruction();
      results.push({ reflowed: first.columns !== first.grid, width: first.width, height: first.height, error, rootError, finite: image.every(Number.isFinite) });
    }
    return { results, errors };
  });
  for (const result of measurements.results) {
    expect(result.reflowed).toBe(true);
    expect(result.width).toBeLessThanOrEqual(8192);
    expect(result.height).toBeLessThanOrEqual(8192);
    expect(result.error).toBeLessThan(0.00001);
    expect(result.rootError).toBeLessThan(0.0001);
    expect(result.finite).toBe(true);
  }
  expect(measurements.errors).toEqual([]);
});

test('fragment hierarchy preserves mass, matches a direct projection, and is linear', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#engine-status')).toBeVisible();
  await expect(page.locator('#loading')).toBeHidden({ timeout: 60_000 });
  const measurements = await page.evaluate(async () => {
    // Load the same production renderer, but provide an analytically known input.
    const rendererPath = '/src/renderer.ts';
    const wasmPath = '/src/wasm.ts';
    const { Renderer } = await import(rendererPath);
    const { loadCore } = await import(wasmPath);
    const core = await loadCore();
    const canvas = document.createElement('canvas');
    const gpuErrors: string[] = [];
    const renderer = new Renderer(canvas, (message: string) => gpuErrors.push(message));
    await renderer.initialize();
    const size = 64, angles = 180;
    const white = new Uint8ClampedArray(size * size * 4).fill(255);
    const result = await renderer.transform(core, white, size, 8, angles);
    const root = result.levels.length - 1;
    const hierarchy = await renderer.readLevel(root);
    const whiteReconstruction = await renderer.readReconstruction();
    const bins = result.levels[root].bins;
    const massErrors = Array.from({ length: angles }, (_, a) => {
      let total = 0;
      for (let s = 0; s < bins; s++) total += hierarchy[a * bins + s];
      return Math.abs(total / (size * size) - 1);
    });
    await renderer.transform(core, white, size, size, angles);
    const direct = await renderer.readLevel(0);
    let squaredError = 0, squaredReference = 0;
    for (let i = 0; i < direct.length; i++) {
      squaredError += (hierarchy[i] - direct[i]) ** 2;
      squaredReference += direct[i] ** 2;
    }
    const gray = white.slice();
    for (let i = 0; i < gray.length; i++) if (i % 4 !== 3) gray[i] = 128;
    await renderer.transform(core, gray, size, 8, angles);
    const half = await renderer.readLevel(root);
    const halfReconstruction = await renderer.readReconstruction();
    let inverseLinearityError = 0;
    for (let i = 0; i < halfReconstruction.length; i++) inverseLinearityError = Math.max(inverseLinearityError, Math.abs(halfReconstruction[i] - whiteReconstruction[i] * 128 / 255));
    let linearityError = 0;
    for (let i = 0; i < half.length; i++) linearityError = Math.max(linearityError, Math.abs(half[i] - hierarchy[i] * 128 / 255));
    const black = white.slice();
    for (let i = 0; i < black.length; i++) if (i % 4 !== 3) black[i] = 0;
    await renderer.transform(core, black, size, 8, angles);
    const zero = await renderer.readLevel(root);
    const zeroReconstruction = await renderer.readReconstruction();
    const rectangle = black.slice();
    for (let y = 11; y < 16; y++) for (let x = 43; x < 50; x++) {
      const i = (y * size + x) * 4;
      rectangle[i] = rectangle[i + 1] = rectangle[i + 2] = 255;
    }
    await renderer.transform(core, rectangle, size, 8, angles);
    const shifted = await renderer.readLevel(root);
    const centroids = [0, 45, 90].map(angle => {
      let mass = 0, moment = 0;
      for (let s = 0; s < bins; s++) {
        const value = shifted[angle * bins + s];
        mass += value; moment += value * (s - (bins - 1) / 2);
      }
      return moment / mass;
    });
    return {
      maxMassError: Math.max(...massErrors), axisMassError: massErrors[0],
      relativeRms: Math.sqrt(squaredError / squaredReference), linearityError,
      zeroMax: Math.max(...zero), zeroReconstructionMax: Math.max(...zeroReconstruction.map(Math.abs)), inverseLinearityError, centroids, gpuErrors,
    };
  });
  console.log('GPU numerical checks:', measurements);
  expect(measurements.axisMassError).toBeLessThan(1e-5);
  expect(measurements.maxMassError).toBeLessThan(0.02);
  expect(measurements.relativeRms).toBeLessThan(0.04);
  expect(measurements.linearityError).toBeLessThan(0.0001);
  expect(measurements.zeroMax).toBe(0);
  expect(measurements.zeroReconstructionMax).toBe(0);
  expect(measurements.inverseLinearityError).toBeLessThan(0.0001);
  // An off-center rectangle catches sign errors that a symmetric input cannot.
  expect(measurements.centroids[0]).toBeCloseTo(14.5, 3);
  expect(measurements.centroids[1]).toBeCloseTo(-4 / Math.SQRT2, 1);
  expect(measurements.centroids[2]).toBeCloseTo(-18.5, 3);
  expect(measurements.gpuErrors).toEqual([]);
});

test('coarse-ray reconstruction is reversible, adjustable, and does not change the saved standard image', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#engine-status')).toBeVisible();
  await expect(page.locator('#loading')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('#error')).toBeHidden();
  const time = await page.locator('#metric-time').textContent();
  const quality = await page.locator('#image-readout').textContent();
  const saveImage = async () => {
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#save-image').click();
    const stream = await (await downloadPromise).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  const originalPng = await saveImage();
  const sinogramBefore = await page.locator('#sinogram').screenshot();
  await expect(page.locator('#lines-toggle')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#line-controls')).toBeHidden();
  await page.locator('#lines-toggle').click();
  await expect(page.locator('#lines-toggle')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#line-controls')).toBeVisible();
  await expect(page.locator('#output-tag')).toHaveText('RAY DENSITY');
  const styled = await page.locator('#reconstruction').screenshot();
  expect((await page.locator('#sinogram').screenshot()).equals(sinogramBefore)).toBe(true);
  const visiblePixels = await page.evaluate(async (base64: string) => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 40) visible++;
    return visible;
  }, styled.toString('base64'));
  expect(visiblePixels).toBeGreaterThan(1000);
  await page.locator('#line-directions').fill('40');
  await expect(page.locator('#line-directions-value')).toHaveText('40');
  await expect(page.locator('#image-readout')).toContainText('40 DIRECTIONS');
  await page.locator('#line-count').fill('24');
  await expect(page.locator('#line-count-value')).toHaveText('24');
  await page.locator('#line-width').fill('0.5');
  await expect(page.locator('#line-width-value')).toHaveText('50%');
  const coarser = await page.locator('#reconstruction').screenshot();
  expect(coarser.equals(styled)).toBe(false);
  expect(await saveImage()).toEqual(originalPng);
  await page.locator('.level').first().click();
  await expect(page.locator('#sinogram-title')).toHaveText('Local sinograms');
  await expect(page.locator('#projection-style')).toBeVisible();
  await expect(page.locator('#lines-toggle')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#lines-toggle').click();
  await expect(page.locator('#output-tag')).toHaveText('FILTERED BACKPROJECTION');
  await expect(page.locator('#image-readout')).toHaveText(quality!);
  await expect(page.locator('#metric-time')).toHaveText(time!);
  await expect(page.locator('#error')).toBeHidden();
  expect(errors).toEqual([]);
});

test('coarse rays render without any source, reconstructed-image, or unfiltered sinogram texture', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#engine-status')).toBeVisible();
  await expect(page.locator('#loading')).toBeHidden({ timeout: 60_000 });
  const validation = await page.evaluate(async () => {
    const rendererPath = '/src/renderer.ts', wasmPath = '/src/wasm.ts';
    const { Renderer } = await import(rendererPath);
    const { loadCore, makePhantom } = await import(wasmPath);
    const core = await loadCore();
    const canvas = document.createElement('canvas');
    canvas.id = 'rays-only-test';
    canvas.style.cssText = 'display:block;width:256px;height:256px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = new Renderer(canvas, (message: string) => errors.push(message));
    await renderer.initialize();
    const result = await renderer.transform(core, makePhantom(core, 128, 0), 128, 16, 180);
    // Only filtered projection data survives. WebGPU will reject any accidental
    // use of the destroyed image or original sinogram textures in a bind group.
    result.reconstruction.destroy();
    result.levels.forEach((level: { texture: GPUTexture }) => level.texture.destroy());
    const device: GPUDevice = renderer.device; // Test-only validation inspection.
    device.pushErrorScope('validation');
    renderer.draw(result.levels.length - 1, 4, true, 'reconstruction', { enabled: true, directions: 64, rays: 32, width: 0.35 });
    await device.queue.onSubmittedWorkDone();
    const error = await device.popErrorScope();
    return { validation: error?.message ?? null, errors };
  });
  expect(validation).toEqual({ validation: null, errors: [] });
  const rays = await page.locator('#rays-only-test').screenshot();
  const energy = await page.evaluate(async (base64: string) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0, peak = 0;
    for (let i = 0; i < data.length; i += 4) { sum += data[i]; peak = Math.max(peak, data[i]); }
    return { mean: sum / (data.length / 4), peak };
  }, rays.toString('base64'));
  expect(energy.mean).toBeGreaterThan(10);
  expect(energy.peak).toBeGreaterThan(180);
});

test('filtered backprojection reconstructs asymmetric image structure at the original intensity scale', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#engine-status')).toBeVisible();
  await expect(page.locator('#loading')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('#error')).toBeHidden();
  const measurements = await page.evaluate(async () => {
    const rendererPath = '/src/renderer.ts', wasmPath = '/src/wasm.ts';
    const { Renderer } = await import(rendererPath);
    const { loadCore } = await import(wasmPath);
    const core = await loadCore();
    const gpuErrors: string[] = [];
    const renderer = new Renderer(document.createElement('canvas'), (message: string) => gpuErrors.push(message));
    await renderer.initialize();
    const size = 64;
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const a = 0.6 * Math.exp(-((x + 0.5 - 42) ** 2 + (y + 0.5 - 20) ** 2) / 50);
      const b = 0.3 * Math.exp(-((x + 0.5 - 20) ** 2 + (y + 0.5 - 44) ** 2) / 98);
      const i = (y * size + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = Math.round((a + b) * 255);
      pixels[i + 3] = 255;
    }
    const reference = Float32Array.from({ length: size * size }, (_, i) => pixels[i * 4] / 255);
    await renderer.transform(core, pixels, size, 8, 180);
    pixels.fill(0); // The retained output does not depend on source ownership.
    const image: Float32Array = await renderer.readReconstruction();
    let squaredError = 0, referenceEnergy = 0, dot = 0;
    for (let i = 0; i < image.length; i++) {
      squaredError += (image[i] - reference[i]) ** 2;
      referenceEnergy += reference[i] ** 2; dot += image[i] * reference[i];
    }
    let peak = 0;
    for (let i = 1; i < image.length; i++) if (image[i] > image[peak]) peak = i;
    return {
      relativeRms: Math.sqrt(squaredError / referenceEnergy),
      psnr: -10 * Math.log10(squaredError / image.length), gain: dot / referenceEnergy,
      peakValue: image[peak], peakX: peak % size, peakY: Math.floor(peak / size),
      finite: image.every(Number.isFinite), gpuErrors,
    };
  });
  console.log('GPU reconstruction checks:', measurements);
  expect(measurements.finite).toBe(true);
  expect(measurements.relativeRms).toBeLessThan(0.06);
  expect(measurements.psnr).toBeGreaterThan(35);
  expect(measurements.gain).toBeGreaterThan(0.94);
  expect(measurements.gain).toBeLessThan(1.02);
  expect(measurements.peakValue).toBeGreaterThan(0.5);
  expect(measurements.peakValue).toBeLessThan(0.65); // no hidden min/max normalization
  expect(Math.abs(measurements.peakX - 42)).toBeLessThanOrEqual(1);
  expect(Math.abs(measurements.peakY - 20)).toBeLessThanOrEqual(1);
  expect(measurements.gpuErrors).toEqual([]);
});

test('no WebGPU gives an actionable fallback rather than a blank page', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  await page.goto('/');
  await expect(page.locator('#error')).toContainText('WebGPU is not available');
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.locator('#run')).toBeDisabled();
  await expect(page.locator('#source')).toBeVisible();
  await expect(page.locator('#sinogram-loading')).toBeHidden();
});

test('local image import preserves aspect ratio and converts channels to grayscale', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#engine-status')).toBeVisible();
  await expect(page.locator('#loading')).toBeHidden({ timeout: 60_000 });
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 4;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ff0000'; context.fillRect(0, 0, 4, 4);
    context.fillStyle = '#00ff00'; context.fillRect(4, 0, 4, 4);
    return canvas.toDataURL().split(',')[1];
  });
  await page.locator('#file').setInputFiles({ name: 'two-colors.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('#preset')).toHaveValue('upload');
  await page.locator('#run').click();
  await expect(page.locator('#run')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('#source-label')).toHaveText('two-colors.png');
  const samples = await page.locator('#source').evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext('2d')!;
    return [[20, 20], [128, 256], [384, 256]].map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data));
  });
  expect(samples).toEqual([[0, 0, 0, 255], [54, 54, 54, 255], [182, 182, 182, 255]]);
});

test('mobile layout fits the viewport and help can be opened', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#engine-status')).toBeVisible();
  await expect(page.locator('#loading')).toBeHidden({ timeout: 60_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const imageBox = (await page.locator('#reconstruction').boundingBox())!;
  const sinogramBox = (await page.locator('#sinogram').boundingBox())!;
  expect(sinogramBox.y).toBeGreaterThan(imageBox.y + imageBox.height);
  await page.locator('#lines-toggle').click();
  await expect(page.locator('#line-controls')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('#guide-toggle').click();
  await expect(page.locator('#guide')).toBeVisible();
  await expect(page.locator('#guide-toggle')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#guide-toggle').click();
  await expect(page.locator('#guide')).toBeHidden();
});
