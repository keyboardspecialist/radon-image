export type AudioSource = 'off' | 'bass' | 'mids' | 'treble' | 'energy' | 'beat';
export type AudioFeatures = Record<Exclude<AudioSource, 'off'>, number>;

export const silentFeatures = (): AudioFeatures => ({ bass: 0, mids: 0, treble: 0, energy: 0, beat: 0 });
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

// FFT magnitudes are in dBFS. Average linear power rather than dB values so
// quiet bins do not overwhelm a narrow-band instrument. Fixed scaling keeps
// silence silent instead of auto-normalizing background noise to full scale.
export function bandLevel(spectrum: Float32Array, sampleRate: number, fftSize: number, low: number, high: number): number {
  const start = Math.max(1, Math.ceil(low * fftSize / sampleRate));
  const end = Math.min(spectrum.length, Math.ceil(high * fftSize / sampleRate));
  if (end <= start) return 0;
  let power = 0;
  for (let i = start; i < end; i++) {
    if (Number.isFinite(spectrum[i])) power += 10 ** (spectrum[i] / 10);
  }
  return clamp(Math.sqrt(power) * 6);
}

export class FeatureDetector {
  private levels = silentFeatures();
  private bassAverage = 0;
  private previousBass = 0;
  private sinceBeat = 1;
  private elapsed = 0;

  reset() {
    this.levels = silentFeatures();
    this.bassAverage = this.previousBass = this.elapsed = 0;
    this.sinceBeat = 1;
  }

  update(spectrum: Float32Array, waveform: Float32Array, sampleRate: number, fftSize: number, delta: number): AudioFeatures {
    const dt = clamp(delta, 0, 0.1);
    const bass = bandLevel(spectrum, sampleRate, fftSize, 30, 250);
    const mids = bandLevel(spectrum, sampleRate, fftSize, 250, 4000);
    const treble = bandLevel(spectrum, sampleRate, fftSize, 4000, 16000);
    let power = 0;
    for (const sample of waveform) power += sample * sample;
    const energy = clamp(Math.sqrt(power / Math.max(1, waveform.length)) * 2.5);
    this.elapsed += dt;
    this.sinceBeat += dt;
    // A bass onset above the recent energy floor, with a 220 ms refractory
    // period. This is a percussive pulse detector, not a BPM/beat-grid tracker.
    const onset = bass > 0.06 && bass > this.bassAverage * 1.35 + 0.025 && bass - this.previousBass > 0.012;
    if (this.elapsed > 0.08 && this.sinceBeat > 0.22 && onset) {
      this.levels.beat = 1;
      this.sinceBeat = 0;
    } else {
      this.levels.beat *= Math.exp(-dt / 0.16);
    }
    this.bassAverage += (bass - this.bassAverage) * (1 - Math.exp(-dt / 0.65));
    this.previousBass = bass;
    for (const [key, value] of Object.entries({ bass, mids, treble, energy }) as [keyof AudioFeatures, number][]) {
      const tau = value > this.levels[key] ? 0.035 : 0.18;
      this.levels[key] += (value - this.levels[key]) * (1 - Math.exp(-dt / tau));
    }
    return { ...this.levels };
  }
}

export function modulateParameter(base: number, signal: number, amount: number, min: number, max: number, step: number): number {
  const value = base + clamp(signal) * clamp(amount, -1, 1) * (max - min);
  return clamp(min + Math.round((value - min) / step + 1e-9) * step, min, max);
}
