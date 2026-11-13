import { test, expect } from '@playwright/test';

// A real, locally generated WAV: pulsed bass plus steady mids and treble.
function musicTrack(seconds = 20) {
  const sampleRate = 44100, samples = sampleRate * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate, envelope = Math.exp(-(t % 0.5) * 14);
    const signal = 0.6 * envelope * Math.sin(2 * Math.PI * 100 * t) + 0.15 * Math.sin(2 * Math.PI * 1000 * t) + 0.08 * Math.sin(2 * Math.PI * 8000 * t);
    wav.writeInt16LE(Math.round(signal * 32767), 44 + i * 2);
  }
  return { name: 'test-beats.wav', mimeType: 'audio/wav', buffer: wav };
}

test('real audio drives coarse rays and PNG snapshots without changing transforms', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('#error')).toBeHidden();
  const transformTime = await page.locator('#metric-time').textContent();
  const sinogram = await page.locator('#sinogram').screenshot();
  await page.locator('#lines-toggle').click();
  const restingImage = await page.locator('#reconstruction').screenshot();
  await page.locator('#music-toggle').click();
  await expect(page.locator('#music-settings')).toBeVisible();
  await expect(page.locator('#music-play')).toBeDisabled();
  await page.locator('#music-file').setInputFiles(musicTrack());
  await expect(page.locator('#music-name')).toHaveText('test-beats.wav');
  await expect(page.locator('#music-play')).toBeEnabled();
  await page.locator('#music-source-directions').selectOption('energy');
  await page.locator('#music-amount-directions').fill('-30');
  await page.locator('#music-play').click();
  await expect(page.locator('#music-status')).toContainText('Reacting live');
  for (const band of ['bass', 'mids', 'treble', 'energy', 'beat']) {
    await expect.poll(() => page.locator(`#music-meter-${band}`).evaluate((meter: HTMLMeterElement) => meter.value), { timeout: 10_000 }).toBeGreaterThan(0.01);
  }
  await expect.poll(() => page.locator('#line-directions').inputValue().then(Number)).toBeLessThan(64);
  await expect.poll(() => page.locator('#line-count').inputValue().then(Number)).toBeLessThan(48);
  await expect.poll(() => page.locator('#line-width').inputValue().then(Number)).toBeGreaterThan(0.35);
  expect((await page.locator('#reconstruction').screenshot()).equals(restingImage)).toBe(false);
  expect((await page.locator('#sinogram').screenshot()).equals(sinogram)).toBe(true);
  await expect(page.locator('#metric-time')).toHaveText(transformTime!);

  await page.locator('#music-source-directions').selectOption('off');
  await expect(page.locator('#line-directions')).toHaveValue('64');
  await page.locator('#music-source-directions').selectOption('energy');
  await page.locator('#music-play').click();
  await expect(page.locator('#line-directions')).toHaveValue('64');
  await expect(page.locator('#line-count')).toHaveValue('48');
  await expect(page.locator('#line-width')).toHaveValue('0.35');
  expect((await page.locator('#reconstruction').screenshot()).equals(restingImage)).toBe(true);

  // Editing a resting value survives playback, seeking, and enable/disable.
  await page.locator('#line-count').fill('32');
  await page.locator('#music-play').click();
  await page.locator('#music-seek').fill('2');
  await expect.poll(() => page.locator('#line-count').inputValue().then(Number)).toBeLessThan(32);
  await page.locator('#music-toggle').click();
  await expect(page.locator('#line-count')).toHaveValue('32');
  expect(await page.locator('#music-audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
  await page.locator('#music-toggle').click();
  await expect.poll(() => page.locator('#line-count').inputValue().then(Number)).toBeLessThan(32);
  await page.locator('#lines-toggle').click();
  await expect(page.locator('#output-tag')).toHaveText('FILTERED BACKPROJECTION');
  expect(await page.locator('#music-audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
  await page.locator('#lines-toggle').click();
  await expect.poll(() => page.locator('#line-count').inputValue().then(Number)).toBeLessThan(32);

  // Recompute with fewer angles while playing; live values must stay in range.
  await page.locator('#angles').selectOption('8');
  await page.locator('#run').click();
  await expect(page.locator('#run')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#line-directions')).toHaveAttribute('max', '8');
  const directions = Number(await page.locator('#line-directions').inputValue());
  expect(directions).toBeGreaterThanOrEqual(2);
  expect(directions).toBeLessThanOrEqual(8);
  await expect(page.locator('#music-status')).toContainText('Reacting live');
  // Recomputing resets analysis. Use steady RMS energy and wait for a live
  // frame, rather than potentially saving the first (still-resting) frame.
  await page.locator('#music-source-width').selectOption('energy');
  await page.locator('#music-amount-width').fill('100');
  await expect.poll(() => page.locator('#line-width').inputValue().then(Number)).toBeGreaterThan(0.35);

  const png = async () => {
    const pending = page.waitForEvent('download');
    await page.locator('#save-image').click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe('radon-256-coarse-rays.png');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  const playingPng = await png();
  await page.locator('#music-play').click();
  const restingPng = await png();
  expect(restingPng.equals(playingPng)).toBe(false);
  expect(await png()).toEqual(restingPng);
  await expect(page.locator('#line-count')).toHaveValue('32');
  await expect(page.locator('#error')).toBeHidden();
  expect(errors).toEqual([]);
});

test('track replacement, decode errors, ending/replay, and mobile controls work', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden({ timeout: 60_000 });
  await page.locator('#lines-toggle').click();
  await page.locator('#music-toggle').click();
  await page.locator('#music-file').setInputFiles(musicTrack());
  await expect(page.locator('#music-play')).toBeEnabled();
  await page.locator('#music-play').click();
  await expect(page.locator('#music-status')).toContainText('Reacting live');
  await page.locator('#music-file').setInputFiles({ name: 'broken.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('not audio') });
  await expect(page.locator('#music-status')).toContainText('could not be decoded');
  await expect(page.locator('#music-play')).toBeDisabled();
  await expect(page.locator('#line-count')).toHaveValue('48');
  await page.locator('#music-file').setInputFiles(musicTrack(2));
  await expect(page.locator('#music-play')).toBeEnabled();
  await page.locator('#music-play').click();
  await page.locator('#music-seek').fill('1.8');
  await expect(page.locator('#music-status')).toContainText('Track ended');
  await expect(page.locator('#line-width')).toHaveValue('0.35');
  await page.locator('#music-play').click();
  await expect(page.locator('#music-status')).toContainText('Reacting live');
  await page.locator('#music-play').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
