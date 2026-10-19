import { bus } from '../core/events';
import type { PointStore } from './store';

/**
 * Keeps the scan between visits, in the browser's IndexedDB (per level and save slot).
 *
 * Each block of dots is one record (positions and material bytes; birth times aren't
 * kept, restored dots appear fully grown). Records are written incrementally: every few
 * seconds, only the blocks that gained dots are rewritten, and everything still unsaved is
 * flushed when the page hides or the VR session ends.
 *
 * A save remembers the level's content hash. If the level file changed since (you edited
 * it in Blender), the old dots no longer match the walls, so that save is dropped.
 */

const DB_NAME = 'lidar-game';
const DB_VERSION = 1;
const BLOCKS = 'blocks';
const META = 'meta';

interface BlockRecord {
  count: number;
  pos: Float32Array;
  mat: Uint8Array;
}

interface MetaRecord {
  level: string;
  hash: string;
  cell: number;
  total: number;
  savedAt: number;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(BLOCKS)) db.createObjectStore(BLOCKS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export type SaveState = 'off' | 'idle' | 'saving' | 'error';

export class ScanSave {
  state: SaveState = 'idle';
  lastSaved = 0;
  /** Dots in the save as of the last write. */
  savedTotal = 0;
  /** Why the last restore found nothing (for the menu and tests). */
  restoreNote = '';
  lastError = '';
  private db: IDBDatabase | null = null;
  private busy: Promise<void> | null = null;
  private readonly prefix: string;

  constructor(
    private readonly store: PointStore,
    readonly level: string,
    readonly hash: string,
    readonly slot: string,
  ) {
    this.prefix = `${slot}/${level}`;
  }

  private async database(): Promise<IDBDatabase> {
    if (!this.db) this.db = await open();
    return this.db;
  }

  private range(): IDBKeyRange {
    return IDBKeyRange.bound(`${this.prefix}/`, `${this.prefix}/￿`);
  }

  private blockKey(chunkKey: number, index: number): string {
    return `${this.prefix}/${chunkKey}/${String(index).padStart(3, '0')}`;
  }

  /**
   * Load the saved scan into the (empty) store. Blocks come back in their saved order, so
   * the store's layout matches the save and later writes stay incremental.
   */
  async restore(now: number): Promise<number> {
    try {
      const db = await this.database();
      const tx = db.transaction([BLOCKS, META], 'readonly');
      const meta = (await req(tx.objectStore(META).get(this.prefix))) as MetaRecord | undefined;
      if (!meta) {
        this.restoreNote = 'no save yet';
        return 0;
      }
      if (meta.hash !== this.hash) {
        this.restoreNote = `the level changed since the save (${meta.hash} → ${this.hash}); starting fresh`;
        await this.erase();
        return 0;
      }
      const keys = (await req(tx.objectStore(BLOCKS).getAllKeys(this.range()))) as string[];
      const values = (await req(tx.objectStore(BLOCKS).getAll(this.range()))) as BlockRecord[];
      // getAll returns in key order, and keys sort chunk by chunk, block 000 first.
      let added = 0;
      let refused = 0;
      for (let r = 0; r < values.length; r++) {
        const v = values[r];
        for (let i = 0; i < v.count; i++) {
          if (this.store.add(v.pos[i * 3], v.pos[i * 3 + 1], v.pos[i * 3 + 2], v.mat[i], now - 1000)) added++;
          else refused++;
        }
      }
      this.store.flush();
      this.store.added = 0;
      // Everything restored is already saved, unless the layout changed (a different cell
      // size merged some dots): then the next save rewrites it all.
      const sameLayout = refused === 0 && meta.cell === this.store.cell;
      for (const c of this.store.chunks.values()) for (const b of c.blocks) b.savedCount = sameLayout ? b.count : 0;
      if (!sameLayout) await this.erase(false);
      this.savedTotal = sameLayout ? added : 0;
      this.restoreNote = `${added} dots from ${keys.length} blocks${refused ? `, ${refused} merged` : ''}`;
      bus.emit('restore', { dots: added, blocks: keys.length });
      return added;
    } catch (err) {
      this.state = 'error';
      this.lastError = String(err);
      this.restoreNote = 'could not read the save';
      console.warn('[save] restore failed', err);
      return 0;
    }
  }

  /** Blocks with dots the save doesn't have yet. */
  get unsaved(): number {
    let n = 0;
    for (const c of this.store.chunks.values()) for (const b of c.blocks) n += b.count - b.savedCount;
    return n;
  }

  /**
   * Write every block that gained dots (or, with `all`, every block: a full copy into this
   * slot). Calls made while a save is running wait for it.
   */
  save(all = false): Promise<void> {
    if (this.busy) return this.busy.then(() => this.save(all));
    if (!all && this.unsaved === 0) return Promise.resolve();
    this.busy = this.write(all).finally(() => (this.busy = null));
    return this.busy;
  }

  private async write(all: boolean): Promise<void> {
    this.state = 'saving';
    try {
      const db = await this.database();
      const tx = db.transaction([BLOCKS, META], 'readwrite');
      const blocks = tx.objectStore(BLOCKS);
      const written: [{ savedCount: number }, number][] = [];
      let blockCount = 0;
      for (const c of this.store.chunks.values()) {
        for (const b of c.blocks) {
          if (!all && b.count === b.savedCount) continue;
          // Copies, not views: a view would clone the block's whole buffer.
          const pos = new Float32Array(b.count * 3);
          for (let i = 0; i < b.count; i++) {
            pos[i * 3] = b.point[i * 4];
            pos[i * 3 + 1] = b.point[i * 4 + 1];
            pos[i * 3 + 2] = b.point[i * 4 + 2];
          }
          const rec: BlockRecord = { count: b.count, pos, mat: b.mat.slice(0, b.count) };
          blocks.put(rec, this.blockKey(c.key, b.index));
          written.push([b, b.count]);
          blockCount++;
        }
      }
      const meta: MetaRecord = { level: this.level, hash: this.hash, cell: this.store.cell, total: this.store.total, savedAt: Date.now() };
      tx.objectStore(META).put(meta, this.prefix);
      await done(tx);
      // A full copy (another slot) doesn't change what the main save has.
      if (!all) for (const [b, n] of written) b.savedCount = n;
      this.savedTotal = this.store.total - this.unsaved;
      this.lastSaved = performance.now();
      this.state = 'idle';
      bus.emit('save', { blocks: blockCount, total: this.store.total });
    } catch (err) {
      this.state = 'error';
      this.lastError = String(err);
      console.warn('[save] write failed', err);
    }
  }

  /** Delete this slot's save for this level (and its meta, unless `meta` is false). */
  async erase(meta = true): Promise<void> {
    const db = await this.database();
    const tx = db.transaction([BLOCKS, META], 'readwrite');
    tx.objectStore(BLOCKS).delete(this.range());
    if (meta) tx.objectStore(META).delete(this.prefix);
    await done(tx);
    for (const c of this.store.chunks.values()) for (const b of c.blocks) b.savedCount = 0;
    this.savedTotal = 0;
  }

  /** Read what the save holds without loading it (tests). */
  async peek(): Promise<{ meta: MetaRecord | null; blocks: number; dots: number }> {
    const db = await this.database();
    const tx = db.transaction([BLOCKS, META], 'readonly');
    const meta = ((await req(tx.objectStore(META).get(this.prefix))) as MetaRecord | undefined) ?? null;
    const values = (await req(tx.objectStore(BLOCKS).getAll(this.range()))) as BlockRecord[];
    return { meta, blocks: values.length, dots: values.reduce((n, v) => n + v.count, 0) };
  }
}
