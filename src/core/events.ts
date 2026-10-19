// A tiny event bus. Gameplay code emits named events; the probe counts them and
// keeps a short history so tests (and curious humans) can see what happened.

export type EventName =
  | 'session-start'
  | 'session-end'
  | 'level-loaded'
  | 'scan-start'
  | 'scan-stop'
  | 'cloud-full'
  | 'cloud-cleared'
  | 'save'
  | 'restore'
  | 'snap-turn'
  | 'recenter'
  | 'menu'
  | 'setting';

export interface BusEvent {
  name: EventName;
  t: number;
  data?: Record<string, unknown>;
}

type Listener = (e: BusEvent) => void;

class Bus {
  readonly counts: Partial<Record<EventName, number>> = {};
  readonly recent: BusEvent[] = [];
  private listeners = new Map<EventName | '*', Set<Listener>>();

  emit(name: EventName, data?: Record<string, unknown>): void {
    const e: BusEvent = { name, t: performance.now(), data };
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    this.recent.push(e);
    if (this.recent.length > 80) this.recent.shift();
    this.listeners.get(name)?.forEach((l) => l(e));
    this.listeners.get('*')?.forEach((l) => l(e));
  }

  on(name: EventName | '*', fn: Listener): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  count(name: EventName): number {
    return this.counts[name] ?? 0;
  }
}

export const bus = new Bus();
