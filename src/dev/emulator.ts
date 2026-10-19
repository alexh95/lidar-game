import type { XRDevice } from 'iwer';

/**
 * Emulated headset for desktop testing and automated checks (IWER, from Meta,
 * MIT licensed). It replaces navigator.xr with a JS runtime, so a normal
 * browser tab can enter "VR", and tests can move the head and controllers and
 * press buttons from code. Loaded only with ?emulate, never in normal use.
 *
 * The device profile is shaped like the Steam Frame as Chrome sees it through
 * SteamVR: Touch-style controllers (SteamVR remaps Frame controllers to the
 * Oculus Touch binding Chrome asks for), floor-relative space, 72–144 Hz.
 */

export type EmuButton = 'trigger' | 'squeeze' | 'thumbstick' | 'a-button' | 'b-button' | 'x-button' | 'y-button' | 'thumbrest';
export type Vec3 = [number, number, number];

export interface Emu {
  device: XRDevice;
  /** Head position in tracking space and yaw/pitch in degrees. */
  head(pos: Vec3, yawDeg?: number, pitchDeg?: number): void;
  /** Controller (target-ray) pose in tracking space; rotation as yaw/pitch/roll degrees. */
  hand(h: 'left' | 'right', pos: Vec3, yawDeg?: number, pitchDeg?: number, rollDeg?: number): void;
  press(h: 'left' | 'right', b: EmuButton, value: number): void;
  touch(h: 'left' | 'right', b: EmuButton, touched: boolean): void;
  stick(h: 'left' | 'right', x: number, y: number): void;
}

function quatFromYawPitchRoll(yaw: number, pitch: number, roll: number): [number, number, number, number] {
  // Y (yaw) then X (pitch) then Z (roll), degrees, intrinsic: q = qy * qx * qz.
  const d = Math.PI / 180;
  const [hy, hx, hz] = [yaw * d * 0.5, pitch * d * 0.5, roll * d * 0.5];
  const qy = [0, Math.sin(hy), 0, Math.cos(hy)];
  const qx = [Math.sin(hx), 0, 0, Math.cos(hx)];
  const qz = [0, 0, Math.sin(hz), Math.cos(hz)];
  const mul = (a: number[], b: number[]) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const q = mul(mul(qy, qx), qz);
  return [q[0], q[1], q[2], q[3]];
}

export async function installEmulator(opts: { devui: boolean; stereo: boolean }): Promise<Emu> {
  const iwer = await import('iwer');
  const config = {
    ...iwer.metaQuest3,
    name: 'Steam Frame (emulated)',
    controllerConfig: iwer.oculusTouchV2,
    supportedSessionModes: ['inline', 'immersive-vr'],
    supportedFeatures: ['viewer', 'local', 'local-floor', 'bounded-floor', 'hand-tracking'],
    supportedFrameRates: [72, 90, 120, 144],
    internalNominalFrameRate: 90,
    isSystemKeyboardSupported: false,
    userAgent: navigator.userAgent,
  } as typeof iwer.metaQuest3;
  const device = new iwer.XRDevice(config, { stereoEnabled: opts.stereo, fovy: (100 * Math.PI) / 180, ipd: 0.064 });
  device.installRuntime({ forceInstall: true });
  if (opts.devui) {
    const { DevUI } = await import('@iwer/devui');
    device.installDevUI(DevUI);
  }
  device.position.set(0, 1.65, 0);
  device.controllers.left?.position.set(-0.22, 1.25, -0.35);
  device.controllers.right?.position.set(0.22, 1.25, -0.35);

  const emu: Emu = {
    device,
    head(pos, yaw = 0, pitch = 0) {
      device.position.set(pos[0], pos[1], pos[2]);
      const q = quatFromYawPitchRoll(yaw, pitch, 0);
      device.quaternion.set(q[0], q[1], q[2], q[3]);
    },
    hand(h, pos, yaw = 0, pitch = 0, roll = 0) {
      const c = device.controllers[h];
      if (!c) return;
      c.position.set(pos[0], pos[1], pos[2]);
      const q = quatFromYawPitchRoll(yaw, pitch, roll);
      c.quaternion.set(q[0], q[1], q[2], q[3]);
    },
    press(h, b, value) {
      device.controllers[h]?.updateButtonValue(b, value);
    },
    touch(h, b, touched) {
      device.controllers[h]?.updateButtonTouch(b, touched);
    },
    stick(h, x, y) {
      device.controllers[h]?.updateAxes('thumbstick', x, y);
    },
  };
  return emu;
}
