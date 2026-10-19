import { PerspectiveCamera, SRGBColorSpace, Vector3, WebGLRenderTarget } from 'three';
import { rng } from '../core/math';
import type { RayHit } from '../physics/physics';
import type { App } from '../app';

/**
 * Benchmarks through the real renderer and the real point store (the standalone pages in
 * bench/ measure raw WebGL and raw Rapier; these measure the game).
 */

/** Fill the cloud with up to `n` dots by casting random rays through the level. */
export function fillCloud(app: App, n: number, seed = 1, maxSeconds = 40): { total: number; rays: number; ms: number } {
  const random = rng(seed);
  const b = app.level.bounds;
  const hit: RayHit = { dist: 0, material: 0, entity: false };
  const t0 = performance.now();
  let rays = 0;
  // Origins inside the built part of the level (and a little above the expanse).
  const lo = new Vector3(b.min.x, Math.max(b.min.y, -4), b.min.z);
  const hi = new Vector3(b.max.x, Math.min(b.max.y, 12), b.max.z);
  while (app.cloud.total < n && performance.now() - t0 < maxSeconds * 1000) {
    const ox = lo.x + random() * (hi.x - lo.x);
    const oy = lo.y + random() * (hi.y - lo.y);
    const oz = lo.z + random() * (hi.z - lo.z);
    for (let i = 0; i < 2000 && app.cloud.total < n; i++) {
      const u = random() * 2 - 1;
      const a = random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      rays++;
      if (!app.physics.cast(ox, oy, oz, s * Math.cos(a), u, s * Math.sin(a), 80, hit) || hit.entity) continue;
      app.cloud.add(ox + s * Math.cos(a) * hit.dist, oy + u * hit.dist, oz + s * Math.sin(a) * hit.dist, hit.material, app.time - 1000);
    }
  }
  app.cloud.flush();
  return { total: app.cloud.total, rays, ms: Math.round(performance.now() - t0) };
}

const waitFrame = () => new Promise<void>((r) => setTimeout(r, 16));

/**
 * GPU time to draw the scene for two 2160×2160 eyes (4× MSAA, 100° FOV) from `from`
 * looking at `to`, like the headset's per-eye buffers. Median and minimum over `frames` frames.
 */
export async function measureEyes(
  app: App,
  o: { frames?: number; size?: number; from?: Vector3; to?: Vector3; fov?: number; samples?: number } = {},
): Promise<{ gpuMs: number | null; gpuMinMs: number | null; cpuMs: number; calls: number; dots: number }> {
  const r = app.renderer;
  const gl = r.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const size = o.size ?? 2160;
  const rt = new WebGLRenderTarget(size, size, { samples: o.samples ?? 4 });
  rt.texture.colorSpace = SRGBColorSpace;
  (rt as WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  rt.texture.internalFormat = 'RGBA8';
  const from = o.from ?? app.level.spawn.position.clone().add(new Vector3(0, 1.6, 0));
  const to = o.to ?? from.clone().add(new Vector3(-Math.sin(app.level.spawn.yaw), 0, -Math.cos(app.level.spawn.yaw)));
  const eyes = [-0.032, 0.032].map((dx) => {
    const c = new PerspectiveCamera(o.fov ?? 100, 1, app.xrCamera.near, app.xrCamera.far);
    c.position.copy(from);
    c.lookAt(to);
    c.translateX(dx);
    c.updateMatrixWorld(true);
    return c;
  });
  const frames = o.frames ?? 30;
  const queries: WebGLQuery[] = [];
  const cpu: number[] = [];
  let calls = 0;
  let dots = 0;
  const xrEnabled = r.xr.enabled;
  const prev = r.getRenderTarget();
  // The app's own frames would share the GPU with the measurement: pause them.
  r.setAnimationLoop(null);
  // Frames go back to back, as in a headset where the GPU never idles; with gaps between
  // them the GPU clocks down and each frame measures several times slower.
  const warm = 10;
  for (let f = 0; f < frames + warm; f++) {
    const q = ext && f >= warm ? gl.createQuery() : null;
    if (q) gl.beginQuery(ext!.TIME_ELAPSED_EXT, q);
    const t0 = performance.now();
    r.xr.enabled = false;
    r.setRenderTarget(rt);
    r.clear();
    r.info.reset();
    r.info.autoReset = false;
    for (const eye of eyes) r.render(app.scene, eye);
    r.info.autoReset = true;
    calls = r.info.render.calls;
    dots = r.info.render.points;
    r.setRenderTarget(prev);
    r.xr.enabled = xrEnabled;
    if (q) {
      gl.endQuery(ext!.TIME_ELAPSED_EXT);
      queries.push(q);
    }
    if (f >= warm) cpu.push(performance.now() - t0);
  }
  gl.finish();
  const times: number[] = [];
  const t0 = performance.now();
  while (queries.length && performance.now() - t0 < 3000) {
    const q = queries[0];
    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
      await waitFrame();
      continue;
    }
    queries.shift();
    if (!gl.getParameter(ext!.GPU_DISJOINT_EXT)) times.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(q);
  }
  rt.dispose();
  app.start();
  const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  // The GPU is shared with the browser's own compositing and the app's frames, so single
  // frames vary a lot; the minimum is the closest to the cost of this work alone.
  return { gpuMs: median(times), gpuMinMs: times.length ? Math.min(...times) : null, cpuMs: median(cpu) ?? 0, calls, dots };
}
