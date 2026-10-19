import { Quaternion, Vector3 } from 'three';
import { tuning } from '../config';
import { bus } from '../core/events';
import { DEG } from '../core/math';
import { setSetting, settings } from '../core/settings';
import { ScanSave } from '../cloud/persist';
import type { RayHit } from '../physics/physics';
import { fillCloud, measureEyes } from './bench';
import { measureView } from './snapshot';
import type { App } from '../app';
import type { Emu } from './emulator';
import { createDriver, type Driver } from './driver';

/**
 * Scripted playtest against the emulated headset: every feature is driven the way a player
 * would drive it (aim a controller, squeeze the trigger, push a stick, walk in the room)
 * and checked through game state and numbers. Run with `?emulate&selftest` (all checks) or
 * `?emulate&selftest=scan-wall,walk` (some). It saves into its own slot ("selftest"), so
 * your real scan is never touched.
 * Prints one JSON line per check: [selftest] {"name":…,"ok":…,"ms":…}
 */

export interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
  error?: string;
}

type Check = [name: string, fn: (d: Driver) => Promise<unknown>];

const expect = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};
const r2 = (v: number) => +v.toFixed(2);
const v3 = (x: number, y: number, z: number) => new Vector3(x, y, z);

/** Every dot in the cloud as [x, y, z, material]. */
function allDots(app: App): number[][] {
  const out: number[][] = [];
  for (const c of app.cloud.chunks.values())
    for (const b of c.blocks) for (let i = 0; i < b.count; i++) out.push([b.point[i * 4], b.point[i * 4 + 1], b.point[i * 4 + 2], b.mat[i]]);
  return out;
}

/** Stand with the feet at `feet`, the head 1.6 m up, facing `yawDeg` (0 = -Z). */
async function standAt(d: Driver, feet: Vector3, yawDeg = 0): Promise<void> {
  d.setHeadRoom(0, 1.6, 0, 0, 0);
  await d.frames(2);
  d.app.locomotion.placeAt(feet, yawDeg * DEG);
  await d.frames(3);
  d.restHands();
  await d.frames(2);
}

/** Aim the scanner from just below and right of the head at `target` and hold the trigger. */
async function scanAt(d: Driver, target: Vector3, pressure: number, seconds: number): Promise<void> {
  const from = d.head().add(v3(0.15, -0.25, 0));
  d.aimAt('right', from, target);
  await d.frames(2);
  d.press('right', 'trigger', pressure);
  await d.seconds(seconds);
  d.press('right', 'trigger', 0);
  await d.frames(3);
}

async function clearCloud(d: Driver): Promise<void> {
  await d.app.clearScan();
  d.app.cloud.added = 0;
  d.app.cloud.dropped = 0;
  await d.frames(2);
}

const CHECKS: Check[] = [
  [
    'boot',
    async (d) => {
      const a = d.app;
      expect(a.inXR, 'not in an XR session');
      expect(a.input.left.connected && a.input.right.connected, 'controllers not connected');
      expect(a.level.triangles > 1000, `level has ${a.level.triangles} triangles`);
      expect(a.level.moving.length === 3, `expected 3 moving parts, found ${a.level.moving.length}`);
      for (const m of ['concrete', 'plaster', 'tile', 'metal', 'wood', 'stone', 'entity']) expect(a.level.materialsUsed.has(m), `material ${m} not found in the level`);
      const sp = a.level.spawn;
      expect(Math.abs(sp.position.z - 1.6) < 0.01 && Math.abs(sp.yaw) < 0.01, `spawn at ${sp.position.toArray()} yaw ${sp.yaw}`);
      expect(a.locomotion.grounded, 'not standing on the floor at spawn');
      return { triangles: a.level.triangles, moving: a.level.moving.length, hash: a.level.hash, gpuTimer: a.gpu.available };
    },
  ],
  [
    'scan-wall',
    async (d) => {
      // From the spawn, scan the vestibule's west wall (x = -2) with a light trigger (wide cone).
      await clearCloud(d);
      await standAt(d, v3(0, 0, 1.6));
      const target = v3(-2, 1.4, 1.0);
      await scanAt(d, target, 0.35, 0.6);
      const a = d.app;
      const dots = allDots(a);
      expect(dots.length > 800, `only ${dots.length} dots after scanning a wall`);
      // Every dot lies on the wall, inside the cone around the aim point.
      const from = d.head().add(v3(0.15, -0.25, 0));
      const dist = from.distanceTo(target);
      const maxR = Math.tan(tuning.coneWideDeg * DEG) * dist * 1.25 + 0.05;
      let off = 0;
      let outside = 0;
      for (const [x, y, z] of dots) {
        if (Math.abs(x + 2) > 0.02) off++;
        if (Math.hypot(y - target.y, z - target.z) > maxR) outside++;
      }
      expect(off === 0, `${off} dots are not on the wall plane`);
      expect(outside === 0, `${outside} dots outside the cone (r ${maxR.toFixed(2)} m)`);
      expect(a.cloud.uploaded >= 0 && bus.count('scan-start') > 0, 'no scan-start event');
      return { dots: dots.length, coneRadius: r2(maxR), raysPerFrame: a.scanner.budget, usPerRay: r2(a.scanner.usPerRay) };
    },
  ],
  [
    'dedup',
    async (d) => {
      // Scanning the same patch again adds (almost) nothing: the cloud grows with area, not time.
      await clearCloud(d);
      await standAt(d, v3(0, 0, 1.6));
      const target = v3(-2, 1.4, 1.0);
      await scanAt(d, target, 1.0, 0.5);
      const first = d.app.cloud.total;
      d.app.cloud.added = 0;
      await scanAt(d, target, 1.0, 0.5);
      const second = d.app.cloud.added;
      expect(first > 100, `first pass added only ${first}`);
      expect(second < first * 0.1, `second pass added ${second} (first ${first})`);
      expect(d.app.cloud.dropped > 1000, `only ${d.app.cloud.dropped} hits were deduplicated`);
      return { first, second, dropped: d.app.cloud.dropped, cell: d.app.cloud.cell };
    },
  ],
  [
    'upload-range',
    async (d) => {
      // Each frame uploads exactly the dots it added, never whole blocks.
      await clearCloud(d);
      await standAt(d, v3(0, 0, 1.6));
      const a = d.app;
      d.aimAt('right', d.head().add(v3(0.15, -0.25, 0)), v3(0, 1.5, 3));
      await d.frames(2);
      d.press('right', 'trigger', 0.3);
      let frames = 0;
      let mismatched = 0;
      let added = 0;
      const prev = a.onFrame;
      a.onFrame = (dt) => {
        prev?.(dt);
        frames++;
        added += a.scanner.added;
        // Block growth re-creates buffers (uploaded whole, not as a range): skip those frames.
        if (a.cloud.uploaded !== a.scanner.added && a.scanner.added > 0) mismatched++;
      };
      await d.seconds(0.6);
      a.onFrame = prev;
      d.press('right', 'trigger', 0);
      await d.frames(2);
      expect(added > 0, 'nothing added');
      expect(mismatched <= 3, `${mismatched} of ${frames} frames uploaded a different count than they added`);
      return { frames, added, mismatched };
    },
  ],
  [
    'persist',
    async (d) => {
      // Scan, save, forget the cloud in memory, restore from IndexedDB: the same dots come back.
      await clearCloud(d);
      await standAt(d, v3(0, 0, 1.6));
      await scanAt(d, v3(-2, 1.4, 1.0), 0.3, 0.5);
      await scanAt(d, v3(1.5, 1.4, 3), 0.3, 0.5);
      const a = d.app;
      const before = allDots(a);
      await a.save.save();
      const peek = await a.save.peek();
      expect(peek.dots === before.length, `save holds ${peek.dots} dots, cloud has ${before.length}`);
      expect(a.save.unsaved === 0, `${a.save.unsaved} dots still unsaved`);
      a.cloud.clear();
      await d.frames(2);
      expect(a.cloud.total === 0, 'cloud not empty after clear');
      const restored = await a.save.restore(a.time);
      const after = allDots(a);
      expect(restored === before.length && after.length === before.length, `restored ${restored}, had ${before.length}`);
      for (let i = 0; i < before.length; i += 97) {
        const p = before[i];
        const q = after[i];
        expect(Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) < 1e-5 && p[3] === q[3], `dot ${i} differs after restore`);
      }
      expect(a.save.unsaved === 0, 'restored dots counted as unsaved');
      // Restored dots appear grown, not growing.
      return { dots: before.length, blocks: peek.blocks, note: a.save.restoreNote };
    },
  ],
  [
    'save-incremental',
    async (d) => {
      // After a save, more scanning rewrites only the blocks that grew.
      const a = d.app;
      await a.save.save();
      const saves0 = bus.count('save');
      await scanAt(d, v3(1.9, 1.2, -1.0), 0.3, 0.4);
      expect(a.save.unsaved > 0, 'new dots not counted as unsaved');
      await a.save.save();
      const last = d.last('save') as { blocks: number } | undefined;
      expect(bus.count('save') === saves0 + 1 && !!last, 'save did not run');
      expect(last!.blocks <= a.cloud.blockCount && last!.blocks >= 1, `wrote ${last!.blocks} blocks`);
      const peek = await a.save.peek();
      expect(peek.dots === a.cloud.total, `save holds ${peek.dots}, cloud ${a.cloud.total}`);
      return { blocksWritten: last!.blocks, blocks: a.cloud.blockCount, total: a.cloud.total };
    },
  ],
  [
    'save-level-changed',
    async (d) => {
      // A save made on a different version of the level is dropped, not misapplied.
      const a = d.app;
      const real = new ScanSave(a.cloud, a.level.name, a.level.hash, 'selftest-hash');
      await real.save(true);
      const stale = new ScanSave(a.cloud, a.level.name, 'not-this-level', 'selftest-hash');
      const total = a.cloud.total;
      a.cloud.clear();
      const n = await stale.restore(a.time);
      expect(n === 0 && a.cloud.total === 0, `restored ${n} dots from a save of another level`);
      expect(/changed/.test(stale.restoreNote), `note: ${stale.restoreNote}`);
      const peek = await real.peek();
      expect(peek.dots === 0 && !peek.meta, 'stale save was not erased');
      // Put the real scan back.
      await a.save.restore(a.time);
      expect(a.cloud.total === total, 'could not restore the selftest save');
      return { note: stale.restoreNote };
    },
  ],
  [
    'entity-fade',
    async (d) => {
      // Scanning the turning monolith leaves fading dots only, and they're gone after their life.
      await clearCloud(d);
      const a = d.app;
      await standAt(d, v3(0, 0, -19));
      const added0 = a.fading.added;
      await scanAt(d, v3(0, 1.8, -24), 1.0, 0.4);
      const faded = a.fading.added - added0;
      expect(faded > 200, `only ${faded} fading dots from the monolith`);
      const nearMonolith = allDots(a).filter(([x, y, z]) => Math.hypot(x, z + 24) < 0.9 && y > 0.45).length;
      expect(nearMonolith === 0, `${nearMonolith} permanent dots on the monolith`);
      const alive = a.fading.alive(a.time);
      expect(alive > 200, `only ${alive} fading dots alive right after`);
      await d.seconds(tuning.entityLife + 0.3);
      const left = a.fading.alive(a.time);
      expect(left === 0, `${left} fading dots still alive after ${tuning.entityLife} s`);
      return { faded, alive, left };
    },
  ],
  [
    'entity-collider-follows',
    async (d) => {
      // The monolith's collider turns with its animation: rays hit it where it's drawn.
      const a = d.app;
      const hit: RayHit = { dist: 0, material: 0, entity: false };
      const rows = [];
      const mono = a.level.moving.find((m) => m.mesh.name === 'ENT_monolith');
      expect(!!mono, 'no ENT_monolith');
      const t0 = a.level.time;
      for (const t of [0, 3, 6, 9, 12]) {
        a.level.setTime(t);
        a.physics.step();
        mono!.mesh.updateWorldMatrix(true, false);
        const q = mono!.mesh.getWorldQuaternion(new Quaternion());
        // Where a ray along -Z through the centre leaves a 1.2 × 0.3 box turned by q.
        const local = v3(0, 0, 1).applyQuaternion(q.clone().invert());
        const half = Math.min(0.6 / Math.max(Math.abs(local.x), 1e-6), 0.15 / Math.max(Math.abs(local.z), 1e-6));
        const expected = 5 - half;
        expect(a.physics.cast(0, 1.8, -19, 0, 0, -1, 20, hit), `no hit at t=${t}`);
        expect(hit.entity, `hit a non-entity at t=${t}`);
        expect(Math.abs(hit.dist - expected) < 0.03, `t=${t}: hit at ${hit.dist.toFixed(3)} m, expected ${expected.toFixed(3)}`);
        rows.push([t, r2(hit.dist), r2(expected)]);
      }
      a.level.setTime(t0);
      const spread = Math.max(...rows.map((r) => r[1])) - Math.min(...rows.map((r) => r[1]));
      expect(spread > 0.3, `hit distance barely changed (${spread.toFixed(2)} m)`);
      return { rows };
    },
  ],
  [
    'walk',
    async (d) => {
      // Analogue stick walking: full stick for 1.2 s north from the spawn, then half stick.
      const a = d.app;
      await standAt(d, v3(0, 0, 1.6));
      const z0 = d.feet().z;
      d.stick('left', 0, -1);
      await d.seconds(1.2);
      const z1 = d.feet().z;
      const fullSpeed = (z0 - z1) / 1.2;
      d.stick('left', 0, -0.56);
      const t0 = performance.now();
      await d.seconds(1.0);
      const z2 = d.feet().z;
      const halfSpeed = (z1 - z2) / ((performance.now() - t0) / 1000);
      d.stick('left', 0, 0);
      await d.frames(3);
      expect(fullSpeed > tuning.moveSpeed * 0.8 && fullSpeed < tuning.moveSpeed * 1.1, `full stick: ${fullSpeed.toFixed(2)} m/s`);
      expect(halfSpeed > fullSpeed * 0.35 && halfSpeed < fullSpeed * 0.65, `half stick: ${halfSpeed.toFixed(2)} m/s vs ${fullSpeed.toFixed(2)}`);
      expect(Math.abs(d.feet().y) < 0.05, `feet at y ${d.feet().y.toFixed(3)}`);
      expect(a.locomotion.grounded, 'not grounded');
      return { fullSpeed: r2(fullSpeed), halfSpeed: r2(halfSpeed) };
    },
  ],
  [
    'wall-collision',
    async (d) => {
      // Walking into the vestibule's west wall stops you at the wall (capsule radius 0.2 m).
      await standAt(d, v3(0, 0, -0.8), 90); // facing west (-X), north of the bench
      d.stick('left', 0, -1);
      await d.seconds(2.2);
      d.stick('left', 0, 0);
      await d.frames(2);
      const x = d.feet().x;
      expect(x > -2 + tuning.bodyRadius - 0.04, `walked through the wall: feet x ${x.toFixed(3)}`);
      expect(x < -2 + tuning.bodyRadius + 0.1, `stopped short of the wall: feet x ${x.toFixed(3)}`);
      const headX = d.head().x;
      expect(Math.abs(headX - x) < 0.02, `head ${headX.toFixed(3)} not over the feet ${x.toFixed(3)}`);
      return { feetX: r2(x) };
    },
  ],
  [
    'room-pushback',
    async (d) => {
      // Walking into the wall in your real room: the head is pushed back to the body.
      const a = d.app;
      await standAt(d, v3(0, 0, -0.8));
      for (let i = 1; i <= 30; i++) {
        d.setHeadRoom(-0.1 * i, 1.6, 0);
        await d.frames(1);
      }
      await d.frames(3);
      const head = d.head();
      expect(head.x > -2 + tuning.bodyRadius - 0.04, `head went into the wall: x ${head.x.toFixed(3)}`);
      // And moving the head back frees you immediately (the room offset stays).
      d.setHeadRoom(-2.5, 1.6, 0);
      await d.frames(4);
      const back = d.head().x;
      expect(back > head.x + 0.3, `moving back didn't move you (${head.x.toFixed(2)} → ${back.toFixed(2)})`);
      return { headX: r2(head.x), pushback: r2(a.locomotion.pushback), afterStepBack: r2(back) };
    },
  ],
  [
    'stairs',
    async (d) => {
      // Up the hall's stairs (16 steps of 25 cm) to the mezzanine at 4 m.
      await standAt(d, v3(9.3, 0, -17.2));
      d.stick('left', 0, -1);
      await d.waitFor(() => d.feet().z < -30.6, 14, 'reaching the top of the stairs');
      d.stick('left', 0, 0);
      await d.frames(5);
      const f = d.feet();
      expect(Math.abs(f.y - 4.0) < 0.08, `feet at y ${f.y.toFixed(3)} at the top, expected 4.0`);
      expect(d.app.locomotion.grounded, 'not grounded on the mezzanine');
      return { feet: [r2(f.x), r2(f.y), r2(f.z)] };
    },
  ],
  [
    'snap-turn',
    async (d) => {
      await standAt(d, v3(0, 0, 1.0));
      const a = d.app;
      const yaw0 = a.rig.rotation.y;
      const head0 = d.head();
      d.stick('right', 1, 0);
      await d.frames(4);
      d.stick('right', 0, 0);
      await d.frames(3);
      const turned = (a.rig.rotation.y - yaw0) / DEG;
      expect(Math.abs(turned + 45) < 0.5, `turned ${turned.toFixed(1)}°`);
      expect(d.head().distanceTo(head0) < 0.01, 'the head moved while turning');
      return { turnedDeg: r2(turned) };
    },
  ],
  [
    'menu',
    async (d) => {
      // Turn the free palm to the face: the menu opens. Point the scanner at "Settings" and pull.
      const a = d.app;
      await standAt(d, v3(0, 0, 1.0));
      const head = d.head();
      let found = false;
      const palmAt = head.clone().add(v3(-0.05, -0.28, -0.32));
      search: for (let yaw = -180; yaw < 180; yaw += 30)
        for (let pitch = -90; pitch <= 90; pitch += 30)
          for (let roll = -180; roll < 180; roll += 45) {
            const q = new Quaternion().setFromAxisAngle(v3(0, 1, 0), yaw * DEG).multiply(new Quaternion().setFromAxisAngle(v3(1, 0, 0), pitch * DEG)).multiply(new Quaternion().setFromAxisAngle(v3(0, 0, 1), roll * DEG));
            d.setAimWorld('left', palmAt, q);
            await d.frames(2);
            if (a.wristMenu.visible) {
              found = true;
              break search;
            }
          }
      expect(found, 'no palm pose opened the menu');
      await d.frames(20);
      a.wristMenu.page = 'scan';
      const panelH = (0.2 * 560) / 640;
      const button = a.wristMenu.mesh.localToWorld(v3(0, (0.5 - 47 / 560) * panelH, 0));
      d.aimAt('right', head.clone().add(v3(0.18, -0.2, -0.05)), button);
      await d.frames(4);
      expect(a.wristMenu.engaged, 'pointing at the menu did not engage it');
      d.press('right', 'trigger', 1);
      await d.frames(3);
      const scanned = a.scanner.scanning;
      d.press('right', 'trigger', 0);
      await d.frames(3);
      expect((a.wristMenu.page as string) === 'settings', `page is ${a.wristMenu.page}`);
      expect(!scanned, 'the scanner fired while pointing at the menu');
      return { page: a.wristMenu.page };
    },
  ],
  [
    'settings',
    async (d) => {
      // Palette, minimum dot size and occlusion apply live.
      const a = d.app;
      a.wristMenu.click('palette:mono');
      expect(settings.palette === 'mono' && Math.abs((a.palette.image.data as Float32Array)[1 * 4] - 0.85) < 1e-6, 'mono palette not applied');
      a.wristMenu.click('palette:ash');
      a.wristMenu.click('minpx:3.5');
      expect(a.dotUniforms.uMinPx.value === 3.5, 'min px not applied');
      a.wristMenu.click('minpx:2.5');
      a.wristMenu.click('occlusion:off');
      expect(!a.level.root.visible, 'occlusion pass still on');
      a.wristMenu.click('occlusion:on');
      expect(a.level.root.visible, 'occlusion pass not back on');
      return { palette: settings.palette, minPx: settings.minPx };
    },
  ],
  [
    'dots-visible',
    async (d) => {
      // Scanned dots show up in the view, and the distance shading makes far dots dimmer.
      await clearCloud(d);
      await standAt(d, v3(0, 0, 1.6));
      await scanAt(d, v3(-2, 1.4, 1.0), 0.3, 0.5);
      const a = d.app;
      const head = d.head();
      const near = measureView(a, { from: head.toArray() as [number, number, number], to: [-2, 1.4, 1.0], fov: 60, dotsOnly: true });
      expect(near.lit > 0.02, `only ${(near.lit * 100).toFixed(2)}% of the view lit`);
      // The same wall patch seen from 12 m away (corridor) is dimmer per lit pixel.
      setSetting('occlusion', false);
      const far = measureView(a, { from: [0.5, 1.6, -10], to: [-2, 1.4, 1.0], fov: 20, dotsOnly: true });
      setSetting('occlusion', true);
      const nearPer = near.luma / near.lit;
      const farPer = far.luma / Math.max(far.lit, 1e-6);
      expect(far.lit > 0.002, 'dots not visible from 12 m (x-ray)');
      expect(farPer < nearPer * 0.9, `far dots not dimmer: ${farPer.toFixed(3)} vs near ${nearPer.toFixed(3)}`);
      return { nearLit: r2(near.lit * 100), nearPerLit: +nearPer.toFixed(3), farPerLit: +farPer.toFixed(3) };
    },
  ],
  [
    'occlusion',
    async (d) => {
      // Dots behind walls you haven't scanned stay hidden; "x-ray" shows them.
      await clearCloud(d);
      await standAt(d, v3(0, 0, 1.6));
      await scanAt(d, v3(1.5, 1.4, 3), 0.4, 0.5);
      const a = d.app;
      expect(a.cloud.total > 300, `only ${a.cloud.total} dots on the south wall`);
      // (From there the player's own hands, back at the spawn, show through the open doorways.)
      const view = { from: [0.8, 1.6, -8] as [number, number, number], to: [1.5, 1.4, 3] as [number, number, number], fov: 25, dotsOnly: true };
      const hidden = measureView(a, view);
      setSetting('occlusion', false);
      const xray = measureView(a, view);
      setSetting('occlusion', true);
      expect(hidden.lit === 0, `${(hidden.lit * 100).toFixed(3)}% lit through the walls with occlusion on`);
      expect(xray.lit > 0.003, `x-ray shows only ${(xray.lit * 100).toFixed(3)}%`);
      return { hiddenLit: hidden.lit, xrayLit: r2(xray.lit * 100) };
    },
  ],
  [
    'cloud-full',
    async (d) => {
      // At the dot cap the cloud stops growing and says so.
      await clearCloud(d);
      const a = d.app;
      await standAt(d, v3(0, 0, 1.6));
      const cap = a.cloud.maxDots;
      a.cloud.maxDots = 500;
      const full0 = bus.count('cloud-full');
      await scanAt(d, v3(-2, 1.4, 1.0), 0.2, 0.5);
      const total = a.cloud.total;
      a.cloud.maxDots = cap;
      a.cloud.full = false;
      expect(total === 500, `cloud has ${total} dots with a cap of 500`);
      expect(bus.count('cloud-full') === full0 + 1, 'no cloud-full event');
      return { total };
    },
  ],
  [
    'perf-1m',
    async (d) => {
      // A million dots: GPU time for two 2160² eyes, x-ray on (every dot in view is drawn).
      await clearCloud(d);
      const a = d.app;
      const fill = fillCloud(a, 1_000_000, 7);
      expect(fill.total >= 1_000_000, `filled only ${fill.total}`);
      setSetting('occlusion', false);
      const eyes = await measureEyes(a, { from: v3(8, 6, -16), to: v3(-30, -3, -24), frames: 30 });
      setSetting('occlusion', true);
      expect(eyes.gpuMinMs === null || eyes.gpuMinMs < 2.5, `${eyes.gpuMinMs?.toFixed(2)} ms GPU for 1 M dots`);
      expect(eyes.dots > 200_000, `only ${eyes.dots} dots drawn: the view is wrong`);
      const fillRate = fill.rays / fill.ms;
      await clearCloud(d);
      return { gpuMs: eyes.gpuMs === null ? null : r2(eyes.gpuMs), gpuMinMs: eyes.gpuMinMs === null ? null : r2(eyes.gpuMinMs), cpuMs: r2(eyes.cpuMs), drawn: eyes.dots, calls: eyes.calls, fillMs: fill.ms, raysPerMs: r2(fillRate) };
    },
  ],
  [
    'no-errors',
    async (d) => {
      expect(d.app.errors.length === 0, `frame errors: ${d.app.errors[0]}`);
      return { frames: d.app.frameCount };
    },
  ],
];

export async function runSelfTest(app: App, emu: Emu, only: string[] | null = null): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const state = { done: false, passed: 0, failed: 0, results };
  (window as unknown as { __selftest: typeof state }).__selftest = state;
  const d = createDriver(app, emu);
  (window as unknown as { __driver: Driver }).__driver = d;

  await d.waitFor(() => app.inXR && app.input.left.connected && app.input.right.connected, 8, 'XR session + controllers');
  setSetting('turn', 'snap45');
  setSetting('scannerHand', 'right');
  setSetting('palette', 'ash');
  setSetting('occlusion', true);
  setSetting('minPx', 2.5);
  await d.frames(5);
  d.measureGripOffsets();

  for (const [name, fn] of CHECKS) {
    if (only && !only.includes(name)) continue;
    const t0 = performance.now();
    let r: CheckResult;
    try {
      await d.resetWorld();
      const detail = await fn(d);
      r = { name, ok: true, ms: Math.round(performance.now() - t0), detail };
      state.passed++;
    } catch (err) {
      r = { name, ok: false, ms: Math.round(performance.now() - t0), error: (err as Error).message };
      state.failed++;
    }
    results.push(r);
    console.log(`[selftest] ${JSON.stringify(r)}`);
  }
  await d.resetWorld();
  state.done = true;
  console.log(`[selftest] done: ${state.passed} passed, ${state.failed} failed`);
  return results;
}
