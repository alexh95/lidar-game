import { Matrix4, Quaternion, Vector2, Vector3 } from 'three';
import { angularVelocity, clamp } from '../core/math';

export type Handedness = 'left' | 'right';

/** One gamepad button with hysteresis and per-frame edges. */
export class Button {
  value = 0;
  pressed = false;
  touched = false;
  /** True only on the frame the button went down / up. */
  down = false;
  up = false;
  /** Touch is reported at all (capacitive sensing): set once seen. */
  touchSeen = false;

  constructor(
    private readonly on = 0.55,
    private readonly off = 0.35,
  ) {}

  update(b: GamepadButton | null | undefined): void {
    const value = b ? b.value || (b.pressed ? 1 : 0) : 0;
    const was = this.pressed;
    this.value = value;
    this.pressed = was ? value > this.off : value > this.on;
    if (b?.touched) this.touchSeen = true;
    this.touched = !!b && (b.touched || this.pressed);
    this.down = !was && this.pressed;
    this.up = was && !this.pressed;
  }

  /** Feed a synthetic analog value (used for hand-tracking pinch / fist). */
  setValue(value: number): void {
    const was = this.pressed;
    this.value = value;
    this.pressed = was ? value > this.off : value > this.on;
    this.touched = value > 0.15;
    this.down = !was && this.pressed;
    this.up = was && !this.pressed;
  }

  reset(): void {
    this.up = this.pressed;
    this.value = 0;
    this.pressed = false;
    this.touched = false;
    this.down = false;
  }
}

/** A tracked pose in world space (tracking space × player rig). */
export class Pose {
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly matrix = new Matrix4();
  valid = false;

  /** Unit vector along local -Z (pointing direction). */
  forward(out: Vector3): Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.quaternion);
  }
}

export const JOINT_NAMES = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
] as const;

const SAMPLE_COUNT = 10;
const VELOCITY_WINDOW_MS = 85;

interface Sample {
  t: number;
  p: Vector3;
  q: Quaternion;
}

const _m = new Matrix4();
const _v = new Vector3();
const _v2 = new Vector3();
const _s = new Vector3();

export class HandInput {
  readonly sign: number;
  source: XRInputSource | null = null;
  connected = false;
  profiles: readonly string[] = [];
  hasGamepad = false;

  /** Poses in tracking (reference) space. */
  readonly gripRef = new Matrix4();
  readonly aimRef = new Matrix4();
  /** Poses in world space. */
  readonly grip = new Pose();
  readonly aim = new Pose();

  readonly trigger = new Button(0.55, 0.35);
  readonly squeeze = new Button(0.5, 0.3);
  readonly stickClick = new Button();
  readonly a = new Button(); // A / X (xr-standard button 4)
  readonly b = new Button(); // B / Y (xr-standard button 5)
  readonly thumbrest = new Button();
  readonly stick = new Vector2();

  /** World-space velocity of the grip pose (m/s) and angular velocity (rad/s). */
  readonly velocity = new Vector3();
  readonly angularVelocity = new Vector3();
  /** The runtime gave us XRPose.linearVelocity (better than our estimate). */
  nativeVelocity = false;

  /** Articulated hand joints, if the runtime exposes them. Tracking space. */
  hasJoints = false;
  jointsValid = false;
  readonly jointMatrices = new Float32Array(JOINT_NAMES.length * 16);
  readonly jointRadii = new Float32Array(JOINT_NAMES.length);
  private jointSpaces: XRJointSpace[] | null = null;
  private jointHand: XRHand | null = null;

  hapticsAvailable = false;
  private hapticBusyUntil = 0;
  private hapticBusyLevel = 0;

  private readonly samples: Sample[] = [];
  private sampleHead = 0;
  private sampleCount = 0;
  private readonly refVelocity = new Vector3();
  private readonly refAngular = new Vector3();

  constructor(readonly handedness: Handedness) {
    this.sign = handedness === 'right' ? 1 : -1;
    for (let i = 0; i < SAMPLE_COUNT; i++) this.samples.push({ t: 0, p: new Vector3(), q: new Quaternion() });
  }

  /** Read poses and buttons for this frame. Poses stay in tracking space here. */
  update(frame: XRFrame, refSpace: XRReferenceSpace, source: XRInputSource | null, now: number): void {
    if (source !== this.source) {
      this.source = source;
      this.profiles = source?.profiles ?? [];
      this.jointSpaces = null;
      this.jointHand = null;
      this.sampleCount = 0;
    }
    if (!source) {
      this.markDisconnected();
      return;
    }

    const gripPose = source.gripSpace ? frame.getPose(source.gripSpace, refSpace) : undefined;
    const aimPose = frame.getPose(source.targetRaySpace, refSpace);
    if (!aimPose && !gripPose) {
      this.markDisconnected();
      return;
    }
    this.connected = true;
    if (aimPose) this.aimRef.fromArray(aimPose.transform.matrix);
    if (gripPose) this.gripRef.fromArray(gripPose.transform.matrix);
    else this.gripRef.copy(this.aimRef);
    if (!aimPose) this.aimRef.copy(this.gripRef);

    // Velocity: prefer the runtime's, else regress over recent samples.
    const lin = gripPose?.linearVelocity;
    const ang = gripPose?.angularVelocity;
    this.pushSample(now);
    if (lin && ang) {
      this.nativeVelocity = true;
      this.refVelocity.set(lin.x, lin.y, lin.z);
      this.refAngular.set(ang.x, ang.y, ang.z);
    } else {
      this.nativeVelocity = false;
      this.estimateVelocity(now);
    }

    // Buttons.
    const gp = source.gamepad;
    this.hasGamepad = !!gp;
    if (gp) {
      const bt = gp.buttons;
      this.trigger.update(bt[0]);
      this.squeeze.update(bt[1]);
      this.stickClick.update(bt[3]);
      this.a.update(bt[4]);
      this.b.update(bt[5]);
      this.thumbrest.update(bt[6]);
      const ax = gp.axes;
      if (ax.length >= 4) this.stick.set(ax[2], ax[3]);
      else if (ax.length >= 2) this.stick.set(ax[0], ax[1]);
      else this.stick.set(0, 0);
      const anyGp = gp as Gamepad & { hapticActuators?: readonly GamepadHapticActuator[] };
      this.hapticsAvailable = !!(anyGp.hapticActuators?.length || gp.vibrationActuator);
    }

    // Articulated joints.
    this.hasJoints = !!source.hand;
    this.jointsValid = false;
    if (source.hand) this.readJoints(frame, refSpace, source.hand);

    // Hands without a gamepad: pinch = trigger, curled fist = squeeze.
    if (!gp && this.jointsValid) this.synthesizeFromJoints();
  }

  /** Drop the input source (session ended). */
  disconnect(): void {
    this.source = null;
    this.jointSpaces = null;
    this.jointHand = null;
    this.sampleCount = 0;
    this.markDisconnected();
  }

  private markDisconnected(): void {
    if (this.connected) {
      this.trigger.reset();
      this.squeeze.reset();
      this.stickClick.reset();
      this.a.reset();
      this.b.reset();
      this.thumbrest.reset();
      this.stick.set(0, 0);
    } else {
      this.trigger.up = this.squeeze.up = false;
    }
    this.connected = false;
    this.grip.valid = this.aim.valid = false;
    this.jointsValid = false;
    this.refVelocity.set(0, 0, 0);
    this.refAngular.set(0, 0, 0);
  }

  private pushSample(now: number): void {
    const s = this.samples[this.sampleHead];
    s.t = now;
    this.gripRef.decompose(s.p, s.q, _s);
    this.sampleHead = (this.sampleHead + 1) % SAMPLE_COUNT;
    this.sampleCount = Math.min(this.sampleCount + 1, SAMPLE_COUNT);
  }

  /** Least-squares slope of position over the last ~85 ms, plus angular velocity. */
  private estimateVelocity(now: number): void {
    const n = this.sampleCount;
    if (n < 2) {
      this.refVelocity.set(0, 0, 0);
      this.refAngular.set(0, 0, 0);
      return;
    }
    let count = 0;
    let tMean = 0;
    const pMean = _v.set(0, 0, 0);
    let oldest: Sample | null = null;
    for (let i = 0; i < n; i++) {
      const s = this.samples[(this.sampleHead - 1 - i + SAMPLE_COUNT) % SAMPLE_COUNT];
      if (now - s.t > VELOCITY_WINDOW_MS && count >= 2) break;
      tMean += s.t;
      pMean.add(s.p);
      count++;
      oldest = s;
    }
    tMean /= count;
    pMean.multiplyScalar(1 / count);
    let den = 0;
    const num = _v2.set(0, 0, 0);
    for (let i = 0; i < count; i++) {
      const s = this.samples[(this.sampleHead - 1 - i + SAMPLE_COUNT) % SAMPLE_COUNT];
      const dt = (s.t - tMean) / 1000;
      den += dt * dt;
      num.x += dt * (s.p.x - pMean.x);
      num.y += dt * (s.p.y - pMean.y);
      num.z += dt * (s.p.z - pMean.z);
    }
    if (den > 1e-9) this.refVelocity.copy(num).multiplyScalar(1 / den);
    else this.refVelocity.set(0, 0, 0);

    const newest = this.samples[(this.sampleHead - 1 + SAMPLE_COUNT) % SAMPLE_COUNT];
    if (oldest && oldest !== newest) {
      angularVelocity(oldest.q, newest.q, (newest.t - oldest.t) / 1000, this.refAngular);
    } else this.refAngular.set(0, 0, 0);
  }

  private readJoints(frame: XRFrame, refSpace: XRReferenceSpace, hand: XRHand): void {
    if (this.jointHand !== hand || !this.jointSpaces) {
      this.jointHand = hand;
      const spaces: XRJointSpace[] = [];
      for (const name of JOINT_NAMES) {
        const s = hand.get(name as XRHandJoint);
        if (!s) {
          this.jointSpaces = null;
          return;
        }
        spaces.push(s);
      }
      this.jointSpaces = spaces;
    }
    const f = frame as XRFrame & {
      fillPoses?: (spaces: XRSpace[], base: XRSpace, out: Float32Array) => boolean;
      fillJointRadii?: (spaces: XRJointSpace[], out: Float32Array) => boolean;
    };
    if (f.fillPoses && f.fillJointRadii) {
      this.jointsValid = f.fillPoses(this.jointSpaces, refSpace, this.jointMatrices) && f.fillJointRadii(this.jointSpaces, this.jointRadii);
      return;
    }
    let ok = true;
    for (let i = 0; i < this.jointSpaces.length; i++) {
      const p = frame.getJointPose?.(this.jointSpaces[i], refSpace);
      if (!p) {
        ok = false;
        break;
      }
      this.jointMatrices.set(p.transform.matrix, i * 16);
      this.jointRadii[i] = p.radius ?? 0.008;
    }
    this.jointsValid = ok;
  }

  /** Tracking-space position of joint `i`. */
  jointPositionRef(i: number, out: Vector3): Vector3 {
    const o = i * 16;
    return out.set(this.jointMatrices[o + 12], this.jointMatrices[o + 13], this.jointMatrices[o + 14]);
  }

  private synthesizeFromJoints(): void {
    const thumb = this.jointPositionRef(4, _v);
    const index = this.jointPositionRef(9, _v2);
    const pinch = clamp(1 - (thumb.distanceTo(index) - 0.012) / 0.03, 0, 1);
    this.trigger.setValue(pinch);
    // Fist: middle/ring tips close to the wrist.
    const wrist = this.jointPositionRef(0, _v);
    let curl = 0;
    for (const tip of [14, 19]) {
      const d = this.jointPositionRef(tip, _v2).distanceTo(wrist);
      curl += clamp(1 - (d - 0.07) / 0.06, 0, 1);
    }
    this.squeeze.setValue(curl / 2);
    this.stick.set(0, 0);
  }

  /** Compose world-space poses and velocities from the player rig. */
  updateWorld(rig: Matrix4, rigQuat: Quaternion, rigScale: number): void {
    if (!this.connected) return;
    this.grip.matrix.multiplyMatrices(rig, this.gripRef);
    this.grip.matrix.decompose(this.grip.position, this.grip.quaternion, _s);
    this.grip.valid = true;
    this.aim.matrix.multiplyMatrices(rig, this.aimRef);
    this.aim.matrix.decompose(this.aim.position, this.aim.quaternion, _s);
    this.aim.valid = true;
    this.velocity.copy(this.refVelocity).applyQuaternion(rigQuat).multiplyScalar(rigScale);
    this.angularVelocity.copy(this.refAngular).applyQuaternion(rigQuat);
  }

  /** World velocity of a point rigidly attached to the grip (v + ω × r). */
  pointVelocity(worldPoint: Vector3, out: Vector3): Vector3 {
    _v.subVectors(worldPoint, this.grip.position);
    return out.crossVectors(this.angularVelocity, _v).add(this.velocity);
  }

  /** World-space joint matrix (for hand rendering). */
  jointWorld(i: number, rig: Matrix4, out: Matrix4): Matrix4 {
    _m.fromArray(this.jointMatrices, i * 16);
    return out.multiplyMatrices(rig, _m);
  }

  /**
   * Vibrate the controller. Fails silently where the runtime has no haptics.
   * A weaker pulse never cuts off a stronger one that is still playing.
   */
  pulse(intensity: number, ms: number): void {
    const gp = this.source?.gamepad as (Gamepad & { hapticActuators?: readonly GamepadHapticActuator[] }) | null | undefined;
    if (!gp) return;
    const now = performance.now();
    intensity = clamp(intensity, 0, 1);
    if (now < this.hapticBusyUntil && intensity < this.hapticBusyLevel) return;
    this.hapticBusyUntil = now + ms;
    this.hapticBusyLevel = intensity;
    try {
      const act = gp.hapticActuators?.[0] as (GamepadHapticActuator & { pulse?: (v: number, d: number) => Promise<boolean> }) | undefined;
      if (act?.pulse) {
        act.pulse(intensity, ms).catch(() => {});
        return;
      }
      const vib = gp.vibrationActuator;
      if (vib?.playEffect) {
        vib.playEffect('dual-rumble', { duration: ms, strongMagnitude: intensity, weakMagnitude: intensity }).catch(() => {});
      }
    } catch {
      // Some runtimes throw synchronously when haptics are unavailable.
    }
  }
}

/** Head pose plus both hands. */
export class XRInput {
  readonly left = new HandInput('left');
  readonly right = new HandInput('right');
  readonly hands: readonly HandInput[] = [this.left, this.right];
  readonly headRef = new Matrix4();
  readonly head = new Pose();
  headValid = false;

  update(frame: XRFrame, refSpace: XRReferenceSpace): void {
    const now = performance.now();
    const viewer = frame.getViewerPose(refSpace);
    this.headValid = !!viewer;
    if (viewer) this.headRef.fromArray(viewer.transform.matrix);

    let l: XRInputSource | null = null;
    let r: XRInputSource | null = null;
    for (const src of frame.session.inputSources) {
      if (src.targetRayMode !== 'tracked-pointer') continue;
      if (src.handedness === 'left') l = src;
      else if (src.handedness === 'right') r = src;
    }
    const blurred = frame.session.visibilityState !== 'visible';
    this.left.update(frame, refSpace, blurred ? null : l, now);
    this.right.update(frame, refSpace, blurred ? null : r, now);
  }

  updateWorld(rig: Matrix4, rigQuat: Quaternion, rigScale: number): void {
    if (this.headValid) {
      this.head.matrix.multiplyMatrices(rig, this.headRef);
      this.head.matrix.decompose(this.head.position, this.head.quaternion, _s);
      this.head.valid = true;
    }
    this.left.updateWorld(rig, rigQuat, rigScale);
    this.right.updateWorld(rig, rigQuat, rigScale);
  }

  /** Called when the session ends. */
  clear(): void {
    this.headValid = false;
    this.head.valid = false;
    for (const h of this.hands) h.disconnect();
  }

  other(h: HandInput): HandInput {
    return h === this.left ? this.right : this.left;
  }

  /** Head yaw in world space (radians, 0 = looking down -Z). */
  headYaw(): number {
    const f = this.head.forward(_v);
    return Math.atan2(-f.x, -f.z);
  }
}
