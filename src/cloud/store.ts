import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, Points, Sphere, type ShaderMaterial, Vector3 } from 'three';
import { attachViewportHook, type DotUniforms } from './dots';

/**
 * The persistent point cloud: the source of truth for every dot that stays.
 *
 * Space is cut into 8 m chunks. Each chunk has:
 * - a dedup set of occupied cells (2.5 cm by default). A hit in an occupied cell is
 *   dropped, so the cloud grows with the surface area you've scanned, not the time you've
 *   spent scanning, and rescanning costs nothing;
 * - blocks of up to 65,536 dots, each its own THREE.Points (one draw call per eye) with a
 *   bounding sphere around the whole chunk, so off-screen chunks are culled.
 * A block's arrays start small and double as they fill (4k up to 64k dots). New dots are
 * written at the end and only that range is uploaded (addUpdateRange); a block is never
 * re-uploaded whole except when it grows.
 *
 * Per dot: position + birth time as 4 floats, and a material byte: 17 bytes.
 */

export const CHUNK = 8;
const CHUNK_BIAS = 512;
const BLOCK_SIZES = [4096, 8192, 16384, 32768, 65536];
export const BLOCK_MAX = BLOCK_SIZES[BLOCK_SIZES.length - 1];
const CHUNK_RADIUS = (CHUNK * Math.sqrt(3)) / 2;

/** Open-addressing hash set of non-zero 32-bit keys. */
class CellSet {
  private table = new Uint32Array(4096);
  private mask = 4095;
  size = 0;

  /** Insert; returns false if it was already there. */
  add(key: number): boolean {
    let i = Math.imul(key, 0x9e3779b1) >>> 0;
    for (;;) {
      i &= this.mask;
      const v = this.table[i];
      if (v === 0) break;
      if (v === key) return false;
      i++;
    }
    this.table[i] = key;
    this.size++;
    if (this.size * 10 > this.table.length * 6) this.grow();
    return true;
  }

  has(key: number): boolean {
    let i = Math.imul(key, 0x9e3779b1) >>> 0;
    for (;;) {
      i &= this.mask;
      const v = this.table[i];
      if (v === 0) return false;
      if (v === key) return true;
      i++;
    }
  }

  private grow(): void {
    const old = this.table;
    this.table = new Uint32Array(old.length * 2);
    this.mask = this.table.length - 1;
    this.size = 0;
    for (let i = 0; i < old.length; i++) if (old[i]) this.add(old[i]);
  }

  get bytes(): number {
    return this.table.byteLength;
  }
}

export class Block {
  count = 0;
  /** Dots already written to the save (see persist.ts). */
  savedCount = 0;
  point: Float32Array;
  mat: Uint8Array;
  points: Points;
  /** First dot written since the last upload (-1: none). */
  private dirtyFrom = -1;

  constructor(
    readonly chunk: Chunk,
    readonly index: number,
    material: ShaderMaterial,
    shared: DotUniforms,
  ) {
    this.point = new Float32Array(BLOCK_SIZES[0] * 4);
    this.mat = new Uint8Array(BLOCK_SIZES[0]);
    this.points = new Points(this.makeGeometry(), material);
    this.points.name = `dots:${chunk.key}:${index}`;
    this.points.frustumCulled = true;
    this.points.matrixAutoUpdate = false;
    attachViewportHook(this.points, shared);
  }

  get capacity(): number {
    return this.mat.length;
  }

  get full(): boolean {
    return this.count >= BLOCK_MAX;
  }

  private makeGeometry(): BufferGeometry {
    const g = new BufferGeometry();
    const p = new BufferAttribute(this.point, 4).setUsage(DynamicDrawUsage);
    const m = new BufferAttribute(this.mat, 1).setUsage(DynamicDrawUsage);
    g.setAttribute('aPoint', p);
    g.setAttribute('aMat', m);
    // three needs a 'position' attribute name for some bookkeeping; the shader reads aPoint.
    g.setAttribute('position', p);
    g.boundingSphere = new Sphere(this.chunk.center, CHUNK_RADIUS);
    g.setDrawRange(0, this.count);
    return g;
  }

  push(x: number, y: number, z: number, birth: number, material: number): void {
    if (this.count >= this.capacity) this.grow();
    const i = this.count++;
    const o = i * 4;
    this.point[o] = x;
    this.point[o + 1] = y;
    this.point[o + 2] = z;
    this.point[o + 3] = birth;
    this.mat[i] = material;
    if (this.dirtyFrom < 0) this.dirtyFrom = i;
  }

  /** Grow the arrays to the next size: a new geometry (and GL buffers), uploaded whole once. */
  private grow(): void {
    const next = BLOCK_SIZES.find((s) => s > this.capacity) ?? BLOCK_MAX;
    const point = new Float32Array(next * 4);
    point.set(this.point);
    const mat = new Uint8Array(next);
    mat.set(this.mat);
    this.point = point;
    this.mat = mat;
    const old = this.points.geometry;
    this.points.geometry = this.makeGeometry();
    old.dispose();
    this.dirtyFrom = -1; // the new buffers upload whole
  }

  /** Upload what was written since the last call. Returns the number of dots uploaded. */
  flush(): number {
    const g = this.points.geometry;
    g.setDrawRange(0, this.count);
    if (this.dirtyFrom < 0) return 0;
    const from = this.dirtyFrom;
    const n = this.count - from;
    const p = g.getAttribute('aPoint') as BufferAttribute;
    const m = g.getAttribute('aMat') as BufferAttribute;
    p.addUpdateRange(from * 4, n * 4);
    p.needsUpdate = true;
    m.addUpdateRange(from, n);
    m.needsUpdate = true;
    this.dirtyFrom = -1;
    return n;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.points.geometry.dispose();
  }
}

export class Chunk {
  readonly blocks: Block[] = [];
  readonly cells = new CellSet();
  readonly center: Vector3;
  readonly origin: Vector3;

  constructor(
    readonly key: number,
    readonly cx: number,
    readonly cy: number,
    readonly cz: number,
    shift: number,
  ) {
    this.origin = new Vector3(cx * CHUNK - shift, cy * CHUNK - shift, cz * CHUNK - shift);
    this.center = this.origin.clone().addScalar(CHUNK / 2);
  }

  get count(): number {
    let n = 0;
    for (const b of this.blocks) n += b.count;
    return n;
  }
}

export const chunkKey = (cx: number, cy: number, cz: number): number =>
  ((cx + CHUNK_BIAS) << 20) | ((cy + CHUNK_BIAS) << 10) | (cz + CHUNK_BIAS);

export class PointStore {
  readonly root = new Group();
  readonly chunks = new Map<number, Chunk>();
  total = 0;
  /** Dots refused because their cell was taken, and dots added, since the counters were reset. */
  dropped = 0;
  added = 0;
  /** Dots uploaded to the GPU by the last flush. */
  uploaded = 0;
  full = false;
  private readonly touched = new Set<Block>();
  private cellSize: number;
  private cellsPerChunk: number;
  /**
   * The grid is shifted by half a cell, so cell (and chunk) boundaries fall halfway between
   * multiples of the cell size. Authored walls sit on round coordinates; on a boundary, the
   * last bits of float noise in each hit would split one wall across two cells (two dots
   * per cell, and two chunks at multiples of 8 m).
   */
  private shift: number;

  constructor(
    private readonly material: ShaderMaterial,
    private readonly shared: DotUniforms,
    cellSize: number,
    public maxDots: number,
  ) {
    this.root.name = 'cloud';
    this.root.matrixAutoUpdate = false;
    this.cellSize = cellSize;
    this.cellsPerChunk = Math.ceil(CHUNK / cellSize);
    this.shift = cellSize / 2;
    if (this.cellsPerChunk > 511) throw new Error(`dedup cell ${cellSize} m is too small for ${CHUNK} m chunks`);
  }

  get cell(): number {
    return this.cellSize;
  }

  get blockCount(): number {
    let n = 0;
    for (const c of this.chunks.values()) n += c.blocks.length;
    return n;
  }

  /** CPU bytes held by dots and dedup sets. */
  get bytes(): number {
    let n = 0;
    for (const c of this.chunks.values()) {
      n += c.cells.bytes;
      for (const b of c.blocks) n += b.point.byteLength + b.mat.byteLength;
    }
    return n;
  }

  private chunkKeyAt(x: number, y: number, z: number): number {
    const h = this.shift;
    return chunkKey(Math.floor((x + h) / CHUNK), Math.floor((y + h) / CHUNK), Math.floor((z + h) / CHUNK));
  }

  private chunkAt(x: number, y: number, z: number): Chunk {
    const h = this.shift;
    const cx = Math.floor((x + h) / CHUNK);
    const cy = Math.floor((y + h) / CHUNK);
    const cz = Math.floor((z + h) / CHUNK);
    const key = chunkKey(cx, cy, cz);
    let c = this.chunks.get(key);
    if (!c) {
      c = new Chunk(key, cx, cy, cz, h);
      this.chunks.set(key, c);
    }
    return c;
  }

  /** The dedup cell key of a point inside its chunk (never 0). */
  private cellKey(c: Chunk, x: number, y: number, z: number): number {
    const n = this.cellsPerChunk;
    const s = 1 / this.cellSize;
    const ix = Math.min(n - 1, Math.floor((x - c.origin.x) * s));
    const iy = Math.min(n - 1, Math.floor((y - c.origin.y) * s));
    const iz = Math.min(n - 1, Math.floor((z - c.origin.z) * s));
    return ((ix << 18) | (iy << 9) | iz) + 1;
  }

  /**
   * Add a dot unless its cell is already taken (or the cloud is full). Returns true if added.
   * Call flush() once per frame after adding.
   */
  add(x: number, y: number, z: number, material: number, birth: number): boolean {
    if (this.total >= this.maxDots) {
      this.full = true;
      return false;
    }
    // Key on the position as it's stored (32-bit), so a restored save dedups the same way.
    x = Math.fround(x);
    y = Math.fround(y);
    z = Math.fround(z);
    const c = this.chunkAt(x, y, z);
    if (!c.cells.add(this.cellKey(c, x, y, z))) {
      this.dropped++;
      return false;
    }
    let b = c.blocks[c.blocks.length - 1];
    if (!b || b.full) {
      b = new Block(c, c.blocks.length, this.material, this.shared);
      c.blocks.push(b);
      this.root.add(b.points);
    }
    b.push(x, y, z, birth, material);
    this.touched.add(b);
    this.total++;
    this.added++;
    return true;
  }

  /** Is there a scanned dot within the cell around this point (or its neighbours with `radius`)? */
  isScanned(x: number, y: number, z: number, radius = 0): boolean {
    const r = Math.max(0, Math.ceil(radius / this.cellSize));
    const s = this.cellSize;
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        for (let dz = -r; dz <= r; dz++) {
          const px = Math.fround(x + dx * s);
          const py = Math.fround(y + dy * s);
          const pz = Math.fround(z + dz * s);
          const c = this.chunks.get(this.chunkKeyAt(px, py, pz));
          if (c && c.cells.has(this.cellKey(c, px, py, pz))) return true;
        }
    return false;
  }

  /** Upload this frame's new dots. */
  flush(): number {
    let n = 0;
    for (const b of this.touched) n += b.flush();
    this.touched.clear();
    this.uploaded = n;
    return n;
  }

  /** Forget every dot. */
  clear(): void {
    for (const c of this.chunks.values()) for (const b of c.blocks) b.dispose();
    this.chunks.clear();
    this.touched.clear();
    this.total = 0;
    this.full = false;
  }

  /** Change the dedup cell size: rebuilds the cloud from its own dots (some may merge). */
  setCellSize(cell: number): void {
    const old = [...this.chunks.values()];
    const keep: { p: Float32Array; m: Uint8Array; n: number }[] = old.flatMap((c) => c.blocks.map((b) => ({ p: b.point, m: b.mat, n: b.count })));
    this.clear();
    this.cellSize = cell;
    this.cellsPerChunk = Math.ceil(CHUNK / cell);
    this.shift = cell / 2;
    for (const k of keep) for (let i = 0; i < k.n; i++) this.add(k.p[i * 4], k.p[i * 4 + 1], k.p[i * 4 + 2], k.m[i], k.p[i * 4 + 3]);
    this.flush();
  }
}
