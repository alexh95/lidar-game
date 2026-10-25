import { Vector3 } from 'three';
import { bus } from '../core/events';
import { settings } from '../core/settings';
import type { App } from '../app';
import type { Emu } from './emulator';
import type { SnapshotOptions } from './snapshot';

const r3 = (v: { x: number; y: number; z: number }) => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];

/**
 * `window.__vr`: a read-only window into the running app for tests, agents and curious
 * humans with a console open. Cheap: nothing runs until you call it.
 */
export function installProbe(app: App, emu: Emu | null): void {
  const probe = {
    version: '0.1.0',
    app,
    emu,
    bus,
    state() {
      const sc = app.scanner;
      return {
        inXR: app.inXR,
        frame: app.frameCount,
        fps: +app.stats.fps.toFixed(1),
        frameMs: +app.stats.frameMs.toFixed(2),
        updateMs: +app.stats.updateMs.toFixed(2),
        renderMs: +app.stats.renderMs.toFixed(2),
        gpuMs: app.gpu.ms === null ? null : +app.gpu.ms.toFixed(3),
        calls: app.stats.calls,
        level: { name: app.level.name, hash: app.level.hash, triangles: app.level.triangles, moving: app.level.moving.length, materials: [...app.level.materialsUsed] },
        rig: { pos: r3(app.rig.position), yawDeg: +((app.rig.rotation.y * 180) / Math.PI).toFixed(1) },
        head: r3(app.headPosition(new Vector3())),
        feet: r3(app.physics.playerFeet(new Vector3())),
        grounded: app.locomotion.grounded,
        walked: +app.locomotion.distance.toFixed(2),
        scanner: {
          hand: sc.hand.handedness,
          scanning: sc.scanning,
          level: +sc.level.toFixed(2),
          halfAngleDeg: +((sc.halfAngle * 180) / Math.PI).toFixed(1),
          rate: sc.rate,
          budget: sc.budget,
          usPerRay: +sc.usPerRay.toFixed(2),
          rays: sc.rays,
          hits: sc.hits,
          added: sc.added,
          faded: sc.faded,
          ms: +sc.ms.toFixed(2),
          totalRays: sc.totalRays,
        },
        cloud: {
          total: app.cloud.total,
          max: app.cloud.maxDots,
          full: app.cloud.full,
          chunks: app.cloud.chunks.size,
          blocks: app.cloud.blockCount,
          mb: +(app.cloud.bytes / 1048576).toFixed(1),
          cell: app.cloud.cell,
          dropped: app.cloud.dropped,
          uploaded: app.cloud.uploaded,
        },
        fading: { added: app.fading.added, alive: app.fading.alive(app.time) },
        save: { slot: app.save.slot, state: app.save.state, unsaved: app.save.unsaved, savedTotal: app.save.savedTotal, note: app.save.restoreNote, error: app.save.lastError || null },
        session: app.xr.info ? { ...app.xr.info, boundedSpace: !!app.xr.info.boundedSpace } : null,
        menu: app.wristMenu.visible,
        settings: { ...settings },
        counts: { ...bus.counts },
        errors: app.errors.length,
      };
    },
    events(n = 20) {
      return bus.recent.slice(-n).map((e) => ({ name: e.name, ...e.data }));
    },
    /** Dev server only: render the view to .snapshots/<name>.png. */
    async snapshot(name: string, opts: SnapshotOptions = {}) {
      const { snapshot } = await import('./snapshot');
      return snapshot(app, name, opts);
    },
    async measure(opts: SnapshotOptions = {}) {
      const { measureView } = await import('./snapshot');
      return measureView(app, opts);
    },
    bench: {
      async fill(n: number, seed = 1) {
        const { fillCloud } = await import('./bench');
        return fillCloud(app, n, seed);
      },
      async eyes(opts: Parameters<typeof import('./bench').measureEyes>[1] = {}) {
        const { measureEyes } = await import('./bench');
        return measureEyes(app, opts);
      },
    },
  };
  (window as unknown as { __vr: typeof probe }).__vr = probe;
}
