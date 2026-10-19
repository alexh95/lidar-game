import { Quaternion, Vector3 } from 'three';

/** Frame-rate independent exponential smoothing factor. */
export function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Mulberry32: small, fast, seedable PRNG so the world is the same every load. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 2D value noise in [0,1]. */
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal value noise in roughly [0,1]. */
export function fbm2(x: number, y: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x, y);
    norm += amp;
    x *= 2.03;
    y *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Periodic 1D noise around a circle, used for irregular island outlines. */
export function ringNoise(angle: number, seed: number, freq = 3): number {
  return fbm2(Math.cos(angle) * freq + seed * 17.1, Math.sin(angle) * freq - seed * 9.3, 4);
}

const _q = new Quaternion();

/**
 * Angular velocity (rad/s, world axes) that rotates `from` into `to` over `dt`.
 */
export function angularVelocity(from: Quaternion, to: Quaternion, dt: number, out: Vector3): Vector3 {
  _q.copy(from).invert().premultiply(to); // to * from^-1
  if (_q.w < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
  const w = clamp(_q.w, -1, 1);
  const angle = 2 * Math.acos(w);
  const s = Math.sqrt(1 - w * w);
  if (s < 1e-6 || dt <= 0) return out.set(0, 0, 0);
  return out.set(_q.x / s, _q.y / s, _q.z / s).multiplyScalar(angle / dt);
}

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
