import { Euler, PerspectiveCamera, Vector3 } from 'three';
import { DEG, rng } from '../core/math';
import { settings, type PaletteName } from '../core/settings';
import { MATERIALS, writePalette } from '../level/materials';
import type { RayHit } from '../physics/physics';
import { renderPixels } from './snapshot';
import type { App } from '../app';

/**
 * Frames for the offline codec simulator (tools/codec/, plan §6.3).
 *
 * `?capture=<name>&motion=still|sway|yaw30|yaw120|walk|scan&frames=90` on the dev server:
 * 1. fills the cloud the same way every time: `rays` random rays (seeded) from a small box
 *    around the view, as if you had stood there and scanned all round;
 * 2. renders a scripted head motion for one eye, offscreen at 2160×2160 (4× MSAA, 100° FOV,
 *    the headset's sRGB path from snapshot.ts), one frame per 1/fps s of virtual time;
 * 3. POSTs each frame to the dev server, which writes .captures/<name>/NNNN.png, plus
 *    capture.json (the settings) and dots.json (where a sample of dots lands in every frame:
 *    the known positions the dot-survival metric reads).
 *
 * The app's frame loop is paused while it runs, and nothing is saved (`?capture` implies
 * `?fresh` and its own save slot). Style overrides (&minpx= &palette= &cell=) apply to the
 * capture only; the player's settings are not touched. More captures can be run from the
 * console in the same page: `await __capture.run({ name, motion, minPx, ... })`.
 */

export type Motion = 'still' | 'sway' | 'yaw30' | 'yaw120' | 'walk' | 'scan';

export interface CaptureOptions {
  name: string;
  motion?: Motion;
  frames?: number;
  fps?: number;
  /** Eye buffer size (square) and vertical FOV, like the Frame's (about 2160² per eye, 100°). */
  size?: number;
  fov?: number;
  view?: keyof typeof VIEWS;
  minPx?: number;
  palette?: PaletteName;
  /** Dedup cell (m). */
  cell?: number;
  /** Scan effort of the fill, in rays: the same rays for every style, so the cell decides the density. */
  rays?: number;
  seed?: number;
  /** Dots tracked for the metrics, spread over the distance bands. */
  sample?: number;
}

export interface CaptureResult {
  name: string;
  frames: number;
  dots: number;
  tracked: number;
  fillMs: number;
  renderMs: number;
  dir: string;
}

/** Where the eye stands (world), which way it looks (yaw 0 = -Z), and where it walks. */
const VIEWS = {
  // Just inside the hall: floor, columns at 2–15 m, the stairs and mezzanine, the far wall at 18 m.
  hall: { from: [0, 1.6, -16] as const, yaw: 8, pitch: -4 },
  // The terrace over the expanse: the far field, tens of metres away.
  terrace: { from: [-12.5, 1.6, -24] as const, yaw: 90, pitch: -8 },
};

/** Distance bands (m) for the sample of tracked dots; tools/codec reports per band. */
export const BANDS = [0, 2, 4, 8, 16, Infinity];

const MOTIONS: Motion[] = ['still', 'sway', 'yaw30', 'yaw120', 'walk', 'scan'];

/** Scan motion: a sweep of the scanner across the middle of the view, into a hole left unscanned. */
const SCAN = { holeDeg: 18, sweepDeg: 14, coneDeg: 7, raysPerFrame: 1100, hand: [0.15, -0.25, 0] as const };

const r2 = (v: number) => Math.round(v * 100) / 100;
const _mv = new Vector3();
const _p = new Vector3();

/** Let the page breathe between long loops (a message, not a timer: hidden pages throttle timers). */
const yieldToPage = () =>
  new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });

interface Tracked {
  x: number;
  y: number;
  z: number;
  mat: number;
  /** Frame it was born in (scan dots, born during the capture), or -1 for the fill. */
  from: number;
}

let filledKey: string | null = null;

const status = {
  state: 'idle' as 'idle' | 'filling' | 'rendering' | 'done' | 'error',
  frame: 0,
  frames: 0,
  last: null as CaptureResult | null,
  error: null as string | null,
};

function pose(o: Required<CaptureOptions>, t: number, total: number, cam: PerspectiveCamera): void {
  const v = VIEWS[o.view];
  let yaw = v.yaw;
  let pitch = v.pitch;
  const pos = new Vector3(...v.from);
  // Turns are centred on the view, so the middle frame of every motion looks at the same place.
  const mid = t - total / 2;
  if (o.motion === 'yaw30') yaw += 30 * mid;
  if (o.motion === 'yaw120') yaw += 120 * mid;
  if (o.motion === 'walk') pos.add(new Vector3(-Math.sin(v.yaw * DEG), 0, -Math.cos(v.yaw * DEG)).multiplyScalar(1.4 * t));
  if (o.motion === 'sway') {
    // Standing still the way a person does: a slow drift of a degree or so (peaks near 2.6°/s)
    // and a few millimetres of body sway. Nobody's head is frozen; 'still' is the ideal case.
    const w = 2 * Math.PI;
    yaw += 1.2 * Math.sin(w * 0.35 * t) + 0.3 * Math.sin(w * 1.1 * t + 0.7);
    pitch += 0.6 * Math.sin(w * 0.5 * t + 1.0);
    pos.x += 0.003 * Math.sin(w * 0.3 * t + 2.0);
    pos.y += 0.002 * Math.sin(w * 0.45 * t);
  }
  cam.position.copy(pos);
  cam.quaternion.setFromEuler(new Euler(pitch * DEG, yaw * DEG, 0, 'YXZ'));
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
}

/** Unit vector for a view's forward direction rotated by yaw/pitch offsets (degrees). */
function viewDir(o: Required<CaptureOptions>, dyaw = 0, dpitch = 0): Vector3 {
  const v = VIEWS[o.view];
  return new Vector3(0, 0, -1).applyEuler(new Euler((v.pitch + dpitch) * DEG, (v.yaw + dyaw) * DEG, 0, 'YXZ'));
}

/** Random rays from a box round the view; with a hole, hits near the view's centre are left out. */
async function fill(app: App, o: Required<CaptureOptions>, hole: boolean): Promise<number> {
  const t0 = performance.now();
  app.cloud.clear();
  app.fading.clear();
  app.cloud.setCellSize(o.cell);
  // Moving parts in a known place, and colliders where they're drawn.
  app.level.setTime(0);
  app.physics.step();
  const random = rng(o.seed);
  const hit: RayHit = { dist: 0, material: 0, entity: false };
  const c = new Vector3(...VIEWS[o.view].from);
  const fwd = viewDir(o);
  const cosHole = Math.cos(SCAN.holeDeg * DEG);
  const birth = app.time - 1000;
  for (let i = 0; i < o.rays; ) {
    const end = Math.min(o.rays, i + 100_000);
    for (; i < end; i++) {
      const ox = c.x + (random() * 2 - 1) * 1.0;
      const oy = c.y - 0.6 + random() * 0.8;
      const oz = c.z + (random() * 2 - 1) * 1.0;
      const u = random() * 2 - 1;
      const a = random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const dx = s * Math.cos(a);
      const dz = s * Math.sin(a);
      if (!app.physics.cast(ox, oy, oz, dx, u, dz, 60, hit) || hit.entity) continue;
      const x = ox + dx * hit.dist;
      const y = oy + u * hit.dist;
      const z = oz + dz * hit.dist;
      if (hole) {
        const hx = x - c.x;
        const hy = y - c.y;
        const hz = z - c.z;
        if ((hx * fwd.x + hy * fwd.y + hz * fwd.z) / Math.hypot(hx, hy, hz) > cosHole) continue;
      }
      app.cloud.add(x, y, z, hit.material, birth);
    }
    await yieldToPage();
  }
  app.cloud.flush();
  return Math.round(performance.now() - t0);
}

/** A random dot of the cloud (uniform over dots). */
function randomDot(app: App, random: () => number, out: Tracked): boolean {
  const total = app.cloud.total;
  if (!total) return false;
  let k = Math.floor(random() * total);
  for (const ch of app.cloud.chunks.values())
    for (const b of ch.blocks) {
      if (k < b.count) {
        out.x = b.point[k * 4];
        out.y = b.point[k * 4 + 1];
        out.z = b.point[k * 4 + 2];
        out.mat = b.mat[k];
        return true;
      }
      k -= b.count;
    }
  return false;
}

/** Where a dot lands on screen this frame: [x, y, dist, px, expected peak luma], or null if hidden. */
function project(app: App, o: Required<CaptureOptions>, cam: PerspectiveCamera, d: Tracked, ageS: number, hit: RayHit, out: number[]): boolean {
  const mv = _mv.set(d.x, d.y, d.z).applyMatrix4(cam.matrixWorldInverse);
  if (mv.z > -0.05) return false;
  const p = _p.copy(mv).applyMatrix4(cam.projectionMatrix);
  const S = o.size;
  const x = (p.x * 0.5 + 0.5) * S;
  const y = (0.5 - p.y * 0.5) * S;
  if (x < 4 || y < 4 || x > S - 4 || y > S - 4) return false;
  const dist = mv.length();
  // Hidden behind a wall (the depth pass hides it on screen too)?
  const e = cam.position;
  const dx = (d.x - e.x) / dist;
  const dy = (d.y - e.y) / dist;
  const dz = (d.z - e.z) / dist;
  if (app.physics.cast(e.x, e.y, e.z, dx, dy, dz, dist, hit) && hit.dist < dist - 0.06) return false;
  // The dot shader's size and brightness (src/cloud/dots.ts).
  const u = app.dotUniforms;
  const pxPerUnit = cam.projectionMatrix.elements[5] * S * 0.5;
  const grow = Math.min(1, Math.max(0, ageS / u.uGrow.value));
  const px = Math.min(u.uMaxPx.value, Math.max(u.uMinPx.value, (u.uDotSize.value * pxPerUnit) / dist)) * grow * grow * (3 - 2 * grow);
  const k = Math.min(1, Math.max(0, Math.log2(Math.max(dist, u.uNear.value) / u.uNear.value) / Math.log2(u.uFar.value / u.uNear.value)));
  const b = 1 + (u.uFloor.value - 1) * k;
  const col = (MATERIALS[d.mat] ?? MATERIALS[0]).colors[o.palette];
  const luma = (0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2]) * b * 255;
  out.push(r2(x), r2(y), Math.round(dist * 1000) / 1000, r2(px), Math.round(luma));
  return true;
}

function bandOf(d: number): number {
  let i = 0;
  while (d >= BANDS[i + 1]) i++;
  return i;
}

/**
 * Pick dots visible at a few key frames, an equal quota per distance band. A band the view
 * doesn't have (or a small cloud) stops the search after 20k fruitless tries.
 */
async function chooseTracked(app: App, o: Required<CaptureOptions>, cam: PerspectiveCamera): Promise<Tracked[]> {
  const random = rng(o.seed + 7);
  const keys = [0, Math.floor(o.frames / 2), o.frames - 1];
  const quota = Math.ceil(o.sample / (BANDS.length - 1) / keys.length);
  const out: Tracked[] = [];
  const seen = new Set<string>();
  const hit: RayHit = { dist: 0, material: 0, entity: false };
  const tmp: number[] = [];
  for (const f of keys) {
    pose(o, f / o.fps, o.frames / o.fps, cam);
    const counts = new Array(BANDS.length - 1).fill(0);
    let idle = 0;
    for (let tries = 0; tries < 300_000 && idle < 20_000 && counts.some((n) => n < quota); tries++, idle++) {
      if (tries % 25_000 === 24_999) await yieldToPage();
      const d: Tracked = { x: 0, y: 0, z: 0, mat: 0, from: -1 };
      if (!randomDot(app, random, d)) break;
      tmp.length = 0;
      if (!project(app, o, cam, d, 1000, hit, tmp)) continue;
      const band = bandOf(tmp[2]);
      if (counts[band] >= quota) continue;
      const key = `${d.x},${d.y},${d.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts[band]++;
      out.push(d);
      idle = -1;
    }
  }
  return out;
}

/** Cast this frame's scanner rays (scan motion): a cone sweeping across the hole in the fill. */
function scanFrame(app: App, o: Required<CaptureOptions>, cam: PerspectiveCamera, f: number, now: number, random: () => number, tracked: Tracked[]): void {
  const sweep = -SCAN.sweepDeg + (2 * SCAN.sweepDeg * f) / Math.max(1, o.frames - 1);
  const fwd = viewDir(o, sweep, 0);
  const right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const up = new Vector3().crossVectors(right, fwd).normalize();
  const side = new Vector3().crossVectors(fwd, up).normalize();
  const origin = new Vector3(...SCAN.hand).applyQuaternion(cam.quaternion).add(cam.position);
  const tanHalf = Math.tan(SCAN.coneDeg * DEG);
  const hit: RayHit = { dist: 0, material: 0, entity: false };
  let added = 0;
  for (let i = 0; i < SCAN.raysPerFrame; i++) {
    const rad = tanHalf * Math.sqrt(random());
    const ang = random() * Math.PI * 2;
    const c = Math.cos(ang) * rad;
    const s = Math.sin(ang) * rad;
    const dir = new Vector3(fwd.x + side.x * c + up.x * s, fwd.y + side.y * c + up.y * s, fwd.z + side.z * c + up.z * s).normalize();
    if (!app.physics.cast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, 60, hit)) continue;
    const x = origin.x + dir.x * hit.dist;
    const y = origin.y + dir.y * hit.dist;
    const z = origin.z + dir.z * hit.dist;
    if (hit.entity) app.fading.add(x, y, z, hit.material, now);
    else if (app.cloud.add(x, y, z, hit.material, now) && added++ % 4 === 0 && tracked.length < o.sample * 2)
      tracked.push({ x: Math.fround(x), y: Math.fround(y), z: Math.fround(z), mat: hit.material, from: f });
  }
  app.cloud.flush();
  app.fading.flush();
}

async function post(query: string, body: Blob | string): Promise<string> {
  const r = await fetch(`/__capture?${query}`, { method: 'POST', body });
  if (!r.ok) throw new Error(`capture sink answered ${r.status} (it exists on the dev server only)`);
  return ((await r.json()) as { file: string }).file;
}

export async function runCapture(app: App, opts: CaptureOptions): Promise<CaptureResult> {
  const o: Required<CaptureOptions> = {
    motion: 'still',
    frames: 90,
    fps: 90,
    size: 2160,
    fov: 100,
    view: 'hall',
    minPx: settings.minPx,
    palette: settings.palette,
    cell: 0.025,
    rays: 2_000_000,
    seed: 1,
    sample: 2400,
    ...opts,
  };
  if (!MOTIONS.includes(o.motion)) throw new Error(`motion must be one of ${MOTIONS.join(', ')}`);
  if (!(o.view in VIEWS)) throw new Error(`view must be one of ${Object.keys(VIEWS).join(', ')}`);
  const name = o.name.replace(/[^a-z0-9_-]/gi, '_');
  const q = `name=${encodeURIComponent(name)}`;
  const r = app.renderer;
  status.error = null;
  status.frame = 0;
  status.frames = o.frames;

  // Out of the normal frame loop, and never into a save.
  r.setAnimationLoop(null);
  app.save.save = () => Promise.resolve();
  const hidden = [app.handModels.left.root, app.handModels.right.root, app.scanner.model, app.wristMenu.mesh].filter((x) => x.visible);
  for (const x of hidden) x.visible = false;
  const level = app.level.root.visible;
  app.level.root.visible = true; // the occlusion pass, as by default
  try {
    status.state = 'filling';
    const scan = o.motion === 'scan';
    const key = `${o.view}|${o.cell}|${o.rays}|${o.seed}|${scan}`;
    let fillMs = 0;
    if (filledKey !== key || scan) {
      filledKey = null;
      fillMs = await fill(app, o, scan);
      filledKey = scan ? null : key; // a scan adds dots: the next capture fills again
    }
    // This capture's style, without touching the player's settings.
    app.dotUniforms.uMinPx.value = o.minPx;
    writePalette(app.palette, o.palette);

    const cam = new PerspectiveCamera(o.fov, 1, app.xrCamera.near, app.xrCamera.far);
    const tracked = await chooseTracked(app, o, cam);
    await post(`${q}&reset&file=capture.json`, '{}');

    status.state = 'rendering';
    const T0 = app.time;
    const random = rng(o.seed + 13);
    const hit: RayHit = { dist: 0, material: 0, entity: false };
    const S = o.size;
    const track: number[][] = [];
    const canvases = [0, 1, 2].map(() => {
      const c = document.createElement('canvas');
      c.width = c.height = S;
      return { c, ctx: c.getContext('2d')!, busy: Promise.resolve() as Promise<unknown> };
    });
    const t0 = performance.now();
    for (let f = 0; f < o.frames; f++) {
      status.frame = f + 1;
      const t = f / o.fps;
      pose(o, t, o.frames / o.fps, cam);
      if (scan) scanFrame(app, o, cam, f, T0 + t, random, tracked);
      app.dotUniforms.uTime.value = T0 + t;
      const px = renderPixels(app, cam, S, S, true);

      // Where the tracked dots are in this frame.
      const row: number[] = [];
      for (const d of tracked) {
        const n = row.length;
        const age = d.from >= 0 ? (f - d.from) / o.fps : 1000;
        if (f < d.from || !project(app, o, cam, d, age, hit, row)) {
          row.length = n;
          row.push(-1, 0, 0, 0, 0);
        }
      }
      track.push(row);

      const slot = canvases[f % canvases.length];
      await slot.busy;
      const img = slot.ctx.createImageData(S, S);
      // Flip rows: GL origin is bottom-left.
      for (let y = 0; y < S; y++) img.data.set(px.subarray((S - 1 - y) * S * 4, (S - y) * S * 4), y * S * 4);
      slot.ctx.putImageData(img, 0, 0);
      const frame = f + 1;
      slot.busy = new Promise<Blob>((res) => slot.c.toBlob((b) => res(b!), 'image/png')).then((blob) => post(`${q}&frame=${frame}`, blob));
    }
    await Promise.all(canvases.map((c) => c.busy));
    const renderMs = Math.round(performance.now() - t0);

    // Rows grow as scan dots are added: pad the early ones so every row has every dot.
    for (const row of track) while (row.length < tracked.length * 5) row.push(-1, 0, 0, 0, 0);
    const u = app.dotUniforms;
    const meta = {
      name,
      motion: o.motion,
      frames: o.frames,
      fps: o.fps,
      size: S,
      fov: o.fov,
      view: o.view,
      from: VIEWS[o.view].from,
      style: { minPx: o.minPx, palette: o.palette, cell: o.cell },
      shader: { dotSize: u.uDotSize.value, maxPx: u.uMaxPx.value, near: u.uNear.value, far: u.uFar.value, floor: u.uFloor.value, grow: u.uGrow.value },
      rays: o.rays,
      seed: o.seed,
      dots: app.cloud.total,
      bands: BANDS.map((b) => (Number.isFinite(b) ? b : null)),
      tracked: tracked.length,
      fillMs,
      renderMs,
    };
    await post(`${q}&file=capture.json`, JSON.stringify(meta, null, 1));
    const dir = await post(`${q}&file=dots.json`, JSON.stringify({ fields: ['x', 'y', 'dist', 'px', 'luma'], mats: tracked.map((d) => d.mat), born: tracked.map((d) => d.from), track }));
    const result: CaptureResult = { name, frames: o.frames, dots: app.cloud.total, tracked: tracked.length, fillMs, renderMs, dir: dir.replace(/[\\/][^\\/]*$/, '') };
    status.last = result;
    status.state = 'done';
    console.info('[capture]', JSON.stringify(result));
    return result;
  } catch (err) {
    status.state = 'error';
    status.error = (err as Error).message;
    console.error('[capture] failed:', err);
    throw err;
  } finally {
    for (const x of hidden) x.visible = true;
    app.level.root.visible = level;
    app.dotUniforms.uMinPx.value = settings.minPx;
    writePalette(app.palette, settings.palette);
    app.start();
  }
}

/** `window.__capture`, and the URL route: ?capture=<name>&motion=…&frames=…&minpx=…&palette=…&cell=… */
export function installCapture(app: App): void {
  const api = {
    status,
    views: Object.keys(VIEWS),
    motions: MOTIONS,
    run: (o: CaptureOptions) => runCapture(app, o),
  };
  (window as unknown as { __capture: typeof api }).__capture = api;
  const p = new URLSearchParams(location.search);
  const name = p.get('capture');
  if (!name) return;
  const num = (k: string) => (p.get(k) !== null && Number.isFinite(+p.get(k)!) ? +p.get(k)! : undefined);
  const o: CaptureOptions = { name };
  const set = <K extends keyof CaptureOptions>(k: K, v: CaptureOptions[K] | undefined) => {
    if (v !== undefined) o[k] = v;
  };
  set('motion', (p.get('motion') as Motion | null) ?? undefined);
  set('view', (p.get('view') as CaptureOptions['view'] | null) ?? undefined);
  set('palette', (p.get('palette') as PaletteName | null) ?? undefined);
  set('frames', num('frames'));
  set('fps', num('fps'));
  set('size', num('size'));
  set('fov', num('fov'));
  set('minPx', num('minpx'));
  set('cell', num('cell'));
  set('rays', num('rays'));
  set('seed', num('seed'));
  set('sample', num('sample'));
  void runCapture(app, o).catch(() => {});
}
