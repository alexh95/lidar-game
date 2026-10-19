import {
  Bone,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  TorusGeometry,
  Uint16BufferAttribute,
  Vector3,
  CylinderGeometry,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { damp, DEG } from '../core/math';
import type { HandInput } from '../input/xr-input';

/**
 * Procedural, skinned glove hand. One draw call per hand plus a glowing cuff.
 *
 * Modelled in a "hand frame" (fingers along -Y, knuckles along Z, back of the
 * right hand +X, wrist +Y), then tilted into WebXR grip space. In a real power
 * grip the handle crosses the palm diagonally, so grip space (handle along Z,
 * -Z toward the thumb) is the hand frame rotated ~40° about X: an extended
 * index finger then points along the controller's aim ray, and the cuff lines
 * up with the forearm. The left hand is the mirror image.
 *
 * Finger curl comes from the controller's capacitive sensing (touch) and
 * analog values, or, when the runtime exposes articulated joints, from the
 * measured joint angles.
 */

export interface FingerCurls {
  thumb: number;
  index: number;
  middle: number;
  ring: number;
  pinky: number;
  /** 0 = thumb lifted, 1 = thumb resting on the face buttons / stick. */
  thumbDown: number;
}

interface Chain {
  bones: Bone[];
  rest: Quaternion[];
  lengths: number[];
  /** Max flex per joint (radians) at curl = 1. */
  maxFlex: number[];
  /** Flex at curl = 0 (natural relaxed bend). */
  baseFlex: number[];
  /** Live flex angles, possibly from joint tracking. */
  flex: number[];
}

const FINGERS = ['index', 'middle', 'ring', 'pinky'] as const;
type FingerName = (typeof FINGERS)[number];

// Right-hand bind layout (metres, grip space).
const MCP: Record<FingerName, Vector3> = {
  index: new Vector3(0.03, -0.006, -0.027),
  middle: new Vector3(0.031, -0.011, -0.008),
  ring: new Vector3(0.03, -0.008, 0.011),
  pinky: new Vector3(0.027, 0.002, 0.028),
};
const LENGTHS: Record<FingerName, number[]> = {
  index: [0.041, 0.024, 0.02],
  middle: [0.045, 0.028, 0.021],
  ring: [0.042, 0.026, 0.02],
  pinky: [0.033, 0.019, 0.018],
};
const RADIUS: Record<FingerName, number> = { index: 0.0088, middle: 0.0092, ring: 0.0086, pinky: 0.0076 };
const SPLAY: Record<FingerName, number> = { index: -5 * DEG, middle: 0, ring: 4 * DEG, pinky: 9 * DEG };

const THUMB_BASE = new Vector3(0.022, 0.045, -0.03);
const THUMB_LENGTHS = [0.04, 0.03, 0.025];
const THUMB_RADIUS = 0.0102;
// Thumb direction (hand frame, right hand) when lifted vs resting on the controller's face.
// In the hand frame -Y is forward (fingers), -Z is up (top of the fist), -X is the palm side.
const THUMB_UP_DIR = new Vector3(-0.08, -0.82, -0.56).normalize();
const THUMB_DOWN_DIR = new Vector3(-0.42, -0.87, -0.22).normalize();
/** Hand frame → grip frame: rotate about X so the fingers point along the aim ray. */
const HAND_TILT = 40 * DEG;
/** Point in the hand frame (right hand) that sits on the grip origin: inside the curled fingers. */
const FIST_CENTER = new Vector3(0.006, -0.006, 0);

const _m = new Matrix4();
const _q = new Quaternion();
const _v = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const Z = new Vector3(0, 0, 1);

/** Frame whose local -Y is `dir` and local +Z is `axis` (axis ⟂ dir). */
function frameQuat(dir: Vector3, axis: Vector3, out: Quaternion): Quaternion {
  const y = _v.copy(dir).negate();
  const z = _v2.copy(axis);
  const x = _v3.crossVectors(y, z).normalize();
  z.crossVectors(x, y).normalize();
  _m.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_m);
}

export class HandModel {
  readonly root = new Group();
  readonly mesh: SkinnedMesh;
  readonly cuffGlow: Mesh;
  private readonly chains: Record<FingerName | 'thumb', Chain>;
  private readonly thumbUp = new Quaternion();
  private readonly thumbDownQ = new Quaternion();
  readonly curls: FingerCurls = { thumb: 0.2, index: 0.2, middle: 0.4, ring: 0.4, pinky: 0.4, thumbDown: 0.5 };
  private readonly glowColor = new Color(0x58e6ff);
  /** Use measured joint angles instead of button-driven curls. */
  jointDriven = false;

  constructor(readonly side: 'left' | 'right', material: MeshStandardMaterial) {
    const s = side === 'right' ? 1 : -1;
    const mirror = (v: Vector3) => new Vector3(v.x * s, v.y, v.z);

    const bones: Bone[] = [];
    const pieces: BufferGeometry[] = [];
    const wrist = new Bone();
    wrist.name = `${side}-wrist`;
    bones.push(wrist);

    const addPiece = (geo: BufferGeometry, boneIndex: number, matrix: Matrix4) => {
      const g = geo.index ? geo.toNonIndexed() : geo;
      g.deleteAttribute('uv');
      g.applyMatrix4(matrix);
      const n = g.getAttribute('position').count;
      const si = new Uint16Array(n * 4);
      const sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        si[i * 4] = boneIndex;
        sw[i * 4] = 1;
      }
      g.setAttribute('skinIndex', new Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new Float32BufferAttribute(sw, 4));
      pieces.push(g);
    };

    // Palm.
    const palm = new RoundedBoxGeometry(0.027, 0.088, 0.08, 3, 0.011);
    addPiece(palm, 0, new Matrix4().makeTranslation(0.031 * s, 0.035, 0.0005));
    // Cuff.
    const cuff = new CylinderGeometry(0.027, 0.03, 0.03, 14, 1, false);
    const cuffM = new Matrix4().compose(new Vector3(0.027 * s, 0.09, 0.001), new Quaternion(), new Vector3(0.72, 1, 1.18));
    addPiece(cuff, 0, cuffM);

    const buildChain = (name: string, base: Vector3, dir: Vector3, axis: Vector3, lengths: number[], radius: number, maxFlex: number[], baseFlex: number[]): Chain => {
      const chain: Chain = { bones: [], rest: [], lengths, maxFlex, baseFlex, flex: baseFlex.slice() };
      let parent = wrist;
      const restQ = frameQuat(dir, axis, new Quaternion());
      // World-space (bind) accumulation for placing geometry.
      const bindPos = base.clone();
      const bindQ = restQ.clone();
      for (let i = 0; i < lengths.length; i++) {
        const b = new Bone();
        b.name = `${side}-${name}-${i}`;
        if (i === 0) {
          b.position.copy(base);
          b.quaternion.copy(restQ);
        } else {
          b.position.set(0, -lengths[i - 1], 0);
        }
        chain.rest.push(b.quaternion.clone());
        parent.add(b);
        parent = b;
        bones.push(b);
        chain.bones.push(b);
        // Segment geometry in bind pose.
        const r = radius * (1 - i * 0.08);
        const geo = new CapsuleGeometry(r, Math.max(lengths[i] - r * 0.6, 0.002), 3, 10, 1);
        const local = new Matrix4().makeTranslation(0, -lengths[i] / 2, 0);
        const world = new Matrix4().compose(bindPos, bindQ, new Vector3(1, 1, 1)).multiply(local);
        addPiece(geo, bones.length - 1, world);
        bindPos.add(new Vector3(0, -lengths[i], 0).applyQuaternion(bindQ));
      }
      return chain;
    };

    // Fingers: flex axis = dir × palm-normal (curls toward the palm).
    const palmNormal = new Vector3(-s, 0, 0);
    const chains = {} as Record<FingerName | 'thumb', Chain>;
    for (const f of FINGERS) {
      // Splay is about X, the same for both hands (mirroring X doesn't move the index off -Z).
      const dir = new Vector3(0, -1, 0).applyAxisAngle(new Vector3(1, 0, 0), -SPLAY[f]);
      const axis = new Vector3().crossVectors(dir, palmNormal).normalize();
      chains[f] = buildChain(f, mirror(MCP[f]), dir, axis, LENGTHS[f], RADIUS[f], [85 * DEG, 100 * DEG, 70 * DEG], [6 * DEG, 10 * DEG, 6 * DEG]);
    }
    // Thumb: its own frame, blended between lifted and resting.
    const tUp = mirror(THUMB_UP_DIR).normalize();
    const tDown = mirror(THUMB_DOWN_DIR).normalize();
    // The thumb is opposable: it doesn't fold toward the palm like a finger, it swings
    // *across* it toward the pinky side (+Z) and a little into it, so its tip meets the
    // fingers. Its flex axis is chosen so positive flex moves the tip that way.
    const opposeToward = new Vector3(0, 0.12, 0.86).addScaledVector(palmNormal, 0.5).normalize();
    const thumbAxis = (d: Vector3) => new Vector3().crossVectors(d, opposeToward).normalize();
    frameQuat(tUp, thumbAxis(tUp), this.thumbUp);
    frameQuat(tDown, thumbAxis(tDown), this.thumbDownQ);
    chains.thumb = buildChain('thumb', mirror(THUMB_BASE), tUp, thumbAxis(tUp), THUMB_LENGTHS, THUMB_RADIUS, [30 * DEG, 45 * DEG, 70 * DEG], [5 * DEG, 8 * DEG, 10 * DEG]);
    this.chains = chains;

    // Both hands are built from proper rotations (no negative scale), so the
    // winding is already correct on the left.
    const merged = mergeGeometries(pieces, false)!;
    merged.computeBoundingSphere();

    const mesh = new SkinnedMesh(merged, material);
    mesh.name = `${side}-hand`;
    mesh.add(wrist);
    mesh.updateMatrixWorld(true);
    mesh.bind(new Skeleton(bones));
    // Hand frame → grip space (bones are children, so they follow).
    mesh.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), HAND_TILT);
    mesh.position.copy(new Vector3(FIST_CENTER.x * s, FIST_CENTER.y, FIST_CENTER.z).applyQuaternion(mesh.quaternion).negate());
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    this.mesh = mesh;

    // Glowing ring around the cuff (gravity-glove indicator).
    this.cuffGlow = new Mesh(new TorusGeometry(0.028, 0.003, 6, 24), new MeshBasicMaterial({ color: this.glowColor, toneMapped: false }));
    this.cuffGlow.position.set(0.027 * s, 0.08, 0.001);
    this.cuffGlow.rotation.x = Math.PI / 2;
    this.cuffGlow.scale.set(0.75, 1.2, 1);
    wrist.add(this.cuffGlow);

    this.root.name = `${side}-hand-root`;
    this.root.add(mesh);
    this.root.visible = false;
  }

  setGlow(color: number, intensity = 1): void {
    (this.cuffGlow.material as MeshBasicMaterial).color.setHex(color).multiplyScalar(intensity);
  }

  /** Target curls from controller buttons (and what we're holding). */
  curlsFromInput(h: HandInput, holding: boolean, out: FingerCurls): FingerCurls {
    const t = h.trigger;
    const g = h.squeeze;
    // Index: extended when lifted off the trigger (capacitive), curling with pull.
    if (t.touchSeen) out.index = t.touched || t.value > 0.02 ? 0.3 + 0.7 * t.value : 0.02;
    else out.index = 0.25 + 0.75 * t.value;
    // Middle/ring/pinky follow the grip: wrapped around the handle when touching.
    let grip: number;
    if (g.touchSeen) grip = g.touched || g.value > 0.02 ? 0.55 + 0.45 * g.value : 0.1;
    else grip = 0.45 + 0.55 * g.value;
    if (holding) grip = Math.max(grip, 0.72);
    out.middle = grip;
    out.ring = grip * 1.02;
    out.pinky = grip * 1.05;
    const anyThumbTouch = h.a.touched || h.b.touched || h.stickClick.touched || h.thumbrest.touched || Math.abs(h.stick.x) + Math.abs(h.stick.y) > 0.1;
    const thumbInfo = h.a.touchSeen || h.b.touchSeen || h.stickClick.touchSeen || h.thumbrest.touchSeen;
    out.thumbDown = thumbInfo ? (anyThumbTouch ? 1 : 0) : 0.75;
    out.thumb = holding ? 0.6 : out.thumbDown * 0.35 + (h.a.pressed || h.b.pressed || h.stickClick.pressed ? 0.25 : 0);
    if (holding) out.thumbDown = Math.max(out.thumbDown, 0.6);
    return out;
  }

  private readonly target: FingerCurls = { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0, thumbDown: 0 };

  /**
   * Place the hand at the grip pose and animate the fingers.
   * Fingers follow measured joints when the runtime provides them (and `preferJoints`),
   * otherwise the controller's touch and analog values.
   */
  update(h: HandInput, gripWorld: Matrix4, rigScale: number, holding: boolean, dt: number, preferJoints = true): void {
    this.root.visible = h.grip.valid;
    if (!h.grip.valid) return;
    gripWorld.decompose(this.root.position, this.root.quaternion, _v);
    this.root.scale.setScalar(rigScale);

    // Hands without a gamepad (pure hand tracking) always follow their joints.
    this.jointDriven = h.jointsValid && (preferJoints || !h.hasGamepad);
    const k = damp(22, dt);
    if (this.jointDriven) {
      this.flexFromJoints(h, k);
    } else {
      this.curlsFromInput(h, holding, this.target);
      const c = this.curls;
      for (const key of Object.keys(c) as (keyof FingerCurls)[]) c[key] += (this.target[key] - c[key]) * k;
      for (const f of FINGERS) {
        const ch = this.chains[f];
        const curl = c[f];
        for (let i = 0; i < ch.flex.length; i++) ch.flex[i] = ch.baseFlex[i] + ch.maxFlex[i] * curl;
      }
      const th = this.chains.thumb;
      for (let i = 0; i < th.flex.length; i++) th.flex[i] = th.baseFlex[i] + th.maxFlex[i] * c.thumb;
      this.chains.thumb.rest[0].slerpQuaternions(this.thumbUp, this.thumbDownQ, c.thumbDown);
    }
    this.applyFlex();
  }

  private applyFlex(): void {
    for (const key of [...FINGERS, 'thumb'] as const) {
      const ch = this.chains[key];
      for (let i = 0; i < ch.bones.length; i++) {
        _q.setFromAxisAngle(Z, ch.flex[i]);
        ch.bones[i].quaternion.copy(ch.rest[i]).multiply(_q);
      }
    }
  }

  /** Read flex angles from articulated joints (positions only; robust across runtimes). */
  private flexFromJoints(h: HandInput, k: number): void {
    const p = (i: number, out: Vector3) => h.jointPositionRef(i, out);
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const d1 = new Vector3();
    const d2 = new Vector3();
    const angle = (i0: number, i1: number, i2: number) => {
      p(i0, a);
      p(i1, b);
      p(i2, c);
      d1.subVectors(b, a).normalize();
      d2.subVectors(c, b).normalize();
      return Math.acos(Math.min(1, Math.max(-1, d1.dot(d2))));
    };
    // XRHand joint order: finger f has metacarpal at 5+5f, then proximal, intermediate, distal, tip.
    FINGERS.forEach((f, fi) => {
      const base = 5 + fi * 5;
      const ch = this.chains[f];
      const targets = [angle(base, base + 1, base + 2), angle(base + 1, base + 2, base + 3), angle(base + 2, base + 3, base + 4)];
      for (let i = 0; i < 3; i++) ch.flex[i] += (targets[i] - ch.flex[i]) * k;
    });
    const th = this.chains.thumb;
    const tt = [angle(0, 1, 2) * 0.5, angle(1, 2, 3), angle(2, 3, 4)];
    for (let i = 0; i < 3; i++) th.flex[i] += (tt[i] - th.flex[i]) * k;
    th.rest[0].copy(this.thumbUp).slerp(this.thumbDownQ, 0.5);
  }

  /** World position of the index fingertip (for poking UI and instruments). */
  indexTip(out: Vector3): Vector3 {
    const ch = this.chains.index;
    const last = ch.bones[ch.bones.length - 1];
    last.updateWorldMatrix(true, false);
    return out.set(0, -ch.lengths[ch.lengths.length - 1] - 0.004, 0).applyMatrix4(last.matrixWorld);
  }

  /** World palm centre and outward normal. */
  palm(outPos: Vector3, outNormal: Vector3): void {
    const s = this.side === 'right' ? 1 : -1;
    this.mesh.updateWorldMatrix(true, false);
    outPos.set(0.018 * s, 0.03, 0).applyMatrix4(this.mesh.matrixWorld);
    outNormal.set(-s, 0, 0).transformDirection(this.mesh.matrixWorld);
  }

  /** How extended the index finger is (1 = pointing). */
  get pointing(): number {
    return 1 - Math.min(1, this.curls.index * 2.2);
  }
}

export function createHandMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: 0xece7df, roughness: 0.55, metalness: 0.0 });
}
