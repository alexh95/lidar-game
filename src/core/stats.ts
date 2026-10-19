import type { WebGLRenderer } from 'three';

/** Frame timing and render counters, smoothed for display. */
export class Stats {
  fps = 0;
  frameMs = 0;
  calls = 0;
  points = 0;
  /** Worst frame in the last second (ms). */
  worstMs = 0;
  /** CPU time spent in the app's update (ms, smoothed) and in renderer.render (submission). */
  updateMs = 0;
  renderMs = 0;
  private acc = 0;
  private frames = 0;
  private worst = 0;

  tick(dtSeconds: number, renderer: WebGLRenderer, updateMs: number, renderMs: number): void {
    const ms = dtSeconds * 1000;
    this.frameMs += (ms - this.frameMs) * 0.08;
    this.updateMs += (updateMs - this.updateMs) * 0.08;
    this.renderMs += (renderMs - this.renderMs) * 0.08;
    this.worst = Math.max(this.worst, ms);
    this.acc += dtSeconds;
    this.frames++;
    if (this.acc >= 1) {
      this.fps = this.frames / this.acc;
      this.worstMs = this.worst;
      this.acc = 0;
      this.frames = 0;
      this.worst = 0;
    }
    this.calls = renderer.info.render.calls;
    this.points = renderer.info.render.points;
  }
}

/**
 * GPU time of whole frames (both eyes) from EXT_disjoint_timer_query_webgl2.
 * Queries are ring-buffered and read a few frames later, so nothing stalls.
 * `ms` stays null where the extension isn't offered (most non-desktop browsers).
 */
export class GpuTimer {
  ms: number | null = null;
  /** Last raw sample (ms), unsmoothed. */
  last: number | null = null;
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  constructor(renderer: WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  get available(): boolean {
    return !!this.ext;
  }

  begin(): void {
    if (!this.ext || this.active || this.pending.length > 6) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
    this.poll();
  }

  private poll(): void {
    const gl = this.gl;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const disjoint = gl.getParameter(this.ext!.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this.last = ms;
        this.ms = this.ms === null ? ms : this.ms + (ms - this.ms) * 0.1;
      }
      gl.deleteQuery(q);
    }
  }
}
