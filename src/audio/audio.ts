import { Quaternion, Vector3, type Camera } from 'three';

/**
 * Small Web Audio engine: HRTF-spatialized one-shot voices, a reverb send, and
 * a listener that follows the head. Every sound in the app is synthesized, so
 * there are no audio files to download.
 */

export interface VoiceOptions {
  /** World position; omit for a non-spatial (head-locked) sound. */
  at?: Vector3 | null;
  /** Distance where attenuation starts (m). */
  ref?: number;
  /** Reverb send level 0..1. */
  wet?: number;
  /** Lifetime in seconds after which the voice is torn down. */
  life: number;
  /** Start delay in seconds (e.g. speed of sound). */
  delay?: number;
  gain?: number;
}

export interface Voice {
  /** Connect sources here. */
  input: GainNode;
  /** AudioContext time when the voice should start. */
  t0: number;
  panner: PannerNode | null;
  setPosition(p: Vector3): void;
}

const _f = new Vector3();
const _u = new Vector3();
const _p = new Vector3();
const _q4 = new Quaternion();
const _s4 = new Vector3();

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private musicBus!: GainNode;
  private reverb!: ConvolverNode;
  private reverbIn!: GainNode;
  noise!: AudioBuffer;
  private active = 0;
  readonly maxVoices = 40;
  musicEnabled = true;

  /** Create or resume the context. Must run inside a user gesture. */
  async unlock(): Promise<void> {
    if (!this.ctx) this.build();
    if (this.ctx && this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        // Ignored: we'll try again on the next gesture.
      }
    }
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  get now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  private build(): void {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    comp.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(comp);

    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicEnabled ? 1 : 0;
    this.musicBus.connect(this.master);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(3.2, 2.6);
    this.reverbIn = ctx.createGain();
    this.reverbIn.gain.value = 1;
    this.reverbIn.connect(this.reverb);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.reverb.connect(wet);
    wet.connect(this.master);

    // 2 s of white noise, shared by every noisy sound.
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /** Exponentially decaying stereo noise: a cheap open-air reverb tail. */
  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // A faint pre-delay so the tail reads as distant terrain, not a room.
        const pre = i < ctx.sampleRate * 0.03 ? 0 : 1;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * pre;
      }
    }
    return buf;
  }

  /** Allocate a voice. Returns null if audio isn't running or we're at the voice cap. */
  voice(o: VoiceOptions): Voice | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.active >= this.maxVoices) return null;
    this.active++;
    const t0 = ctx.currentTime + (o.delay ?? 0) + 0.005;
    const input = ctx.createGain();
    input.gain.value = o.gain ?? 1;
    let panner: PannerNode | null = null;
    let out: AudioNode = input;
    if (o.at) {
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = o.ref ?? 1;
      panner.maxDistance = 10000;
      panner.rolloffFactor = 1;
      setPannerPosition(panner, o.at);
      input.connect(panner);
      out = panner;
    }
    out.connect(this.sfx);
    let send: GainNode | null = null;
    if (o.wet) {
      send = ctx.createGain();
      send.gain.value = o.wet;
      out.connect(send);
      send.connect(this.reverbIn);
    }
    const life = (o.delay ?? 0) + o.life + 0.1;
    window.setTimeout(() => {
      input.disconnect();
      panner?.disconnect();
      send?.disconnect();
      this.active--;
    }, life * 1000);
    return {
      input,
      t0,
      panner,
      setPosition(p: Vector3) {
        if (panner) setPannerPosition(panner, p);
      },
    };
  }

  /** A looping noise source starting at t (caller stops it). */
  noiseSource(t: number, rate = 1): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(t, Math.random() * 1.5);
    return src;
  }

  /** Bus for continuous music/ambience (not voice-limited). */
  get musicInput(): GainNode | null {
    return this.ctx ? this.musicBus : null;
  }

  get sfxInput(): GainNode | null {
    return this.ctx ? this.sfx : null;
  }

  get reverbInput(): GainNode | null {
    return this.ctx ? this.reverbIn : null;
  }

  setMusic(on: boolean): void {
    this.musicEnabled = on;
    if (this.ctx) this.musicBus.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.4);
  }

  /** Keep the listener on the head. */
  updateListener(camera: Camera): void {
    const ctx = this.ctx;
    if (!ctx) return;
    camera.matrixWorld.decompose(_p, _q4, _s4);
    if (!Number.isFinite(_p.x + _p.y + _p.z + _q4.x + _q4.y + _q4.z + _q4.w)) return;
    _f.set(0, 0, -1).applyQuaternion(_q4);
    _u.set(0, 1, 0).applyQuaternion(_q4);
    const l = ctx.listener;
    if (l.positionX) {
      const t = ctx.currentTime;
      l.positionX.setValueAtTime(_p.x, t);
      l.positionY.setValueAtTime(_p.y, t);
      l.positionZ.setValueAtTime(_p.z, t);
      l.forwardX.setValueAtTime(_f.x, t);
      l.forwardY.setValueAtTime(_f.y, t);
      l.forwardZ.setValueAtTime(_f.z, t);
      l.upX.setValueAtTime(_u.x, t);
      l.upY.setValueAtTime(_u.y, t);
      l.upZ.setValueAtTime(_u.z, t);
    } else {
      const legacy = l as unknown as { setPosition(x: number, y: number, z: number): void; setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void };
      legacy.setPosition(_p.x, _p.y, _p.z);
      legacy.setOrientation(_f.x, _f.y, _f.z, _u.x, _u.y, _u.z);
    }
  }
}

export function setPannerPosition(p: PannerNode, v: Vector3): void {
  if (p.positionX) {
    const t = p.context.currentTime;
    p.positionX.setValueAtTime(v.x, t);
    p.positionY.setValueAtTime(v.y, t);
    p.positionZ.setValueAtTime(v.z, t);
  } else {
    (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(v.x, v.y, v.z);
  }
}

export const audio = new AudioEngine();
