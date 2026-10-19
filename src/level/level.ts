import {
  AnimationMixer,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PropertyBinding,
  Quaternion,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Physics, type RAPIER } from '../physics/physics';
import { isEntityMaterial, materialIndex, MATERIALS } from './materials';

/**
 * A level authored in Blender and exported to public/levels/<name>.glb (see levels/README.md).
 *
 * Nothing in it is ever drawn in colour. Its triangles become:
 * - Rapier colliders the scanner's rays hit and the player walks on;
 * - a depth-only pass drawn before the dots, so dots behind walls you haven't scanned stay
 *   hidden (the "occlusion" setting);
 * - material indices from the Blender material names, for the dots' colours.
 * Animated objects (any object with an action) move with their animation and carry
 * kinematic colliders, so rays hit them where they are now.
 */

export interface Spawn {
  position: Vector3;
  yaw: number;
}

export interface MovingPart {
  mesh: Mesh;
  body: RAPIER.RigidBody;
  material: number;
  entity: boolean;
}

const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _m = new Matrix4();

function nameChain(o: Object3D): string[] {
  const names: string[] = [];
  for (let n: Object3D | null = o; n; n = n.parent) names.push(n.name);
  return names;
}

function indicesOf(g: BufferGeometry): ArrayLike<number> {
  if (g.index) return g.index.array;
  const n = g.getAttribute('position').count;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  return idx;
}

/** Accumulates world-space triangles, then hands them out as typed arrays. */
class TriBuilder {
  readonly pos: number[] = [];
  readonly idx: number[] = [];
  add(g: BufferGeometry, m: Matrix4): void {
    const p = g.getAttribute('position');
    const base = this.pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      _p.fromBufferAttribute(p, i).applyMatrix4(m);
      this.pos.push(_p.x, _p.y, _p.z);
    }
    const idx = indicesOf(g);
    for (let i = 0; i < idx.length; i++) this.idx.push(base + idx[i]);
  }
  get triangles(): number {
    return this.idx.length / 3;
  }
  vertices(): Float32Array {
    return new Float32Array(this.pos);
  }
  indices(): Uint32Array {
    return new Uint32Array(this.idx);
  }
}

export class Level {
  /** Depth-only stand-ins for the level's surfaces (static merged + the moving parts). */
  readonly root = new Group();
  readonly moving: MovingPart[] = [];
  readonly bounds = new Box3();
  readonly spawn: Spawn = { position: new Vector3(), yaw: 0 };
  triangles = 0;
  /** Names of the materials the level uses (for the probe and the self-test). */
  readonly materialsUsed = new Set<string>();
  private mixer: AnimationMixer | null = null;
  time = 0;
  readonly depthMaterial = new MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    // Dots sit exactly on these surfaces: push the surfaces back a little so a dot never
    // loses the depth test against the wall it lies on.
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
  });

  private constructor(
    readonly name: string,
    /** Content hash of the .glb: a saved scan only loads onto the exact level it was made in. */
    readonly hash: string,
  ) {
    this.root.name = `level:${name}`;
  }

  static async load(name: string, physics: Physics): Promise<Level> {
    const url = `${import.meta.env.BASE_URL}levels/${name}.glb`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`level "${name}" not found (${url}: ${resp.status})`);
    const buffer = await resp.arrayBuffer();
    const level = new Level(name, await hashOf(buffer));
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    level.build(gltf.scene, gltf.animations, physics);
    return level;
  }

  private build(scene: Group, animations: import('three').AnimationClip[], physics: Physics): void {
    scene.updateMatrixWorld(true);
    const animated = new Set<string>();
    for (const clip of animations) for (const t of clip.tracks) animated.add(PropertyBinding.parseTrackName(t.name).nodeName);
    const isAnimated = (o: Object3D) => nameChain(o).some((n) => animated.has(n));

    const staticByMaterial = new Map<number, TriBuilder>();
    const blockers = new TriBuilder();
    const depth = new TriBuilder();
    const meshes: Mesh[] = [];
    scene.traverse((o) => {
      if ((o as Mesh).isMesh) meshes.push(o as Mesh);
      if (o.name.startsWith('SPAWN')) {
        o.getWorldPosition(this.spawn.position);
        const f = new Vector3(0, 0, -1).applyQuaternion(o.getWorldQuaternion(_q));
        this.spawn.yaw = Math.atan2(-f.x, -f.z);
      }
    });

    for (const mesh of meshes) {
      const names = nameChain(mesh);
      if (names.some((n) => n.startsWith('X_'))) {
        mesh.removeFromParent();
        continue;
      }
      const g = mesh.geometry;
      const matName = Array.isArray(mesh.material) ? mesh.material[0]?.name : mesh.material?.name;
      const material = materialIndex(matName);
      this.materialsUsed.add(MATERIALS[material].name);
      const blocker = names.some((n) => n.startsWith('BLOCK_'));
      const tris = indicesOf(g).length / 3;
      this.triangles += tris;
      if (isAnimated(mesh)) {
        // Collider in the mesh's own frame, with its world scale baked in.
        mesh.matrixWorld.decompose(_p, _q, _s);
        const p = g.getAttribute('position');
        const verts = new Float32Array(p.count * 3);
        for (let i = 0; i < p.count; i++) {
          verts[i * 3] = p.getX(i) * _s.x;
          verts[i * 3 + 1] = p.getY(i) * _s.y;
          verts[i * 3 + 2] = p.getZ(i) * _s.z;
        }
        const entity = isEntityMaterial(material);
        const body = physics.addKinematic(verts, new Uint32Array(indicesOf(g)), material, entity);
        Physics.place(body, _p, _q, true);
        mesh.material = this.depthMaterial;
        mesh.renderOrder = -10;
        mesh.frustumCulled = true;
        this.moving.push({ mesh, body, material, entity });
        continue;
      }
      // Static: baked into world space and merged.
      if (blocker) {
        blockers.add(g, mesh.matrixWorld);
      } else {
        let b = staticByMaterial.get(material);
        if (!b) staticByMaterial.set(material, (b = new TriBuilder()));
        b.add(g, mesh.matrixWorld);
        depth.add(g, mesh.matrixWorld);
      }
      mesh.removeFromParent();
    }

    for (const [material, b] of staticByMaterial) physics.addStatic(b.vertices(), b.indices(), material);
    if (blockers.triangles) physics.addStatic(blockers.vertices(), blockers.indices(), 0, true);

    const merged = new BufferGeometry();
    merged.setAttribute('position', new BufferAttribute(depth.vertices(), 3));
    merged.setIndex(new BufferAttribute(depth.indices(), 1));
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    this.bounds.copy(merged.boundingBox!);
    const staticMesh = new Mesh(merged, this.depthMaterial);
    staticMesh.name = 'level-static-depth';
    staticMesh.renderOrder = -10;
    this.root.add(staticMesh, scene);

    if (animations.length) {
      this.mixer = new AnimationMixer(scene);
      for (const clip of animations) this.mixer.clipAction(clip).play();
    }
  }

  /** Advance animations and move the kinematic colliders to match (they arrive on the next physics step). */
  update(dt: number): void {
    if (!this.mixer) return;
    this.time += dt;
    this.mixer.update(dt);
    this.syncBodies(false);
  }

  /** Jump every animation to time `t` (tests). */
  setTime(t: number): void {
    this.time = t;
    if (!this.mixer) return;
    this.mixer.setTime(t);
    this.syncBodies(true);
  }

  private syncBodies(immediate: boolean): void {
    for (const part of this.moving) {
      part.mesh.updateWorldMatrix(true, false);
      _m.copy(part.mesh.matrixWorld).decompose(_p, _q, _s);
      Physics.place(part.body, _p, _q, immediate);
    }
  }

  /** World position of a moving part's origin (tests, the probe). */
  partPosition(name: string, out: Vector3): Vector3 | null {
    const part = this.moving.find((m) => m.mesh.name === name || m.mesh.parent?.name === name);
    if (!part) return null;
    return part.mesh.getWorldPosition(out);
  }
}

async function hashOf(buffer: ArrayBuffer): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // No SubtleCrypto (insecure context): FNV-1a over the bytes.
    const bytes = new Uint8Array(buffer);
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
    return (h >>> 0).toString(16).padStart(8, '0') + bytes.length.toString(16);
  }
}
