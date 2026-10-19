import type { Vector3 } from 'three';
import { audio, setPannerPosition } from './audio';

/**
 * Every sound is synthesized (no files). The world is quiet: a low room tone, your
 * footsteps, and the scanner's hum and the hiss of its returns. Nothing is ever sudden or
 * loud: no stingers, no jump scares.
 */

/** The scanner's voice: a hum whose pitch follows the trigger, and a hiss that follows the hit rate. */
export class ScannerSound {
  private built = false;
  private hum!: OscillatorNode;
  private hum2!: OscillatorNode;
  private humGain!: GainNode;
  private hissGain!: GainNode;
  private hissFilter!: BiquadFilterNode;
  private panner!: PannerNode;

  private build(): boolean {
    const ctx = audio.ctx;
    const out = audio.sfxInput;
    if (!ctx || !out || ctx.state !== 'running') return false;
    this.panner = ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 0.5;
    this.panner.connect(out);

    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    this.humGain.connect(lp);
    lp.connect(this.panner);
    this.hum = ctx.createOscillator();
    this.hum.type = 'triangle';
    this.hum.frequency.value = 110;
    this.hum2 = ctx.createOscillator();
    this.hum2.type = 'sine';
    this.hum2.frequency.value = 220.7;
    this.hum.connect(this.humGain);
    const h2 = ctx.createGain();
    h2.gain.value = 0.35;
    this.hum2.connect(h2);
    h2.connect(this.humGain);
    this.hum.start();
    this.hum2.start();

    const noise = audio.noiseSource(ctx.currentTime, 1);
    this.hissFilter = ctx.createBiquadFilter();
    this.hissFilter.type = 'bandpass';
    this.hissFilter.frequency.value = 5200;
    this.hissFilter.Q.value = 0.9;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    noise.connect(this.hissFilter);
    this.hissFilter.connect(this.hissGain);
    this.hissGain.connect(this.panner);
    this.built = true;
    return true;
  }

  /** `level` 0..1 is how hard the trigger is pressed (0 = silent); `hits` 0..1 the share of rays that hit. */
  update(at: Vector3, level: number, hits: number): void {
    if (!this.built && (level <= 0 || !this.build())) return;
    const t = audio.now;
    setPannerPosition(this.panner, at);
    const on = level > 0;
    this.humGain.gain.setTargetAtTime(on ? 0.05 + 0.04 * level : 0, t, on ? 0.04 : 0.12);
    this.hum.frequency.setTargetAtTime(96 + 60 * level, t, 0.08);
    this.hum2.frequency.setTargetAtTime((96 + 60 * level) * 2.007, t, 0.08);
    this.hissGain.gain.setTargetAtTime(on ? 0.012 + 0.05 * hits : 0, t, 0.05);
    this.hissFilter.frequency.setTargetAtTime(4200 + 2600 * level, t, 0.1);
  }
}

/** A very low, slowly breathing room tone. Present but almost below notice. */
export class Ambience {
  private started = false;

  start(): void {
    const ctx = audio.ctx;
    const out = audio.musicInput;
    if (this.started || !ctx || !out) return;
    this.started = true;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.gain.setTargetAtTime(0.5, ctx.currentTime, 4);
    master.connect(out);
    // Rumble: brown-ish noise through a low lowpass.
    const noise = audio.noiseSource(ctx.currentTime, 0.25);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 140;
    const ng = ctx.createGain();
    ng.gain.value = 0.18;
    noise.connect(lp);
    lp.connect(ng);
    ng.connect(master);
    // Two detuned low sines that beat very slowly, and an LFO that lets the room breathe.
    for (const [f, g] of [
      [55, 0.05],
      [55.13, 0.04],
      [82.4, 0.012],
    ] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og);
      og.connect(master);
      o.start();
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.12;
    lfo.connect(lfoGain);
    lfoGain.connect(master.gain);
    lfo.start();
  }
}

/** A soft footstep: a short low thump with a little grit. */
export function footstep(at: Vector3, strength = 1): void {
  const v = audio.voice({ at, ref: 1.2, wet: 0.35, life: 0.3, gain: 0.22 * strength });
  const ctx = audio.ctx;
  if (!v || !ctx) return;
  const t = v.t0;
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(95 + Math.random() * 20, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.8, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  o.connect(g);
  g.connect(v.input);
  o.start(t);
  o.stop(t + 0.25);
  const n = audio.noiseSource(t, 0.6);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 900 + Math.random() * 400;
  bp.Q.value = 1.2;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(0.25, t + 0.006);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  n.connect(bp);
  bp.connect(ng);
  ng.connect(v.input);
  n.stop(t + 0.12);
}

/** A tiny UI tick (wrist menu). */
export function uiTick(at: Vector3, pitch = 1): void {
  const v = audio.voice({ at, ref: 0.4, life: 0.1, gain: 0.12 });
  const ctx = audio.ctx;
  if (!v || !ctx) return;
  const o = ctx.createOscillator();
  o.frequency.value = 1400 * pitch;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, v.t0);
  g.gain.exponentialRampToValueAtTime(0.6, v.t0 + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, v.t0 + 0.05);
  o.connect(g);
  g.connect(v.input);
  o.start(v.t0);
  o.stop(v.t0 + 0.06);
}
