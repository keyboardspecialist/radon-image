import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformWithOxc } from 'vite';

const source = await readFile(new URL('../src/audio.ts', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source, 'audio.ts');
const { bandLevel, FeatureDetector, modulateParameter } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const fftSize = 2048;
const spectrumAt = (hz, sampleRate = 48000) => {
  const spectrum = new Float32Array(fftSize / 2).fill(-Infinity);
  spectrum[Math.round(hz * fftSize / sampleRate)] = -15;
  return spectrum;
};

test('FFT bands isolate bass, mids, and treble at different sample rates', () => {
  const bands = [[30, 250], [250, 4000], [4000, 16000]];
  for (const rate of [22050, 44100, 48000, 96000]) {
    for (const [index, hz] of [100, 1000, 8000].entries()) {
      const spectrum = spectrumAt(hz, rate);
      for (const [band, [low, high]] of bands.entries()) {
        const level = bandLevel(spectrum, rate, fftSize, low, high);
        assert.ok(band === index ? level > 0 : level === 0, `${hz} Hz at ${rate} in band ${band}: ${level}`);
        assert.ok(level >= 0 && level <= 1);
      }
    }
  }
});

test('silence stays finite and silent; energy has smoothed attack/release and resets', () => {
  const detector = new FeatureDetector();
  const silence = new Float32Array(1024).fill(-Infinity);
  const waveform = new Float32Array(2048);
  assert.deepEqual(detector.update(silence, waveform, 48000, fftSize, 1 / 60), { bass: 0, mids: 0, treble: 0, energy: 0, beat: 0 });
  waveform.fill(0.2);
  const attack = detector.update(spectrumAt(100), waveform, 48000, fftSize, 1 / 60);
  assert.ok(attack.energy > 0 && attack.energy < 0.5);
  waveform.fill(0);
  const release = detector.update(silence, waveform, 48000, fftSize, 1 / 60);
  assert.ok(release.energy > 0 && release.energy < attack.energy);
  detector.reset();
  assert.deepEqual(detector.update(silence, waveform, 48000, fftSize, 1 / 60), { bass: 0, mids: 0, treble: 0, energy: 0, beat: 0 });
});

test('beat pulses trigger on bass onsets, decay on sustained tones, and rearm after silence', () => {
  const detector = new FeatureDetector();
  const waveform = new Float32Array(2048);
  const silence = new Float32Array(1024).fill(-Infinity);
  const bass = spectrumAt(100);
  for (let i = 0; i < 10; i++) detector.update(silence, waveform, 48000, fftSize, 1 / 60);
  assert.equal(detector.update(bass, waveform, 48000, fftSize, 1 / 60).beat, 1);
  let sustained;
  for (let i = 0; i < 90; i++) sustained = detector.update(bass, waveform, 48000, fftSize, 1 / 60);
  assert.ok(sustained.beat < 0.001, 'a sustained note must not retrigger beats');
  for (let i = 0; i < 90; i++) detector.update(silence, waveform, 48000, fftSize, 1 / 60);
  assert.ok(detector.update(spectrumAt(8000), waveform, 48000, fftSize, 1 / 60).beat < 0.001, 'treble is not a bass onset');
  assert.equal(detector.update(bass, waveform, 48000, fftSize, 1 / 60).beat, 1);
});

test('signed modulation preserves resting values and clamps/quantizes to slider limits', () => {
  assert.equal(modulateParameter(64, 0, -0.3, 2, 180, 1), 64);
  assert.equal(modulateParameter(64, 1, -1, 2, 180, 1), 2);
  assert.equal(modulateParameter(64, 1, 1, 2, 90, 1), 90);
  assert.equal(modulateParameter(48, 1, -1, 8, 128, 1), 8);
  assert.equal(modulateParameter(48, 1, 1, 8, 128, 1), 128);
  assert.equal(modulateParameter(2, 1, 1, 2, 2, 1), 2);
  assert.equal(modulateParameter(0.35, 1, 1, 0.1, 1, 0.05), 1);
  assert.equal(modulateParameter(0.35, 1, -1, 0.1, 1, 0.05), 0.1);
  assert.ok(Math.abs(modulateParameter(0.35, 0.5, 0.5, 0.1, 1, 0.05) - 0.6) < 1e-12);
});
