import { FeatureDetector, modulateParameter, silentFeatures, type AudioFeatures, type AudioSource } from './audio';
import type { LineStyle } from './renderer';

const sources: [AudioSource, string][] = [['off', 'Manual'], ['beat', 'Beat pulse'], ['bass', 'Bass · 30–250 Hz'], ['mids', 'Mids · 250 Hz–4 kHz'], ['treble', 'Treble · 4–16 kHz'], ['energy', 'Overall energy']];
const parameters = [
  { key: 'directions', label: 'Directions', source: 'mids', amount: -30 },
  { key: 'rays', label: 'Rays across image', source: 'bass', amount: -30 },
  { key: 'width', label: 'Ray width', source: 'beat', amount: 55 },
] as const;
type Parameter = typeof parameters[number]['key'];

export const musicMarkup = `
  <section class="music-controls" id="music-controls" aria-label="Music reactive controls">
    <div class="projection-style-heading"><label id="music-label" for="music-toggle">Music reactive <span class="tag">LIVE FFT</span></label><button id="music-toggle" class="switch" role="switch" aria-labelledby="music-label" aria-checked="false" aria-controls="music-settings"><span></span></button></div>
    <div id="music-settings" hidden>
      <div class="music-track"><button id="music-upload" class="music-button">Load music ↗</button><input id="music-file" type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac" hidden /><span id="music-name">Choose a local audio track</span><span class="header-note">LOCAL ONLY</span></div>
      <audio id="music-audio" preload="metadata"></audio>
      <div class="music-transport"><button id="music-play" class="music-button" disabled aria-label="Play music">Play</button><label class="sr-only" for="music-seek">Track position</label><input id="music-seek" type="range" min="0" max="1" value="0" step="0.01" disabled /><span id="music-time">0:00 / 0:00</span></div>
      <div class="music-meters" aria-label="Live audio levels">${(['bass', 'mids', 'treble', 'energy', 'beat'] as const).map(key => `<div><span>${key === 'beat' ? 'BEAT PULSE' : key.toUpperCase()}</span><meter id="music-meter-${key}" min="0" max="1" value="0" aria-label="${key} level"></meter></div>`).join('')}</div>
      <div class="music-mappings">${parameters.map(parameter => `<div class="music-mapping"><label for="music-source-${parameter.key}">${parameter.label}</label><select id="music-source-${parameter.key}" aria-label="${parameter.label} audio source">${sources.map(([value, label]) => `<option value="${value}" ${value === parameter.source ? 'selected' : ''}>${label}</option>`).join('')}</select><div class="range-label"><label for="music-amount-${parameter.key}">Amount</label><output id="music-amount-${parameter.key}-value">${parameter.amount > 0 ? '+' : ''}${parameter.amount}%</output></div><input id="music-amount-${parameter.key}" type="range" min="-100" max="100" step="1" value="${parameter.amount}" aria-label="${parameter.label} modulation amount" /></div>`).join('')}</div>
      <p>Sliders above set the resting values; their handles follow the music during playback. Positive amounts add, negative amounts subtract. Beat pulse detects bass hits, not a fixed tempo. Pause restores your manual values. Save image captures the current music-driven coarse rays.</p>
      <div id="music-status" role="status">Load a track, then press Play.</div>
    </div>
  </section>`;

const timeLabel = (seconds: number) => Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '0:00';

export class MusicControls {
  private audio: HTMLAudioElement;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private spectrum = new Float32Array(1024);
  private waveform = new Float32Array(2048);
  private detector = new FeatureDetector();
  private features = silentFeatures();
  private mappings: Record<Parameter, { source: AudioSource; amount: number }> = {
    directions: { source: 'mids', amount: -0.3 }, rays: { source: 'bass', amount: -0.3 }, width: { source: 'beat', amount: 0.55 },
  };
  private enabled = false;
  private active = false;
  private frame = 0;
  private lastTime = 0;
  private url?: string;

  constructor(private root: HTMLElement, private onChange: () => void) {
    this.audio = this.element<HTMLAudioElement>('music-audio');
    this.element('music-toggle').addEventListener('click', () => {
      this.enabled = !this.enabled;
      this.element('music-toggle').setAttribute('aria-checked', String(this.enabled));
      this.element('music-settings').hidden = !this.enabled;
      this.sync();
    });
    this.element('music-upload').addEventListener('click', () => this.element<HTMLInputElement>('music-file').click());
    this.element('music-file').addEventListener('change', () => this.loadTrack());
    this.element('music-play').addEventListener('click', () => void this.togglePlayback());
    this.element('music-seek').addEventListener('input', () => {
      if (!Number.isFinite(this.audio.duration)) return;
      this.audio.currentTime = Number(this.element<HTMLInputElement>('music-seek').value);
      this.reset();
      this.updateTime();
    });
    for (const parameter of parameters) {
      this.element(`music-source-${parameter.key}`).addEventListener('change', () => {
        this.mappings[parameter.key].source = this.element<HTMLSelectElement>(`music-source-${parameter.key}`).value as AudioSource;
        this.onChange();
      });
      this.element(`music-amount-${parameter.key}`).addEventListener('input', () => {
        const amount = Number(this.element<HTMLInputElement>(`music-amount-${parameter.key}`).value);
        this.mappings[parameter.key].amount = amount / 100;
        this.element(`music-amount-${parameter.key}-value`).textContent = `${amount > 0 ? '+' : ''}${amount}%`;
        this.onChange();
      });
    }
    this.audio.addEventListener('loadedmetadata', () => {
      this.element<HTMLButtonElement>('music-play').disabled = false;
      this.element<HTMLInputElement>('music-seek').disabled = !Number.isFinite(this.audio.duration);
      this.element<HTMLInputElement>('music-seek').max = String(Number.isFinite(this.audio.duration) ? this.audio.duration : 1);
      this.updateTime();
      this.status('Ready · press Play.');
    });
    this.audio.addEventListener('timeupdate', () => this.updateTime());
    this.audio.addEventListener('playing', () => this.sync());
    this.audio.addEventListener('pause', () => this.sync());
    this.audio.addEventListener('ended', () => this.sync());
    this.audio.addEventListener('error', () => {
      this.audio.pause();
      this.element<HTMLButtonElement>('music-play').disabled = true;
      this.status('This track could not be decoded. Try an MP3, WAV, or another browser-supported audio file.');
    });
    document.addEventListener('visibilitychange', () => this.sync());
    window.addEventListener('pagehide', event => {
      if (event.persisted) this.audio.pause();
      else this.dispose();
    });
  }

  private element<T extends HTMLElement = HTMLElement>(id: string) { return this.root.querySelector<T>(`#${id}`)!; }
  private status(message: string) { this.element('music-status').textContent = message; }

  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    this.sync();
  }

  modulate(style: LineStyle, angles: number): LineStyle {
    if (!this.enabled || !this.active || this.audio.paused || this.audio.ended) return style;
    const next = { ...style };
    for (const parameter of parameters) {
      const { source, amount } = this.mappings[parameter.key];
      if (source === 'off') continue;
      const [min, max, step] = parameter.key === 'width' ? [0.1, 1, 0.05] : parameter.key === 'rays' ? [8, 128, 1] : [2, Math.min(180, angles), 1];
      next[parameter.key] = modulateParameter(style[parameter.key], this.features[source], amount, min, max, step);
    }
    return next;
  }

  private loadTrack() {
    const input = this.element<HTMLInputElement>('music-file');
    const file = input.files?.[0];
    if (!file) return;
    this.audio.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    this.element('music-name').textContent = file.name;
    this.element('music-name').title = file.name;
    this.element<HTMLButtonElement>('music-play').disabled = true;
    this.element<HTMLInputElement>('music-seek').disabled = true;
    this.audio.src = this.url;
    this.audio.load();
    this.reset();
    this.updateTime();
    this.onChange();
    this.status('Loading track…');
    input.value = '';
  }

  private async togglePlayback() {
    if (!this.audio.paused) { this.audio.pause(); return; }
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0;
        this.context.createMediaElementSource(this.audio).connect(this.analyser);
        this.analyser.connect(this.context.destination);
        this.context.addEventListener('statechange', () => this.sync());
      }
      await this.context.resume();
      if (this.audio.ended) this.audio.currentTime = 0;
      await this.audio.play();
    } catch {
      this.audio.pause();
      this.status('Audio could not start. Check the track format and browser audio permissions, then try Play again.');
    }
  }

  private sync() {
    const playing = !this.audio.paused && !this.audio.ended;
    this.element('music-play').textContent = playing ? 'Pause' : 'Play';
    this.element('music-play').setAttribute('aria-label', playing ? 'Pause music' : 'Play music');
    const animate = playing && this.enabled && this.active && !document.hidden && this.context?.state === 'running';
    if (animate) {
      if (!this.frame) {
        this.lastTime = performance.now();
        this.frame = requestAnimationFrame(this.tick);
      }
      this.status('Reacting live · FFT bands + bass-onset pulses.');
    } else {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.reset();
      if (this.url) this.status(playing ? 'Playing · enable music reactive and coarse rays to animate.' : this.audio.ended ? 'Track ended · press Play to replay.' : 'Paused · manual values restored.');
    }
    this.onChange();
  }

  private tick = (now: number) => {
    if (!this.analyser || !this.context) return;
    this.analyser.getFloatFrequencyData(this.spectrum);
    this.analyser.getFloatTimeDomainData(this.waveform);
    this.features = this.detector.update(this.spectrum, this.waveform, this.context.sampleRate, this.analyser.fftSize, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.updateMeters(this.features);
    this.onChange();
    this.frame = requestAnimationFrame(this.tick);
  };

  private updateMeters(features: AudioFeatures) {
    for (const key of Object.keys(features) as (keyof AudioFeatures)[]) this.element<HTMLMeterElement>(`music-meter-${key}`).value = features[key];
  }

  private reset() {
    this.detector.reset();
    this.features = silentFeatures();
    this.updateMeters(this.features);
  }

  private updateTime() {
    this.element<HTMLInputElement>('music-seek').value = String(this.audio.currentTime);
    this.element('music-time').textContent = `${timeLabel(this.audio.currentTime)} / ${timeLabel(this.audio.duration)}`;
  }

  private dispose() {
    this.audio.pause();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    void this.context?.close();
  }
}
