import {
  AdditiveBlending,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PointLight,
  ShaderMaterial,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { flags, tuning } from '../config';
import { bus } from '../core/events';
import { clamp, DEG, rng, smoothstep } from '../core/math';
import { settings } from '../core/settings';
import type { HandInput } from '../input/xr-input';
import type { RayHit } from '../physics/physics';
import { ScannerSound } from '../audio/sfx';
import type { App } from '../app';

const _o = new Vector3();
const _f = new Vector3();
const _r = new Vector3();
const _u = new Vector3();

const coneVertex = /* glsl */ `
varying float vAlong;
void main() {
  vAlong = -position.z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const coneFragment = /* glsl */ `
uniform float uLevel;
varying float vAlong;
void main() {
  float a = uLevel * pow(1.0 - clamp(vAlong, 0.0, 1.0), 2.2);
  gl_FragColor = vec4(vec3(0.55, 0.6, 0.62) * a, 1.0);
  #include <colorspace_fragment>
}`;

/**
 * The handheld lidar. Hold the trigger to spray rays; squeeze harder to narrow the cone
 * from a wide wash to a tight spot. Each frame it casts as many rays as fit in its time
 * budget, scattered at random over the cone (no fixed pattern, so no moiré and no regular
 * texture for the video encoder to choke on).
 *
 * Hits on ordinary surfaces become permanent dots; hits on entity surfaces become fading
 * dots. The scanner never asks for more rays than the budget allows: the rate adapts to
 * the measured cost per ray.
 */
export class Scanner {
  readonly model = new Group();
  private readonly cone: Mesh;
  private readonly coneUniforms = { uLevel: { value: 0 } };
  private readonly light = new PointLight(0xdfe6ea, 0, 1.4, 2);
  private readonly sound = new ScannerSound();
  private readonly random: () => number;
  private readonly hit: RayHit = { dist: 0, material: 0, entity: false };

  /** 0..1 trigger pressure while scanning, else 0. */
  level = 0;
  scanning = false;
  /** Half-angle of the cone right now (radians). */
  halfAngle = tuning.coneWideDeg * DEG;
  /** Measured cost of one ray (µs, smoothed). */
  usPerRay = 3;
  /** Last frame: rays cast, hits, permanent dots added, fading dots added, time spent (ms). */
  rays = 0;
  hits = 0;
  added = 0;
  faded = 0;
  ms = 0;
  totalRays = 0;
  /** Force a ray count per frame (tests and benchmarks); 0 = adaptive. */
  fixedRays = 0;
  /** Origin and direction of the beam this frame (world). */
  readonly origin = new Vector3();
  readonly direction = new Vector3(0, 0, -1);
  /** Override the trigger (tests): null = read the controller. */
  forceLevel: number | null = null;

  constructor(private readonly app: App) {
    this.random = rng(flags.seed ?? (Math.random() * 2 ** 31) >>> 0);
    this.model.name = 'scanner';
    const body = new MeshStandardMaterial({ color: 0x55585c, roughness: 0.65, metalness: 0.2 });
    const dark = new MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.8 });
    // Modelled in the controller's aim frame: -Z is where the rays go.
    const housing = new BoxGeometry(0.05, 0.045, 0.13).translate(0, -0.018, 0.035);
    const nose = new CylinderGeometry(0.022, 0.026, 0.03, 20).rotateX(Math.PI / 2).translate(0, -0.012, -0.04);
    const grip = new BoxGeometry(0.03, 0.07, 0.035).rotateX(-0.35).translate(0, -0.065, 0.075);
    this.model.add(new Mesh(mergeGeometries([housing, grip]), body), new Mesh(nose, dark));
    const lens = new Mesh(new CylinderGeometry(0.016, 0.016, 0.003, 20).rotateX(Math.PI / 2).translate(0, -0.012, -0.056), new MeshBasicMaterial({ color: 0x9aa4a8, toneMapped: false }));
    this.model.add(lens);
    this.light.position.set(0, -0.012, -0.07);
    this.model.add(this.light);

    // A faint cone of light from the lens that shows the spread (smooth and stable: cheap for
    // the video encoder, unlike per-ray beams that change every frame).
    const coneGeom = new ConeGeometry(1, 1, 32, 1, true).translate(0, -0.5, 0).rotateX(Math.PI / 2);
    this.cone = new Mesh(
      coneGeom,
      new ShaderMaterial({
        vertexShader: coneVertex,
        fragmentShader: coneFragment,
        uniforms: this.coneUniforms,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
      }),
    );
    this.cone.name = 'scanner-cone';
    this.cone.position.set(0, -0.012, -0.058);
    this.cone.frustumCulled = false;
    this.cone.renderOrder = 10;
    this.model.add(this.cone);
    this.model.visible = false;
    app.scene.add(this.model);
  }

  get hand(): HandInput {
    return settings.scannerHand === 'left' ? this.app.input.left : this.app.input.right;
  }

  /** Rays this frame: what fits in the time budget, or the fixed test count. */
  get budget(): number {
    if (this.fixedRays > 0) return this.fixedRays;
    return clamp(Math.floor((tuning.rayBudgetMs * 1000) / Math.max(this.usPerRay, 0.5)), tuning.minRaysPerFrame, tuning.maxRaysPerFrame);
  }

  update(now: number, busy: boolean): void {
    const h = this.hand;
    this.model.visible = h.aim.valid;
    this.rays = this.hits = this.added = this.faded = 0;
    this.ms = 0;
    if (!h.aim.valid) {
      this.stop();
      this.sound.update(this.origin, 0, 0);
      return;
    }
    this.model.position.copy(h.aim.position);
    this.model.quaternion.copy(h.aim.quaternion);
    this.model.scale.setScalar(1);
    this.model.updateMatrixWorld(true);
    this.cone.getWorldPosition(this.origin);
    h.aim.forward(this.direction);

    const pressure = this.forceLevel ?? (busy ? 0 : h.trigger.value);
    const level = pressure > 0.06 ? smoothstep(0.06, 1, pressure) : 0;
    if (level > 0 && !this.scanning) {
      this.scanning = true;
      bus.emit('scan-start', { hand: h.handedness });
    } else if (level === 0) this.stop();
    this.level = level;
    // Squeeze to focus: the cone narrows with pressure.
    this.halfAngle = (tuning.coneWideDeg + (tuning.coneNarrowDeg - tuning.coneWideDeg) * Math.min(1, level * 1.1)) * DEG;

    if (this.scanning) this.cast(now);

    // The cone glow, the lens light and the sound follow the scan.
    const len = 1.1;
    const r = Math.tan(this.halfAngle) * len;
    this.cone.scale.set(r, r, len);
    this.cone.visible = level > 0;
    this.coneUniforms.uLevel.value = 0.05 + 0.05 * level;
    this.light.intensity = level > 0 ? 0.25 + 0.35 * level : 0.06;
    const hitShare = this.rays ? this.hits / this.rays : 0;
    this.sound.update(this.origin, level, hitShare);
    if (level > 0 && this.app.frameCount % 3 === 0) h.pulse(0.03 + 0.12 * hitShare * level, 30);
  }

  private stop(): void {
    if (this.scanning) {
      this.scanning = false;
      bus.emit('scan-stop', { rays: this.totalRays });
    }
    this.level = 0;
  }

  /** Cast this frame's rays from `origin` along `direction` and turn the hits into dots. */
  private cast(now: number): void {
    const n = this.budget;
    const f = _f.copy(this.direction);
    // A basis around the beam.
    const q = this.hand.aim.quaternion;
    const right = _r.set(1, 0, 0).applyQuaternion(q);
    const up = _u.set(0, 1, 0).applyQuaternion(q);
    const o = _o.copy(this.origin);
    const tanHalf = Math.tan(this.halfAngle);
    const physics = this.app.physics;
    const store = this.app.cloud;
    const fading = this.app.fading;
    const hit = this.hit;
    const range = tuning.scanRange;
    const t0 = performance.now();
    let hits = 0;
    let added = 0;
    let faded = 0;
    for (let i = 0; i < n; i++) {
      // Uniform random over the disc. A golden-angle spiral (even coverage per frame) left
      // visible arcs in the accumulated cloud; random hits fill the dedup cells without any
      // structure for the eye, or the video encoder, to lock onto.
      const rad = tanHalf * Math.sqrt(this.random());
      const ang = this.random() * Math.PI * 2;
      const c = Math.cos(ang) * rad;
      const s = Math.sin(ang) * rad;
      let dx = f.x + right.x * c + up.x * s;
      let dy = f.y + right.y * c + up.y * s;
      let dz = f.z + right.z * c + up.z * s;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
      dx *= inv;
      dy *= inv;
      dz *= inv;
      if (!physics.cast(o.x, o.y, o.z, dx, dy, dz, range, hit)) continue;
      hits++;
      const x = o.x + dx * hit.dist;
      const y = o.y + dy * hit.dist;
      const z = o.z + dz * hit.dist;
      if (hit.entity) {
        fading.add(x, y, z, hit.material, now);
        faded++;
      } else if (store.add(x, y, z, hit.material, now)) added++;
    }
    const ms = performance.now() - t0;
    this.ms = ms;
    this.rays = n;
    this.hits = hits;
    this.added = added;
    this.faded = faded;
    this.totalRays += n;
    if (n >= 32) this.usPerRay += ((ms * 1000) / n - this.usPerRay) * 0.15;
    if (store.full && !this.wasFull) bus.emit('cloud-full', { total: store.total });
    this.wasFull = store.full;
  }

  private wasFull = false;
}
