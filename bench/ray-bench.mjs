// Lidar raycast benchmark with Rapier (the physics engine the repo already uses):
// a level made of a big room with a maze of wall boxes and some round pillars, as one
// static trimesh. Cast a "scanner spray" of rays from inside, first hit + normal.
import RAPIER from '@dimforge/rapier3d-compat';

await RAPIER.init();

function level(detail) {
  const v = [];
  const idx = [];
  const quad = (a, b, c, d) => {
    const i = v.length / 3;
    v.push(...a, ...b, ...c, ...d);
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  // Subdivided surfaces so triangle counts are like a real level mesh.
  const grid = (o, u, w, nu, nw) => {
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nw; j++) {
        const p = (a, b) => [o[0] + u[0] * a + w[0] * b, o[1] + u[1] * a + w[1] * b, o[2] + u[2] * a + w[2] * b];
        quad(p(i / nu, j / nw), p((i + 1) / nu, j / nw), p((i + 1) / nu, (j + 1) / nw), p(i / nu, (j + 1) / nw));
      }
  };
  const n = detail;
  grid([-30, 0, -30], [60, 0, 0], [0, 0, 60], n, n); // floor
  grid([-30, 5, -30], [60, 0, 0], [0, 0, 60], n, n); // ceiling
  for (const [o, u] of [[[-30, 0, -30], [60, 0, 0]], [[-30, 0, 30], [60, 0, 0]], [[-30, 0, -30], [0, 0, 60]], [[30, 0, -30], [0, 0, 60]]]) grid(o, u, [0, 5, 0], n, Math.max(2, n / 6));
  // Maze walls: 60 boxes.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 60; k++) {
    const x = rnd() * 50 - 25, z = rnd() * 50 - 25, len = 2 + rnd() * 8, along = rnd() < 0.5;
    const sx = along ? len : 0.3, sz = along ? 0.3 : len;
    const m = Math.max(1, Math.round(n / 12));
    grid([x, 0, z], [sx, 0, 0], [0, 5, 0], m, m);
    grid([x, 0, z + sz], [sx, 0, 0], [0, 5, 0], m, m);
    grid([x, 0, z], [0, 0, sz], [0, 5, 0], m, m);
    grid([x + sx, 0, z], [0, 0, sz], [0, 5, 0], m, m);
  }
  return { vertices: new Float32Array(v), indices: new Uint32Array(idx) };
}

const results = [];
for (const detail of [24, 96, 240]) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const { vertices, indices } = level(detail);
  world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices));
  world.step(); // build the broad phase
  const tris = indices.length / 3;
  for (const rays of [500, 2000, 8000]) {
    // A cone spray (30°) from eye height, turning between batches.
    let hits = 0;
    const batches = 20;
    const t0 = performance.now();
    for (let b = 0; b < batches; b++) {
      const yaw = b * 0.31;
      for (let i = 0; i < rays; i++) {
        const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * Math.tan(15 * Math.PI / 180);
        let dx = Math.cos(a) * r, dy = Math.sin(a) * r, dz = -1;
        const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
        const c = Math.cos(yaw), s = Math.sin(yaw);
        const ray = new RAPIER.Ray({ x: 0.5, y: 1.6, z: 0.5 }, { x: dx * c + dz * s, y: dy, z: -dx * s + dz * c });
        const hit = world.castRayAndGetNormal(ray, 100, true);
        if (hit) hits++;
      }
    }
    const per = (performance.now() - t0) / batches;
    results.push({ tris, rays, msPerBatch: +per.toFixed(2), usPerRay: +((per * 1000) / rays).toFixed(2), hitRate: +(hits / (rays * batches)).toFixed(2) });
  }
  world.free();
}
console.table(results);
