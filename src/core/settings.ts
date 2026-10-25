import { flags, type Quality } from '../config';
import { bus } from './events';

export type TurnMode = 'snap45' | 'snap30' | 'smooth';
export type Hand = 'left' | 'right';
export type PaletteName = 'ash' | 'tinted' | 'mono';

export interface Settings {
  turn: TurnMode;
  vignette: boolean;
  quality: Quality;
  /** The hand that holds the scanner; the other walks (left stick) or turns. */
  scannerHand: Hand;
  palette: PaletteName;
  /** Hide dots behind unscanned walls (a depth-only pass of the level). */
  occlusion: boolean;
  /** Smallest dot on screen, in eye-buffer pixels (the video stream eats anything smaller). */
  minPx: number;
  /** Rays the scanner sends per second, whatever the cone's width. */
  scanRate: number;
}

const KEY = 'lidar-game.settings.v1';

function load(): Settings {
  const defaults: Settings = {
    turn: 'snap45',
    vignette: true,
    quality: flags.quality,
    scannerHand: 'right',
    palette: 'ash',
    occlusion: true,
    minPx: 2.5,
    scanRate: 10_000,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<Settings>;
    const out = { ...defaults, ...saved };
    // An explicit ?quality= in the URL wins over the saved value.
    if (new URLSearchParams(location.search).has('quality')) out.quality = flags.quality;
    return out;
  } catch {
    return defaults;
  }
}

export const settings: Settings = load();

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  if (settings[key] === value) return;
  settings[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode, blocked site data). Settings still apply for this visit.
  }
  bus.emit('setting', { key, value });
}
