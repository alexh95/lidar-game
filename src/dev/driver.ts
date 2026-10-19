import { Matrix4, Quaternion, Vector3 } from 'three';
import { bus, type EventName } from '../core/events';
import { DEG } from '../core/math';
import type { App } from '../app';
import type { Emu, EmuButton } from './emulator';

export type Side = 'left' | 'right';

/**
 * Drives the emulated headset in *world* coordinates (the emulator itself works in
 * tracking space), waits on real frames, and reads events. Used by the self-test, and
 * exposed as `window.__driver` with ?emulate for poking at the app from a console.
 */
export function createDriver(app: App, emu: Emu) {
  const waiters: { n: number; resolve: () => void }[] = [];
  const prevOnFrame = app.onFrame;
  app.onFrame = (dt) => {
    prevOnFrame?.(dt);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (--waiters[i].n <= 0) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  };
  const gripOffset = { left: new Matrix4(), right: new Matrix4() };

  const d = {
    app,
    emu,
    frames: (n: number) => new Promise<void>((resolve) => waiters.push({ n, resolve })),
    async seconds(s: number) {
      const t0 = performance.now();
      while (performance.now() - t0 < s * 1000) await d.frames(1);
    },
    async waitFor(pred: () => boolean, timeoutS: number, what: string) {
      const t0 = performance.now();
      while (!pred()) {
        if (performance.now() - t0 > timeoutS * 1000) throw new Error(`timed out waiting for ${what}`);
        await d.frames(1);
      }
    },
    count: (e: EventName) => bus.count(e),
    last: (e: EventName) => [...bus.recent].reverse().find((x) => x.name === e)?.data,

    /** Grip pose relative to aim pose, per controller (tracking space). */
    measureGripOffsets() {
      for (const side of ['left', 'right'] as Side[]) {
        const h = app.input[side];
        gripOffset[side].copy(h.aimRef).invert().multiply(h.gripRef);
      }
    },
    rigInv: () => app.rig.matrixWorld.clone().invert(),
    setAimWorld(side: Side, pos: Vector3, quat: Quaternion) {
      const m = new Matrix4().compose(pos, quat, new Vector3(1, 1, 1)).premultiply(d.rigInv());
      const p = new Vector3();
      const q = new Quaternion();
      m.decompose(p, q, new Vector3());
      const c = emu.device.controllers[side]!;
      c.position.set(p.x, p.y, p.z);
      c.quaternion.set(q.x, q.y, q.z, q.w);
    },
    /** Point a controller's aim ray from `from` at `to` (world). */
    aimAt(side: Side, from: Vector3, to: Vector3) {
      d.setAimWorld(side, from, d.lookQuat(from, to));
    },
    setHeadWorld(pos: Vector3, yawDeg = 0, pitchDeg = 0) {
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yawDeg * DEG).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitchDeg * DEG));
      const m = new Matrix4().compose(pos, q, new Vector3(1, 1, 1)).premultiply(d.rigInv());
      const p = new Vector3();
      const qq = new Quaternion();
      m.decompose(p, qq, new Vector3());
      emu.device.position.set(p.x, p.y, p.z);
      emu.device.quaternion.set(qq.x, qq.y, qq.z, qq.w);
    },
    /** Head pose in tracking space (room coordinates), e.g. to walk physically. */
    setHeadRoom(x: number, y: number, z: number, yawDeg = 0, pitchDeg = 0) {
      emu.head([x, y, z], yawDeg, pitchDeg);
    },
    press(side: Side, b: EmuButton, v: number) {
      emu.press(side, b, v);
      emu.touch(side, b, v > 0);
    },
    stick(side: Side, x: number, y: number) {
      emu.stick(side, x, y);
    },
    lookQuat: (from: Vector3, to: Vector3) => new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(from, to, new Vector3(0, 1, 0))),
    head: () => app.headPosition(new Vector3()),
    feet: () => app.physics.playerFeet(new Vector3()),
    restHands() {
      const hp = d.head();
      d.setAimWorld('left', hp.clone().add(new Vector3(-0.2, -0.45, -0.3)), new Quaternion());
      d.setAimWorld('right', hp.clone().add(new Vector3(0.2, -0.45, -0.3)), new Quaternion());
    },
    releaseButtons() {
      for (const side of ['left', 'right'] as Side[]) {
        const btns: EmuButton[] = side === 'left' ? ['trigger', 'squeeze', 'x-button', 'y-button', 'thumbstick'] : ['trigger', 'squeeze', 'a-button', 'b-button', 'thumbstick'];
        for (const b of btns) d.press(side, b, 0);
        emu.stick(side, 0, 0);
      }
    },
    /** Back to the start: spawn point, head centred in the room, buttons up, scanner adaptive. */
    async resetWorld() {
      d.releaseButtons();
      app.scanner.fixedRays = 0;
      app.scanner.forceLevel = null;
      emu.head([0, 1.6, 0], 0, 0);
      await d.frames(2);
      const sp = app.level.spawn;
      app.locomotion.placeAt(sp.position, sp.yaw);
      await d.frames(2);
      d.restHands();
      await d.frames(4);
    },
  };
  return d;
}

export type Driver = ReturnType<typeof createDriver>;
