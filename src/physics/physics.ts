import RAPIER from '@dimforge/rapier3d-compat';
import type { Quaternion, Vector3 } from 'three';
import { tuning } from '../config';
import { DEG } from '../core/math';

export { RAPIER };

/**
 * Collision groups, (membership << 16) | filter:
 * - SURFACE: level geometry. Scanned by rays and solid to the player.
 * - ENTITY: moving things. Scanned, but the player passes through (a closing thing
 *   can't trap you; place entities out of reach).
 * - BLOCKER: invisible walls. Solid to the player, never scanned.
 * - PLAYER: the walking body (a cylinder).
 */
const SURFACE = 0x0001;
const ENTITY = 0x0002;
const BLOCKER = 0x0004;
const PLAYER = 0x0008;
const RAY = 0x0010;
const groups = (member: number, filter: number) => (member << 16) | filter;

export const GROUPS = {
  surface: groups(SURFACE, RAY | PLAYER),
  entity: groups(ENTITY, RAY),
  blocker: groups(BLOCKER, PLAYER),
  player: groups(PLAYER, SURFACE | BLOCKER),
  ray: groups(RAY, SURFACE | ENTITY),
};

export interface SurfaceInfo {
  /** Index into MATERIALS. */
  material: number;
  entity: boolean;
}

/** Result of a scanner ray (reused, never allocated per ray). */
export interface RayHit {
  dist: number;
  material: number;
  entity: boolean;
}

/**
 * Rapier world for the level: static trimeshes, kinematic entity bodies, the player's
 * body and its character controller, and the scanner's ray casts. Nothing here is
 * dynamic, so a world step is cheap: it only moves the kinematic bodies and refreshes
 * the broad phase the ray casts use.
 */
export class Physics {
  readonly world: RAPIER.World;
  readonly info = new Map<number, SurfaceInfo>();
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  readonly controller: RAPIER.KinematicCharacterController;
  playerBody!: RAPIER.RigidBody;
  playerCollider!: RAPIER.Collider;

  static async create(): Promise<Physics> {
    await RAPIER.init();
    return new Physics();
  }

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 90;
    this.controller = this.world.createCharacterController(0.02);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    // Steps are climbed by movePlayer's own step-up: Rapier's autostep doesn't climb while
    // snap-to-ground is on (measured: it twitches 2 cm up at the first riser and stops).
    this.controller.disableAutostep();
    this.controller.enableSnapToGround(0.35);
    this.controller.setMaxSlopeClimbAngle(tuning.maxSlopeDeg * DEG);
    this.controller.setMinSlopeSlideAngle(60 * DEG);
    this.controller.setSlideEnabled(true);
    this.controller.setApplyImpulsesToDynamicBodies(false);
    this.createPlayer();
  }

  private createPlayer(): void {
    this.playerBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, tuning.bodyHeight / 2, 0));
    // A cylinder, not a capsule: its flat bottom gets over a step's edge as soon as it's
    // lifted past it, where a capsule's round bottom rolls back off the edge.
    this.playerCollider = this.world.createCollider(
      RAPIER.ColliderDesc.cylinder(tuning.bodyHeight / 2, tuning.bodyRadius).setCollisionGroups(GROUPS.player),
      this.playerBody,
    );
  }

  /** Level geometry (world-space vertices). Blockers are solid to the player but never scanned. */
  addStatic(vertices: Float32Array, indices: Uint32Array, material: number, blocker = false): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices).setCollisionGroups(blocker ? GROUPS.blocker : GROUPS.surface);
    const c = this.world.createCollider(desc);
    if (!blocker) this.info.set(c.handle, { material, entity: false });
    return c;
  }

  /**
   * A moving thing: a kinematic body carrying a trimesh in its own frame (vertices already
   * scaled; Rapier colliders don't scale). `entity` surfaces are ray-only (see GROUPS).
   */
  addKinematic(vertices: Float32Array, indices: Uint32Array, material: number, entity: boolean): RAPIER.RigidBody {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices).setCollisionGroups(entity ? GROUPS.entity : GROUPS.surface);
    const c = this.world.createCollider(desc, body);
    this.info.set(c.handle, { material, entity });
    return body;
  }

  /** Move a kinematic body; it gets there on the next step. */
  static place(body: RAPIER.RigidBody, pos: Vector3, quat: Quaternion, immediate = false): void {
    if (immediate) {
      body.setTranslation(pos, true);
      body.setRotation(quat, true);
    }
    // Also the target of the next step, or the step would carry it back to an older target.
    body.setNextKinematicTranslation(pos);
    body.setNextKinematicRotation(quat);
  }

  /** Move kinematic bodies to their targets and refresh the broad phase for ray casts. */
  step(): void {
    this.world.step();
  }

  /**
   * One scanner ray against surfaces and entities. Writes into `out` and returns true on a
   * hit. Reuses a single Ray: the hot path allocates only Rapier's own hit object.
   */
  cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, out: RayHit): boolean {
    const r = this.ray;
    r.origin.x = ox;
    r.origin.y = oy;
    r.origin.z = oz;
    r.dir.x = dx;
    r.dir.y = dy;
    r.dir.z = dz;
    const hit = this.world.castRay(r, maxDist, true, undefined, GROUPS.ray);
    if (!hit) return false;
    const info = this.info.get(hit.collider.handle);
    out.dist = hit.timeOfImpact;
    out.material = info?.material ?? 0;
    out.entity = info?.entity ?? false;
    return true;
  }

  /**
   * Move the player's body by `delta` with collision, slopes, ground snapping and steps
   * up to tuning.stepHeight. Writes the movement actually made into `out`; returns whether
   * the body ends on the ground.
   *
   * Steps: when a grounded move is mostly blocked, try it again lifted by the step height,
   * then settle back down. Keep that only if it got further and ended on the ground no more
   * than a step higher (so walls and benches still block).
   */
  movePlayer(delta: Vector3, out: Vector3, wasGrounded: boolean): boolean {
    const t = this.playerBody.translation();
    const sx = t.x;
    const sy = t.y;
    const sz = t.z;
    let grounded = this.moveBy(delta.x, delta.y, delta.z);
    const m1 = this.controller.computedMovement();
    let mx = m1.x;
    let my = m1.y;
    let mz = m1.z;
    const wanted = Math.hypot(delta.x, delta.z);
    const got = Math.hypot(mx, mz);
    if (wasGrounded && wanted > 1e-5 && got < wanted * 0.7) {
      const h = tuning.stepHeight;
      this.setBodyAt(sx, sy, sz);
      this.moveBy(0, h, 0);
      const rise = this.controller.computedMovement().y;
      this.moveBy(delta.x, 0, delta.z);
      const hm = this.controller.computedMovement();
      const across = Math.hypot(hm.x, hm.z);
      const landed = this.moveBy(0, -(rise + 0.02), 0);
      const e = this.playerBody.translation();
      const climbed = e.y - sy;
      if (landed && across > got + 0.002 && climbed > 0.005 && climbed <= h + 0.01) {
        mx = e.x - sx;
        my = climbed;
        mz = e.z - sz;
        grounded = true;
      } else {
        this.setBodyAt(sx + mx, sy + my, sz + mz);
      }
    }
    out.set(mx, my, mz);
    return grounded;
  }

  /** One controller move from where the body is now; applies it and returns grounded. */
  private moveBy(x: number, y: number, z: number): boolean {
    this.controller.computeColliderMovement(this.playerCollider, { x, y, z }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, GROUPS.player);
    const m = this.controller.computedMovement();
    const t = this.playerBody.translation();
    this.setBodyAt(t.x + m.x, t.y + m.y, t.z + m.z);
    return this.controller.computedGrounded();
  }

  /** Set the player body's translation now (not "next"), so the next query starts there. */
  private setBodyAt(x: number, y: number, z: number): void {
    this.playerBody.setTranslation({ x, y, z }, true);
    this.world.propagateModifiedBodyPositionsToColliders();
  }

  /** Put the body's feet at a point (spawn, recenter), with no collision. */
  placePlayer(feet: Vector3): void {
    this.playerBody.setTranslation({ x: feet.x, y: feet.y + tuning.bodyHeight / 2 + 0.02, z: feet.z }, true);
    this.world.propagateModifiedBodyPositionsToColliders();
  }

  /** The body's feet (world). */
  playerFeet(out: Vector3): Vector3 {
    const t = this.playerBody.translation();
    return out.set(t.x, t.y - tuning.bodyHeight / 2 - 0.02, t.z);
  }
}
