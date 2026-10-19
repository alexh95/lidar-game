/**
 * Emulator-only: keep frames coming when the browser starves the page of them.
 *
 * Browsers pause or throttle requestAnimationFrame for hidden, background or
 * occluded pages (sometimes to 1 Hz while still reporting "visible"). That
 * stalls the emulated headset, because IWER drives its frame loop with rAF. An
 * agent running the self-test often has the page in a background pane, so rAF
 * goes through one queue. The real rAF flushes it when it's running; a worker
 * ticking at `hz` flushes it whenever no real frame has arrived for a couple of
 * ticks. Worker timers aren't throttled like page timers.
 * Never installed for real headsets: their frame loop comes from the XR runtime.
 */
export function installHiddenFrameClock(hz = 72): void {
  const nativeRAF = window.requestAnimationFrame.bind(window);
  const pending = new Map<number, FrameRequestCallback>();
  const tickMs = 1000 / hz;
  let nextId = 1;
  let nativePending = false;
  let lastFlush = performance.now();
  /** The worker drove the last frame (the real rAF is starved): keep driving at full rate. */
  let driving = false;

  const flush = (t: number) => {
    lastFlush = performance.now();
    if (pending.size === 0) return;
    const callbacks = [...pending.values()];
    pending.clear();
    for (const cb of callbacks) {
      try {
        cb(t);
      } catch (err) {
        console.error(err);
      }
    }
  };
  const onNative = (t: number) => {
    nativePending = false;
    driving = false;
    flush(t);
  };

  const src = `setInterval(() => postMessage(0), ${Math.round(tickMs)});`;
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  worker.onmessage = () => {
    // Starved: no real frame for over two ticks. Drive frames ourselves until a real one shows up.
    if (pending.size > 0 && (driving || performance.now() - lastFlush > tickMs * 2.2)) {
      driving = true;
      flush(performance.now());
    }
  };

  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId++;
    pending.set(id, cb);
    if (!nativePending) {
      nativePending = true;
      nativeRAF(onNative);
    }
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => {
    pending.delete(id);
  };
}
