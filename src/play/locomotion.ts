import { BackSide, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import { tuning, VIGNETTE_STRENGTH } from '../config';
import { bus } from '../core/events';
import { clamp, damp, DEG } from '../core/math';
import { settings } from '../core/settings';
import { footstep } from '../audio/sfx';
import type { App } from '../app';

const _head = new Vector3();
const _feet = new Vector3();
const _want = new Vector3();
const _moved = new Vector3();
const _follow = new Vector3();
const _start = new Vector3();
const _dir = new Vector3();

/** How far your head may be from your body (horizontally) before the body steps after it (m). */
const LEAN_FREE = 0.3;
/** How far you can lean out past where your body can follow: over a railing or a ledge (m). */
const LEAN_MAX = 0.75;
/** The head is a ball this size: it stops at walls instead of passing into them. */
const HEAD_RADIUS = 0.12;

const overlayVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const overlayFragment = /* glsl */ `
uniform float uVignette;
uniform float uFade;
varying vec3 vDir;
void main() {
  float c = -normalize(vDir).z;
  float v = smoothstep(0.93, 0.5, c) * uVignette;
  gl_FragColor = vec4(0.0, 0.0, 0.0, max(v, uFade));
}`;

/**
 * Analogue walking with collision, and turning.
 *
 * The body is a cylinder driven by Rapier's character controller: it slides along walls,
 * climbs steps up to 28 cm, follows slopes and stairs, and falls under gravity. The stick
 * moves the body (and you with it).
 *
 * Your head is free to lean: the body only steps after it once the head is more than
 * 30 cm away, and never off a ledge. So you can lean over a railing or look down over an
 * edge. The head itself is a small ball: it stops at walls (the view is held back at the
 * wall's surface, not pushed back to the body), and it can't lean out more than 75 cm past
 * where the body can follow.
 *
 * Left stick walks (head-relative, analogue). Right stick turns: snap 45° by default, 30°
 * or smooth as options. A comfort vignette closes in while you move with the stick.
 */
export class Locomotion {
  private turnArmed = true;
  private vy = 0;
  grounded = true;
  /** Metres walked (stick or room) since start, for footsteps and tests. */
  distance = 0;
  private stepAcc = 0;
  private vignette = 0;
  private readonly overlay: Mesh;
  private readonly overlayUniforms = { uVignette: { value: 0 }, uFade: { value: 0 } };
  private fade = 0;
  private fadeDir = 0;
  private onFaded: (() => void) | null = null;
  /** Stick input as a world velocity this frame (m/s), for tests. */
  readonly stickVelocity = new Vector3();
  /** How far the head was held back last frame (at a wall, or past the lean limit) (m). */
  pushback = 0;

  constructor(private readonly app: App) {
    this.overlay = new Mesh(
      new SphereGeometry(0.16, 24, 16),
      new ShaderMaterial({
        vertexShader: overlayVertex,
        fragmentShader: overlayFragment,
        uniforms: this.overlayUniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: BackSide,
      }),
    );
    this.overlay.renderOrder = 10000;
    this.overlay.frustumCulled = false;
    this.overlay.visible = false;
    this.overlay.name = 'comfort-overlay';
    app.xrCamera.add(this.overlay);
  }

  /** Put the feet at `feet`, facing `yaw`, with the head over them. */
  placeAt(feet: Vector3, yaw: number): void {
    const app = this.app;
    app.rig.rotation.y = yaw;
    app.rig.position.set(feet.x, feet.y + app.floorOffset, feet.z);
    app.updateRig();
    const head = app.headPosition(_head);
    if (app.inXR) {
      app.rig.position.x += feet.x - head.x;
      app.rig.position.z += feet.z - head.z;
      app.updateRig();
    }
    app.physics.placePlayer(feet);
    this.vy = 0;
  }

  /** Returns true if the rig moved. */
  update(dt: number): boolean {
    const app = this.app;
    const { left, right } = app.input;
    const turnHand = right;
    const moveHand = left;
    let moved = false;

    // ---- Turning (right stick x) ----
    const sx = turnHand.connected ? turnHand.stick.x : 0;
    if (settings.turn === 'smooth') {
      if (Math.abs(sx) > 0.2) {
        this.turn((-Math.sign(sx) * (Math.abs(sx) - 0.2)) / 0.8 * tuning.smoothTurnSpeed * DEG * dt);
        moved = true;
      }
    } else if (this.turnArmed && Math.abs(sx) > 0.7 && Math.abs(turnHand.stick.y) < 0.6) {
      const deg = settings.turn === 'snap30' ? 30 : tuning.snapTurnDegrees;
      this.turn(-Math.sign(sx) * deg * DEG);
      this.turnArmed = false;
      moved = true;
      bus.emit('snap-turn', { deg: -Math.sign(sx) * deg });
    } else if (Math.abs(sx) < 0.3) this.turnArmed = true;

    // ---- The body steps after the head once it leans past LEAN_FREE (never off a ledge) ----
    let head = app.headPosition(_head);
    let feet = app.physics.playerFeet(_feet);
    let roomStep = 0;
    const offX = head.x - feet.x;
    const offZ = head.z - feet.z;
    const off = Math.hypot(offX, offZ);
    if (off > LEAN_FREE && this.grounded) {
      const k = (off - LEAN_FREE) / off;
      app.physics.movePlayer(_follow.set(offX * k, 0, offZ * k), _moved, true, true);
      roomStep = Math.hypot(_moved.x, _moved.z);
    }

    // ---- The stick (and gravity) move the body, and you with it ----
    _want.set(0, 0, 0);
    let speed = 0;
    this.stickVelocity.set(0, 0, 0);
    if (moveHand.connected) {
      const st = moveHand.stick;
      const mag = Math.min(1, st.length());
      if (mag > 0.12) {
        // Analogue: speed follows how far the stick is pushed (past a small dead zone).
        const k = ((mag - 0.12) / 0.88 / mag) * tuning.moveSpeed;
        const yaw = app.input.headYaw();
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const rx = Math.cos(yaw);
        const rz = -Math.sin(yaw);
        this.stickVelocity.set((fx * -st.y + rx * st.x) * k, 0, (fz * -st.y + rz * st.x) * k);
        _want.addScaledVector(this.stickVelocity, dt);
        speed = this.stickVelocity.length() / tuning.moveSpeed;
      }
    }
    // Gravity (on the ground the controller's snap keeps you down; pushing down too stops it stepping up).
    this.vy = this.grounded ? 0 : Math.max(this.vy - 9.81 * dt, -20);
    _want.y = this.vy * dt;

    this.grounded = app.physics.movePlayer(_want, _moved, this.grounded);
    if (this.grounded) this.vy = 0;
    const after = app.physics.playerFeet(_feet);

    // The rig carries your head along with the stick's move (not the follow step: your head
    // is already where it is). Height follows quickly but not instantly, so each stair step
    // is a short glide, not a 25 cm pop (big changes, like a fall or a placement, snap).
    const dx = _moved.x;
    const dz = _moved.z;
    roomStep += Math.hypot(dx, dz);
    const targetY = after.y + app.floorOffset;
    const dy = targetY - app.rig.position.y;
    const y = Math.abs(dy) > 0.6 ? targetY : app.rig.position.y + dy * damp(22, dt);
    if (Math.hypot(dx, dz) > 1e-5 || Math.abs(y - app.rig.position.y) > 1e-5) {
      app.rig.position.x += dx;
      app.rig.position.z += dz;
      app.rig.position.y = Math.abs(targetY - y) < 1e-4 ? targetY : y;
      app.updateRig();
      moved = true;
    }

    // ---- The head: a ball that can't go into walls or lean out too far ----
    head = app.headPosition(_head);
    feet = after;
    // From the body's column at head height (over a railing, under a beam) to the head.
    _start.set(feet.x, head.y, feet.z);
    _dir.set(head.x - feet.x, 0, head.z - feet.z);
    const reach = _dir.length();
    this.pushback = 0;
    if (reach > 1e-4) {
      _dir.multiplyScalar(1 / reach);
      const free = Math.min(app.physics.headRoom(_start, _dir, reach, HEAD_RADIUS), LEAN_MAX);
      if (free < reach - 1e-4) {
        this.pushback = reach - free;
        app.rig.position.x -= _dir.x * this.pushback;
        app.rig.position.z -= _dir.z * this.pushback;
        app.updateRig();
        moved = true;
      }
    }
    this.distance += roomStep;
    this.stepAcc += roomStep;
    if (this.grounded && this.stepAcc > 0.62) {
      this.stepAcc = 0;
      footstep(after, clamp(0.5 + speed, 0.5, 1));
    }

    // Fell out of the world: back to the start.
    if (after.y < app.level.bounds.min.y - 20) this.recenter();

    this.comfort(dt, speed);
    return moved || this.fadeDir !== 0;
  }

  /** Rotate the rig about the head (so you turn in place). */
  turn(angle: number): void {
    const rig = this.app.rig;
    const head = this.app.headPosition(_head);
    const dx = rig.position.x - head.x;
    const dz = rig.position.z - head.z;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    rig.position.x = head.x + dx * c + dz * s;
    rig.position.z = head.z - dx * s + dz * c;
    rig.rotation.y += angle;
    this.app.updateRig();
  }

  /** Blink back to the level's spawn point. */
  recenter(): void {
    this.blink(() => {
      const sp = this.app.level.spawn;
      this.placeAt(sp.position, sp.yaw);
      bus.emit('recenter');
    });
  }

  blink(fn: () => void): void {
    this.onFaded = fn;
    this.fadeDir = 1;
  }

  private comfort(dt: number, speed: number): void {
    const target = settings.vignette ? clamp(speed, 0, 1) * VIGNETTE_STRENGTH : 0;
    this.vignette += (target - this.vignette) * damp(target > this.vignette ? 10 : 5, dt);
    if (this.fadeDir > 0) {
      this.fade = Math.min(1, this.fade + dt / 0.12);
      if (this.fade >= 1) {
        this.onFaded?.();
        this.onFaded = null;
        this.fadeDir = -1;
      }
    } else if (this.fadeDir < 0) {
      this.fade = Math.max(0, this.fade - dt / 0.25);
      if (this.fade <= 0) this.fadeDir = 0;
    }
    this.overlayUniforms.uVignette.value = this.vignette;
    this.overlayUniforms.uFade.value = this.fade;
    this.overlay.visible = this.app.inXR && (this.vignette > 0.01 || this.fade > 0.001);
  }

  reset(): void {
    this.fade = 0;
    this.fadeDir = 0;
    this.onFaded = null;
    this.vignette = 0;
    this.overlay.visible = false;
  }
}
