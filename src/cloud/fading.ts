import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Points, type ShaderMaterial } from 'three';
import { attachViewportHook, type DotUniforms } from './dots';

/**
 * Dots on entity surfaces (moving things): a ring buffer that is never deduplicated or
 * saved. Each dot stays where the ray hit, then dims and shrinks away over the material's
 * life, so a moving thing leaves a fading trail of where it was. The shader hides expired
 * dots, so the whole ring is drawn in one call with no bookkeeping.
 */
export class FadingDots {
  readonly points: Points;
  private readonly point: Float32Array;
  private readonly mat: Uint8Array;
  private readonly pAttr: BufferAttribute;
  private readonly mAttr: BufferAttribute;
  private cursor = 0;
  /** Range written since the last flush, in ring order (may wrap). */
  private pendingFrom = -1;
  private pendingCount = 0;
  /** Dots ever added (the probe uses it to tell that entities were hit). */
  added = 0;
  private readonly times: Float32Array;

  constructor(
    readonly capacity: number,
    material: ShaderMaterial,
    shared: DotUniforms,
    readonly life: number,
  ) {
    this.point = new Float32Array(capacity * 4);
    // Unused slots are born long ago, so the shader treats them as expired.
    for (let i = 0; i < capacity; i++) this.point[i * 4 + 3] = -1e6;
    this.mat = new Uint8Array(capacity);
    this.times = new Float32Array(capacity).fill(-1e6);
    const g = new BufferGeometry();
    this.pAttr = new BufferAttribute(this.point, 4).setUsage(DynamicDrawUsage);
    this.mAttr = new BufferAttribute(this.mat, 1).setUsage(DynamicDrawUsage);
    g.setAttribute('aPoint', this.pAttr);
    g.setAttribute('aMat', this.mAttr);
    g.setAttribute('position', this.pAttr);
    this.points = new Points(g, material);
    this.points.name = 'dots:fading';
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    attachViewportHook(this.points, shared);
  }

  add(x: number, y: number, z: number, material: number, birth: number): void {
    const i = this.cursor;
    const o = i * 4;
    this.point[o] = x;
    this.point[o + 1] = y;
    this.point[o + 2] = z;
    this.point[o + 3] = birth;
    this.mat[i] = material;
    this.times[i] = birth;
    this.cursor = (i + 1) % this.capacity;
    if (this.pendingFrom < 0) this.pendingFrom = i;
    this.pendingCount = Math.min(this.capacity, this.pendingCount + 1);
    this.added++;
  }

  /** Dots still visible at time `now`. */
  alive(now: number): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (now - this.times[i] <= this.life) n++;
    return n;
  }

  flush(): void {
    if (this.pendingFrom < 0) return;
    const from = this.pendingFrom;
    const n = this.pendingCount;
    const first = Math.min(n, this.capacity - from);
    this.range(from, first);
    if (n > first) this.range(0, n - first);
    this.pAttr.needsUpdate = true;
    this.mAttr.needsUpdate = true;
    this.pendingFrom = -1;
    this.pendingCount = 0;
  }

  private range(from: number, n: number): void {
    this.pAttr.addUpdateRange(from * 4, n * 4);
    this.mAttr.addUpdateRange(from, n);
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.point[i * 4 + 3] = -1e6;
    this.times.fill(-1e6);
    this.pAttr.clearUpdateRanges();
    this.mAttr.clearUpdateRanges();
    this.pAttr.needsUpdate = true;
    this.mAttr.needsUpdate = true;
    this.pendingFrom = -1;
    this.pendingCount = 0;
  }
}
