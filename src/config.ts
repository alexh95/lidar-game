// Tunables and URL flags in one place.

const params = new URLSearchParams(location.search);

export type Quality = 'high' | 'low';

/** The Steam Frame running a browser natively reports Linux on aarch64. */
const looksStandaloneArm = /aarch64|arm64/i.test(navigator.userAgent) && /Linux/i.test(navigator.userAgent);

const num = (name: string): number | null => {
  const v = params.get(name);
  return v !== null && v !== '' && Number.isFinite(+v) ? +v : null;
};

export const flags = {
  /** Install the IWER emulated headset (for desktop testing and agents). */
  emulate: params.has('emulate'),
  /** Also mount IWER's DevUI (mouse/keyboard control of the emulated headset). */
  devui: params.has('devui'),
  /** Run the scripted self-test after entering the emulated session. */
  selftest: params.has('selftest'),
  /** ?selftest=a,b runs only those checks. */
  selftestOnly: params.get('selftest') ? params.get('selftest')!.split(',').filter(Boolean) : null,
  /** Enter VR automatically (emulator only: real browsers need a click). */
  autostart: params.has('autostart'),
  /** Render the emulated session in stereo (side-by-side). */
  stereo: params.has('stereo'),
  quality: ((params.get('quality') as Quality | null) ?? (looksStandaloneArm ? 'low' : 'high')) as Quality,
  /** Which level to load (public/levels/<name>.glb). */
  level: (params.get('level') ?? 'hall').replace(/[^a-z0-9_-]/gi, ''),
  /** Seed for the scan pattern (tests make scans deterministic with it). */
  seed: num('seed'),
  /** Start with an empty scan and don't load the saved one (it is still saved over). */
  fresh: params.has('fresh') || params.has('capture'),
  /** Save slot: scans of the same level in different slots don't mix (the self-test uses its own). */
  slot: (params.get('slot') ?? (params.has('selftest') ? 'selftest' : params.has('capture') ? 'capture' : 'main')).replace(/[^a-z0-9_-]/gi, ''),
  /** ?capture=name (dev server): render a scripted head motion offscreen for tools/codec/ (src/dev/capture.ts). */
  capture: params.get('capture'),
  /** ?bench: fill the cloud with N dots through the real renderer and report GPU time. */
  bench: params.has('bench'),
};

export const tuning = {
  // Walking
  moveSpeed: 1.6, // m/s at full stick: a slow, deliberate walk
  snapTurnDegrees: 45,
  smoothTurnSpeed: 90, // deg/s
  stepHeight: 0.28, // m: stairs and kerbs
  maxSlopeDeg: 42,
  bodyRadius: 0.2, // m
  bodyHeight: 1.3, // m: low enough for 1.5 m passages, high enough to bump into tables

  // Scanner
  coneWideDeg: 17, // half-angle with the trigger barely pressed
  coneNarrowDeg: 4.5, // half-angle at full squeeze
  scanRange: 60, // m: rays that hit nothing within this leave no dot
  rayBudgetMs: 1.6, // most main-thread time the scanner may spend in a frame (a safety cap; the rate is a setting)
  maxRaysPerFrame: 1600,
  minRaysPerFrame: 64,

  // Dots
  dedupCell: 0.025, // m: one dot per cell, so the cloud grows with area, not time
  maxDots: 4_000_000,
  growSeconds: 0.16, // a new dot grows from nothing to full size
  entityLife: 2.6, // s: dots on moving things fade out over this
  entityCapacity: 1 << 16,
};

/** Depth of the comfort vignette at full stick speed (0..1). */
export const VIGNETTE_STRENGTH = 0.7;
