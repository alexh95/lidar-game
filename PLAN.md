# Lidar VR: plan and handoff brief

**Who this is for.** A fresh Claude Code session that will build this game. You have none of the conversation
that produced this file, so everything that matters is written down here. Read it all before you write code.
Then read `C:\Projects\cc\vr-test\README.md` and `C:\Projects\cc\vr-test\DECISIONS.md`. That repo is the
foundation you'll build on, and its DECISIONS file records many hard-won lessons.

**Status (2026-10-19).** Nothing is built yet. This folder holds this plan and two benchmarks in `bench/`.
Alex (the user) asked for a "very detailed document, plan for performance and visual fidelity via streaming
accordingly", so the next session can build the game.

**Update (2026-10-20).** Alex answered the open questions (§1.1). The working name and repo are **lidar-game**
(`C:\Projects\cc\lidar-game`, public GitHub repo `alexh95/lidar-game`). Where §1.1 disagrees with anything
below, §1.1 wins. The first milestone is the technical one: prove the project is viable. **It's built and
passes its checks in the emulator; see §8.0 for what's done, what was measured and what's next.**

---

## 0. TL;DR

- **The game:** a VR game "similar to Scanner Sombre": a lidar game, not necessarily horror. You're in the dark.
  A handheld scanner sprays rays, and every hit leaves a glowing dot that stays. The world exists only as the
  point cloud you've built. (Scanner Sombre is a 2017 game by Introversion Software. Take inspiration only; copy
  no assets, names or text.)
- **The stack:** the same as `vr-test`: WebXR + three.js r186 (WebGLRenderer, WebGL2) + Rapier 0.21 (wasm) +
  TypeScript 7 + Vite 8. It runs in Chrome or Edge on Alex's PC (RTX 4080) and streams to his **Steam Frame**
  through SteamVR.
- **It's feasible, measured on this PC:**
  - **Drawing:** 1 M dots take 0.46 ms of GPU time and 3 M take 1.3 ms, both eyes at 2160×2160 each.
  - **Scanning:** a Rapier raycast costs about 3 µs, whatever the level's triangle count. That's 500–1,000
    rays per frame on the main thread.
  - Details are in §3.
- **The real constraint is the video stream.** The frame is H.264, HEVC or AV1 compressed (probably eye-tracked,
  "foveated") before the headset sees it. Tiny high-contrast dots on black are worst-case content for those
  codecs. Design the dots for the codec (§6), and build two tools early:
  - an **offline codec simulator** (ffmpeg with NVENC is installed on this PC);
  - an **in-headset fidelity lab**, so Alex can pick the dot style on the real device.
- **Build order:**
  - **M0:** scaffold from vr-test.
  - **M1:** scanner and point cloud, raycasting on the CPU main thread.
  - **M2:** fidelity lab and codec simulator.
  - **M3:** Alex's first headset session.
  - **M4:** raycasting workers, compact storage and per-chunk culling.
  - **M5:** gameplay.
  - **M6:** GPU scanning (only if needed).
  - **M7:** content.
  - Details in §8.

---

## 1. What Alex asked for, and the open questions

Alex's words, in order:
1. "I'm thinking of a VR game similar to the Scanner Sombre, as in a lidar game, not necessarily a horror game.
   What is the technical feasibility of using this tooling in this repo to make such a game? How many tens or
   hundreds of thousands of points can it handle? Can we optimize it somewhat?"
2. Answered with measurements (§3): millions of dots render fine on his GPU; ray casting and the video stream
   are the limits.
3. "Write a very detailed document, plan for performance and visual fidelity via streaming accordingly. I'll
   spawn another full session from CC to do this. All information that would help the next session."

**Open questions.** Ask Alex these early, in one short message. Each has a default, so you can start M0–M2
while you wait.

| # | Question | Default if he says "you decide" |
|---|---|---|
| 1 | Tone: horror, tense exploration, or calm exploration? | Atmospheric exploration with light tension. No jump scares. |
| 2 | Where does it live: a new repo, or inside `vr-test`? | New folder `C:\Projects\cc\lidar` (this one) and its own git repo. A private GitHub repo only if he asks. |
| 3 | Dot colours: by distance (Scanner Sombre style), by surface or material, or both? | Distance gradient with a few material accents, switchable live (the shader palette is a lookup table). |
| 4 | Getting around in the dark: teleport, smooth walking, or both? | Both. Teleport only onto floor you've already scanned, and smooth walking with collision against the level. |
| 5 | Level authoring: procedural, or modelled (Blender → glTF)? | Procedural test levels first (rooms, corridors, a cave). glTF loading in M5. |
| 6 | Keep the scan between sessions? | No (maybe later, as a "save"). |
| 7 | Name? | Codename `lidar` until he names it. |

### 1.1 Alex's answers (2026-10-20)

| # | Answer | What it changes |
|---|---|---|
| 1 | **Tense exploration, no jump scares whatsoever.** Liminal, empty loneliness; eerie, colourless and soulless spaces. Simple environment puzzles could come later; more of that will be built on later. Panels on pedestals don't fit this kind of game. | Near-monochrome palettes (luma, not hue, carries the information, which is also what the codec wants, §6.2). Quiet, sparse sound. Architecture that feels built and abandoned. Nothing ever jumps out. No puzzle furniture in the levels for now. |
| 2 | A **new public repo**, `lidar-game`. The folder was renamed to `lidar-game` before `git init`. | `C:\Projects\cc\lidar-game`, GitHub `alexh95/lidar-game` (public), `main` only. |
| 3 | Dot colour is **material dependent and distance dependent**, the distance part **not fixed at cast time but dynamic**, so it tells depth as you move. | The shader colours each dot from its material's palette entry, then shades it by its *current* distance to the eye every frame. Nothing distance-related is stored per point. |
| 4 | Movement is **analogue** (smooth stick walking). | Smooth walking with collision (Rapier's character controller) is the default. Teleport isn't needed for now. |
| 5 | The level is **authored, in Blender**: it must be intentional. | Levels are `.blend` files exported to `.glb`. Material names give the material ids; naming conventions mark spawn points, entities and colliders (`levels/README.md`). |
| 6 | **The scans must persist.** | The static point cloud is saved (IndexedDB, per level) and restored on the next visit. |
| 7 | Working name `lidar-game`. | |
| + | **"Entity" materials that fade in time**: imagine moving objects. | Hits on entity surfaces go into a separate ring of dots that fade out over a few seconds and are never saved. Entities are animated (in Blender) and have kinematic colliders, so rays hit where they are now. |

The big milestone for now is **technical: does this work at all** (dots through the stream, scan rate, memory,
persistence, authored levels). Gameplay and puzzles come after.

---

## 2. Target platform and the delivery path

### 2.1 Steam Frame

From `vr-test`'s notes and public information as of late 2025 / 2026. **Verify anything marked (?) with Alex
or the headset's Info page.**

- About 2160×2160 per eye (LCD), 72–144 Hz refresh, roughly 100–110° field of view.
  - `vr-test`'s emulator uses a 100° vertical FOV, 64 mm IPD, and 72/90/120/144 Hz.
- Snapdragon 8 Gen 3 standalone SoC, running SteamOS on Arm (?).
- Eye tracking, used by Valve for **foveated streaming**: the video stream is sharper where you look (?).
- **The Frame's own browser has no WebXR** (as of Oct 2026). So the working path is: Chrome or Edge on the PC,
  rendering a WebXR session, through SteamVR's OpenXR runtime, streamed to the Frame over Wi-Fi (a 6 GHz USB
  adapter comes with the headset (?)).
- **The experimental standalone path** is a community Chromium build with WebXR for the Frame,
  `saphid/chromium-webxr-steam-frame`. It's unofficial and has no WebXR Layers (so no multiview). For that path,
  `npm run dev:lan` in vr-test serves HTTPS on the LAN.
  - Treat it as a stretch goal. Budget it at a fraction of the PC numbers (§7).

### 2.2 What the stream chain means for this game

```
three.js (WebGL2) → Chrome's WebXR framebuffer → SteamVR compositor (+ reprojection when frames drop)
  → video encoder on the PC (NVENC on the RTX 4080: H.264 / HEVC / AV1, probably 4:2:0 8-bit, maybe 10-bit)
  → Wi-Fi → decoder on the Frame → lens distortion → panels
```

- Every pixel you render goes through **lossy block-based video compression** at a bitrate cap, probably
  100–400 Mbps for both eyes (ask Alex what SteamVR shows). Dot fields are hard for this. See §6.
- When a frame is late, **SteamVR reprojects or motion-smooths** the old one. Warped dot fields smear and
  wobble. Keep frame-time headroom: aim for 80% of the frame budget, not 100%.
- **Latency** is higher than with a cable. The game doesn't need fast reflexes; keep it that way.

---

## 3. Measured baselines (this PC, 2026-10-19)

Both benchmarks are in `bench/`. Re-run them after any big change to the rendering or ray path.

### 3.1 Point rendering (GPU)

`bench/points-bench.html` is raw WebGL2, no three.js; three adds only a little per draw call on top.
- N dots on the inner surfaces of a 20×4×20 m room with 9 pillars.
- Drawn as `gl.POINTS`, twice (one per eye), into a 2160×2160 RGBA8 target with a 24-bit depth buffer.
- 100° FOV, depth test on.
- Point size: `clamp(2.2 * 1080 * 0.012 / distance, 1, 8)` px, coloured by distance.
- GPU time comes from `EXT_disjoint_timer_query_webgl2` (available in Chrome on this PC), averaged over 30
  frames.
- Renderer: `ANGLE (NVIDIA GeForce RTX 4080, Direct3D11)`.

| Dots | GPU ms per frame, both eyes (round dots, `discard` outside the circle) |
|---|---|
| 100 k | 0.04 |
| 300 k | 0.14 |
| 1 M | 0.46 |
| 3 M | 1.3 |
| 10 M | about 4.4–6.2 |

- That's roughly **0.45 ms per million dots per frame for both eyes**, about 4 billion point-vertices per
  second.
- The "square" rows in the benchmark output ran first and were polluted by GPU clock ramp-up and buffer
  uploads: they were non-monotonic. Ignore them. Round dots with `discard` cost nothing measurable extra.
- **How to run it:**
  - Serve it over HTTP. `file://` pages open only as static snapshots in the Claude browser pane.
  - The easiest way: copy it into a git-ignored folder of a running Vite dev server (e.g. `.snapshots/`) and
    open `http://localhost:<port>/.snapshots/points-bench.html`.
  - It writes its results to the page and to `window.__bench`.

### 3.2 Ray casting (CPU)

`bench/ray-bench.mjs` runs in Node 22 with the repo's Rapier build.
- One static trimesh: a 60×5×60 m room plus 60 maze walls, subdivided to 5 k, 80 k or 500 k triangles.
- A 30° cone of rays from eye height, `world.castRayAndGetNormal`.
- Run it with `node bench/ray-bench.mjs`. It imports Rapier from `C:/Projects/cc/vr-test/node_modules/...`;
  repoint the import once this project has its own `node_modules`.

| Triangles | 500 rays | 2,000 rays | 8,000 rays |
|---|---|---|---|
| 5 k | 2.5 ms | 5.1 ms | 21 ms |
| 80 k | 1.9 ms | 5.8 ms | 25 ms |
| 500 k | 2.1 ms | 5.8 ms | 23 ms |

- Steady state is about **2.6–3.1 µs per ray, independent of triangle count** (Rapier's BVH): the 2,000 and
  8,000 columns.
  - The 500-ray column ran first in each world, so it includes JIT and cache warm-up (3.7–5 µs per ray). Expect
    steady-state numbers in a running game.
  - The bench allocates a new `RAPIER.Ray` per ray. Reusing one should shave a little more.
- **On the main thread:** about 500–1,000 rays per frame (about 1.5–3 ms), so 45–90 k new dots per second at
  90 Hz.
- **To go beyond that,** use workers (§5.4 B) or GPU depth scanning (§5.4 C).

### 3.3 Budgets these imply (PC streaming, 90 Hz = 11.1 ms per frame)

| Item | Budget |
|---|---|
| Dots on screen | up to 4–6 M (≤ 3 ms GPU) |
| Level depth pre-pass (occlusion) | ≤ 0.5 ms GPU |
| Everything else (hands, beam, UI) | ≤ 1 ms GPU |
| **GPU total** | **≤ 7 ms** (headroom for SteamVR's compositor and encode) |
| Scanning + dedup + append, main thread | ≤ 1.5 ms (near 0 with workers) |
| three.js render submission | ≤ 1 ms (keep draw calls in the low hundreds) |
| **CPU main thread total** | **≤ 5 ms** |
| Point data in memory | ≤ 150 MB |

---

## 4. Reusing `vr-test`

`C:\Projects\cc\vr-test` ("Skyreach") is a WebXR playground for the Frame. GitHub: `alexh95/vr-test`, private,
`main` only, latest `4321ad5`. It has verified, working infrastructure. **Copy and adapt it; don't reinvent it.**
Read its `DECISIONS.md` sections 0–12 (platform, renderer, input, testing) before copying.

### 4.1 Copy and adapt

| vr-test file | What it gives you | Notes for lidar |
|---|---|---|
| `package.json`, `tsconfig*.json`, `vite.config.ts`, `index.html` | Same versions: three `0.186.1`, @dimforge/rapier3d-compat `0.21.0`, iwer `2.6.0`, @iwer/devui `2.6.0`, typescript `7.0.2`, vite `8.3.4`, @vitejs/plugin-basic-ssl `2.3.0`, @types/three `0.186.0` | Keep the `snapshotSink` dev plugin (POST `/__snapshot` → `.snapshots/*.png`). Add a similar `/__capture` sink for frame sequences (§6.3). Change ports (§10). |
| `src/core/renderer.ts` | WebGLRenderer setup: `antialias: true`, sRGB output, `xr.enabled`, `local-floor`, framebuffer scale, foveation | Drop shadows and ACES (dots should be `toneMapped: false`). Keep `antialias: true`: alpha-to-coverage needs MSAA. |
| `src/core/xr-session.ts` | Session start and end, optional features, `SessionInfo` (framebuffer size, frame rates) | As is. Add `session.updateTargetFrameRate` to choose 72/90/120. |
| `src/input/xr-input.ts` | Poses, buttons with hysteresis and edges, sticks, haptics, velocity estimate | As is. |
| `src/hands/hand-model.ts` | Procedural glove hands driven by touch | Keep, but dim them (the world is dark). Maybe render them as dots too. |
| `src/interact/locomotion.ts` | Teleport arc, snap or smooth turn, smooth walk, comfort vignette, blink | Adapt: valid teleport targets must be **scanned**; walking needs collision (Rapier `world.createCharacterController(offset)`). |
| `src/physics/physics.ts` | Rapier wrapper: fixed step, `castWalkable`, `castSolid`, static info, `stepOver` flag | Keep the wrapper; most of the prop machinery isn't needed. |
| `src/audio/audio.ts`, `src/audio/sfx.ts` | Web Audio engine, HRTF voices, synthesized sounds, `LoopSound` | Keep the engine. Write new sounds: scanner hum, hit ticks, ambience. |
| `src/core/settings.ts`, `src/ui/wrist-menu.ts`, `src/ui/text.ts` | Persistent settings, wrist menu (palm toward face; poke or ray), canvas labels | The wrist menu becomes the fidelity lab's control panel (§6.4). |
| `src/core/stats.ts` | FPS and frame time | Extend with GPU timer queries (§7.2). |
| `src/dev/emulator.ts` | IWER emulated headset shaped like the Frame | As is. |
| `src/dev/driver.ts` | Test driver: set head and hand poses, press buttons, wait frames or seconds | As is. |
| `src/dev/selftest.ts` | Scripted playtest harness (`?emulate&selftest[=a,b]`, results in `window.__selftest`, `[selftest] {...}` lines) | Keep the harness. Write new checks (§9). |
| `src/dev/probe.ts` | `window.__vr`: state, events, snapshot | Keep; add lidar state (dot counts, scan rate, timings). |
| `src/dev/snapshot.ts` | Offscreen render to PNG, `measureLuma` | **Copy the current version.** It has the sRGB fix: `rt.texture.internalFormat = 'RGBA8'`. Without it, snapshots were sRGB-encoded twice and looked brighter than the headset. Remove the portal and sky hooks. |
| `src/dev/frame-clock.ts` | Drives frames when the browser pane is throttled or hidden | As is. |
| `src/main.ts`, `src/config.ts` | Boot, Enter VR button, URL flags (`emulate`, `devui`, `selftest`, `autostart`, `stereo`, `quality`) | Add flags `lab`, `bench`, `capture`, `level=`. |
| `src/glider/air.ts` | A worked example of **GPU-animated points with per-eye point size** (`uViewport` from `renderer.getCurrentViewport` in `onBeforeRender`; size `uSize * projectionMatrix[1][1] * uViewport.w * 0.5 / -mv.z`) | Use this pattern for the dot shader. |
| `src/portals/portals.ts` | Lessons in render targets and XR (shader-variant switching, scissor, XR eye cameras) | Read the comments. The key lesson is in §7.4. |

**Don't copy:** the playground content (toys, archery, skyboat, flares, glider, portals, inventory, scenery,
sky, clouds, time of day), or `core/detail.ts` (small-object culling isn't needed when everything is dots).

### 4.2 Conventions to keep

- **`DECISIONS.md`:** Alex explicitly wants the tech choices documented. Add a section per feature, with what
  was measured and what was caught in testing.
- **`README.md`:** how to run on the Frame (PC streaming), the standalone path, a gallery, controls, a
  **first-run-on-the-Frame checklist**, "Testing without a headset", URL flags, scripts, layout, status.
- **Self-test:** every feature gets checks driven the way a player would drive them, with numeric assertions
  and a count in the README.
- **Plain, specific reports to Alex.** He tests on the real headset and reports feel ("jank", "rubber bands",
  "hard to use"). Take these seriously; they've led to the biggest fixes so far.

---

## 5. Architecture

### 5.1 Module layout (suggested)

```
src/
  main.ts, app.ts, config.ts
  core/        renderer, xr-session, settings, stats (+gpu timers), events, math
  input/       xr-input
  dev/         emulator, driver, selftest, probe, snapshot, frame-clock, capture (frame sequences), bench
  level/       level.ts (geometry + colliders + material ids), procedural.ts (test levels), gltf.ts (later)
  scan/        scanner.ts (modes, patterns, aim, beam fx), backends/{main,worker,gpu}.ts, worker.ts
  cloud/       store.ts (chunks, blocks, dedup grid), render.ts (dot material, palettes, culling), palettes.ts
  play/        locomotion (scanned-floor teleport, collision walk), hands, audio
  lab/         fidelity lab scene + toggles (wrist menu page)
```

### 5.2 The level

- **Geometry is invisible.** The level is one or more triangle meshes that are never drawn as colour. They serve
  four purposes:
  1. Rapier static trimesh colliders, for scanning rays and player collision.
  2. An optional **depth-only pre-pass** for occlusion (§5.6).
  3. The GPU scanning pass, if used (§5.4 C).
  4. Material ids per triangle or mesh, for dot colour accents and hit sounds.
- **Procedural test levels for M1:**
  - A 20×4×20 m room with pillars (matching the benchmark).
  - A corridor maze.
  - A cave: a noise-displaced tube or heightfield.
  - Stairs and a ramp, to test height changes and collision.
  - Keep triangle counts realistic: 50 k–500 k (ray cost is flat; the depth pass scales with triangles).
- **Authoring in M5:** glTF via three's `GLTFLoader`.
  - Alex's PC has a **Blender MCP server** (`mcp__Blender__*` tools). It needs Blender running with the add-on.
    It could build or export levels; ask Alex before relying on it.
  - Material ids come from glTF material names.
- **Spawn and scale:** real-world metres. Ceilings around 2.5–4 m make the dots read as architecture.

### 5.3 The scanner

- **Hand-held,** in the dominant hand (Alex is likely right-handed; don't assume, make it switchable).
  - The model is drawn dimly, or as dots of its own.
  - A small emitter glow; short-lived beam lines from the emitter to a few of this frame's hits. Keep them few,
    thick-ish and soft, for the codec (§6).
- **Modes** (trigger is spray; the others are for Alex to choose from):
  - **Spray** (trigger, analogue: the cone narrows as you squeeze harder): a 30–40° cone, R rays per frame.
    Sample with a stratified golden-angle spiral, rotated randomly each frame. Avoid fixed patterns: they make
    moiré and codec-unfriendly regularity.
  - **Sweep line** (grip or A): a vertical fan of about 256 rays that paints columns as you turn.
  - **Focus** (trigger plus stick click): a narrow 5° cone for detail work.
  - **Pulse** (optional, rare, with a cooldown): one big sphere of rays (e.g. 20 k, spread over a few frames).
    A reveal moment.
- **Rate control:** the backend reports how many rays it can afford this frame (§7). The scanner never asks for
  more.
- **Feedback:**
  - Haptic texture scaled by hit rate and distance.
  - A scanner hum whose pitch follows the trigger.
  - Granular hit ticks, spatialized and rate-limited.
- Hits on the **sky or void** (no hit within max range, e.g. 60 m) add nothing, or a faint far dot. Decide in the
  lab.

### 5.4 Ray-casting backends

Put them behind one interface so they can be swapped and compared:

```ts
interface ScanBackend {
  /** Queue rays for this frame; results come back now (main) or a frame later (worker, gpu). */
  request(origin: Vector3, basis: Matrix3, pattern: Pattern, count: number, seed: number): void;
  /** Hits completed since the last call: x, y, z, distance, materialId (Float32Array, reused). */
  drain(out: HitBuffer): number;
  /** How many rays this backend can afford per frame right now. */
  budget(): number;
}
```

- **A. Main thread (M1).** Rapier `castRayAndGetNormal` on the static world: about 3 µs per ray, budget about
  500/frame.
  - Don't allocate per ray: reuse one `RAPIER.Ray`, and set `origin` and `dir` fields.
- **B. Workers (M4).** 2–4 Web Workers, each with its own Rapier world built from the same vertex and index
  arrays (send them once).
  - Each frame the main thread posts `{origin, basis, count, seed, mode}` to each worker. Each returns a
    transferable `Float32Array` of hits. The one-frame latency is fine.
  - Use `navigator.hardwareConcurrency - 2` workers, capped at 4.
  - About 1,500–3,000 rays per frame per worker, with no main-thread cost.
  - No SharedArrayBuffer is needed, so no COOP/COEP headers. Rapier's compat build inlines its wasm, so each
    worker loads its own ~2 MB copy; that's acceptable.
- **C. GPU depth scanning (M6, only if needed).**
  - Render the level from the scanner's viewpoint into a small float render target (e.g. 128×128 for the cone):
    a world-position shader writes `xyz` and `materialId` (MRT, or two passes).
  - Read it back **asynchronously** with `renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h, buffer)`. It
    exists in three r186's WebGLRenderer (PBO + fence). It gives 16 k hits per frame for a fraction of a ms of
    GPU and no CPU ray cost; feed them into the same CPU store.
  - Jitter the sample grid each frame (sub-pixel offsets plus pattern rotation) to avoid regular patterns.
  - The render target must match the XR renderer's shader variant rules: read §7.4 first.
  - Rejected for now: a fully GPU-resident point store (scatter into a float texture ring buffer with vertex
    pulling). WebGL2 has no compute, deduplication on the GPU is awkward, and gameplay needs CPU access (to
    check scanned floor). Revisit only if the CPU store becomes the bottleneck.

### 5.5 The point store (CPU, the source of truth)

**Spatial chunks.** Cubes of 8 m on a world grid, in a `Map<chunkKey, Chunk>`. Each chunk owns:
- **Blocks:** fixed-size GPU buffers of 65,536 points each. Each block is one `THREE.Points` with its own
  `BufferGeometry`. A chunk gets more blocks as it fills.
- A **bounding box**, updated as points are added. Set `geometry.boundingSphere` manually so frustum culling
  works; never call `computeBoundingSphere` per frame.
- A **dedup set**: an open-addressing `Uint32Array` hash of occupied cells (cell = 2–3 cm), keyed by local
  cell coordinates packed into 30 bits (10 bits per axis: 8 m / 2.5 cm = 320 < 1024).
  - A new hit whose cell is occupied is dropped. This bounds the dot count by **surface area**, not time spent
    scanning, and makes rescanning free.
  - Tune the cell size in the lab: smaller is denser and costs more dots.

**Point format.** Interleave the attributes in one buffer.
- **M1 (simple):** position `Float32×3` + `Uint8×4` (palette index from scan distance, material id, birth time
  (low 8 bits, for fade-in), flags) = 16 bytes per point.
- **M4 (compact):** position as `Int16×3` *normalized* (chunk-local, so the Points object's `position` is the
  chunk centre and `scale` is half the chunk size, giving 0.12 mm resolution) + `Uint8×2` = 8 bytes per point.
  4 M dots take 32 MB.
- **Colour is not stored as RGB.** Store a palette index plus material, and have the shader look the colour up
  in a small palette (uniform array or 256×1 texture). The lab can then switch palettes live with no
  re-upload.

**Appending.**
- Write new points into the current block's typed array.
- Call `attribute.addUpdateRange(start, count)` and set `needsUpdate`, so only the new bytes are uploaded:
  about 1,000 points × 16 B = 16 KB per frame.
- Extend the draw range with `geometry.setDrawRange(0, count)`.
- **Never re-upload a whole block, and never allocate per frame.**

**Capacity.**
- A global cap of `maxDots` (e.g. 4 M on PC, set from the measured GPU budget).
- At the cap, either stop adding (and say so in the UI), or recycle the oldest blocks: a ring of blocks.
  Decide with Alex; the default is to stop and show "memory full" as a gameplay element.

**Gameplay queries.**
- `isScanned(x, y, z, radius)` looks up the dedup grid. Teleport uses it to accept only scanned floor.
- Optional: density per area, for hints.

### 5.6 Rendering the dots

**Material.** `ShaderMaterial`, `toneMapped: false`, depth test and depth write on, opaque (no blending, so no
sorting), and **`alphaToCoverage = true`** for soft round edges without blending. That needs MSAA, which is on.
- If alpha-to-coverage looks bad in the headset, fall back to a hard `discard` circle plus a slightly larger
  minimum size.

**Size, per eye.**

`px = clamp(worldDiameter * P / -mv.z, minPx, maxPx)`

where `P = projectionMatrix[1][1] * viewportHeight * 0.5` (see `glider/air.ts`). Pass `viewportHeight` per draw
from `renderer.getCurrentViewport()` in `onBeforeRender`: each eye has its own viewport.

Starting values (the lab tunes them):
- `worldDiameter` about 1.0–1.5 cm.
- **`minPx` = 2.5–3**, for the codec (§6.2).
- `maxPx` = 10.

For scale: at 2160 px and about 104° vertical FOV, P ≈ 844 px per unit at 1 m. A 1.2 cm dot is about 10 px at
1 m and 3.4 px at 3 m, then the floor applies.

**Brightness and colour.**
- Colour from the palette (by distance at scan time, or by current view distance: a toggle) times a brightness
  curve with a **floor** (§6.2).
- Optionally, **a slight brightness falloff with view distance** for depth reading, never below the floor.

**Fade-in.** New dots **grow** from 0 to full size over 120–200 ms, using the birth time. Prefer growing to
alpha fading: alpha with alpha-to-coverage dithers in 4 coverage steps, and growth is kinder to the codec.

**Occlusion pre-pass (toggle, on by default).**
- Draw the level meshes with `colorWrite: false, depthWrite: true` before the dots (`renderOrder`), so dots
  behind walls you haven't scanned are hidden.
- The result is cleaner and more readable (unscanned walls show as silhouettes in the dark), with fewer
  overlapping dots for the codec.
- Cost: the level's triangles, twice. Fine up to about 1 M triangles.
- Gameplay alternative: "x-ray" off.

**Draw calls.** One per block per eye. 4 M dots are about 61 blocks, so about 122 draw calls: fine. Frustum
culling is per block, via each chunk's bounding sphere.

**LOD (later, only if needed).** Shuffle each block's points when it seals, so any prefix is a uniform
subsample. Far chunks then draw a prefix (`drawRange`) with slightly larger dots.

**Transient dots (later).** Moving things (an entity, water) go in a separate small ring buffer that fades
after 1–2 s and is never stored.

### 5.7 Frame loop order

```
xr input → locomotion (collision walk / teleport validity via isScanned) → scanner.update (aim, mode, budget)
→ backend.request(...) ; hits = backend.drain()   (main: same frame; worker/gpu: last frame's)
→ store.append(hits) (dedup, write, addUpdateRange)  → beam fx (a few lines to recent hits)
→ audio/haptics → render: [level depth pre-pass] → dots (blocks, culled) → hands/scanner/beam/UI
```

Keep the scan-to-dot path allocation-free: reuse typed arrays and preallocate the hit buffers. Chrome's GC
pauses become visible stutter in VR.

---

## 6. Visual fidelity through the stream: the core of this plan

### 6.1 Why lidar dots are hard for video codecs

- **Block transforms.** H.264, HEVC and AV1 code 4×4 to 64×64 blocks with DCT-like transforms. A tiny bright
  dot on black is high-frequency energy, so it either costs many bits or gets quantized. Quantized dots come out
  dimmer, smeared and haloed, with ringing and blocky noise around them. Dense dot fields at a bitrate cap look
  like crawling noise.
- **4:2:0 chroma subsampling.** Colour is stored at half resolution in each direction. Small coloured dots lose
  saturation and colours bleed between neighbours. A 2–3 px dot's colour averages with the black around it.
- **Darks are crushed.** Encoders spend fewest bits in dark regions, and deblocking smooths small low-contrast
  details away. Dim far dots near black disappear or shimmer.
- **Temporal noise is the most expensive thing.** Sub-pixel aliasing, popping and per-frame jitter defeat motion
  compensation, so every frame re-codes the dots. Stable, smoothly moving dots are cheap; flickering ones are
  not.
- **Foveated streaming (?).** If the stream is sharper where you look, dots in the periphery degrade more. That's
  acceptable, as long as no gameplay information lives only in tiny peripheral dots.
- **Reprojection.** When frames drop, SteamVR warps the last frame, and dense dot fields smear. Keep headroom.
- **Large flat black areas are nearly free.** This game's black background is an advantage: the bitrate goes
  into the dots.

### 6.2 Design rules (starting values; the lab confirms them)

1. **Minimum dot size of 2.5–3 px** in eye-buffer pixels: an angular size of at least about 0.13°.
2. **Soft round dots,** alpha-to-coverage with MSAA. No hard 1-pixel dots, no squares.
3. **Contrast through brightness, not just hue.** The palette must vary in luma: bright warm near (white-amber),
   dimmer cool far (teal or blue). Colour-only differences (red vs. blue at the same luma) don't survive 4:2:0.
4. **A brightness floor:** the dimmest dot is at least about 25–30% of the brightest (sRGB at least about
   60/255). Below that, the encoder crushes it.
5. **No per-frame jitter or flicker.** Dots appear by growing in over about 150 ms, then stay perfectly still. No
   twinkle, no random per-frame alpha, no animated noise. If something shimmers, it should be big and slow.
6. **Density cap:** the dedup cell (2–3 cm) keeps the far field from becoming noise. Optionally, larger and
   sparser dots far away (LOD) so the far field is a soft texture rather than a sparkle storm.
7. **Beams and FX:** few, short-lived, at least 2–3 px wide, soft. Don't sweep many 1 px lines across the frame.
8. **No full-screen post-processing** (bloom, grain, vignette noise). It costs GPU in XR, and grain is poison to
   the codec. Glow belongs in the dot shader (a softer falloff), not a post pass.
9. **Keep frame time at 80% or less of budget,** to avoid reprojection smear. Prefer 90 Hz; offer 72 Hz.
10. **Tone mapping off for dots** (`toneMapped: false`), so their luma is predictable and the floor holds.

### 6.3 Offline codec simulator (build in M2; it lets you iterate without the headset)

ffmpeg is installed: `C:\Software\ffmpeg-master-latest-win64-gpl-shared\bin\ffmpeg.exe`, already on PATH. It has
`h264_nvenc`, `hevc_nvenc`, `av1_nvenc` (the same NVENC hardware SteamVR is likely to use on this PC), and
`libx264`, `libx265` and `libsvtav1`.

**1. Capture.**
- Add a dev route, e.g. `?emulate&capture=name&frames=90&motion=yaw60`.
- It renders a scripted head motion offscreen, using the same render-target path as `dev/snapshot.ts`, at
  **2160×2160 per eye** (one eye is enough to start; later side-by-side 4320×2160).
- It POSTs each frame to a dev-server sink that writes `.captures/name/0001.png`.
- Motions to script:
  - Still.
  - A slow yaw of 30°/s.
  - A fast yaw of 120°/s.
  - Walking forward at 1.4 m/s.
  - Scanning, while dots are being added.

**2. Encode at realistic bitrates.**
- Bracket per eye: **25, 50, 100 and 200 Mbps** at 90 fps. Ask Alex what SteamVR reports for the link, then set
  the realistic one.
- Use 8-bit 4:2:0 first, and also 10-bit (`-profile:v main10 -pix_fmt p010le` for HEVC) to see whether 10-bit
  helps dark dots.

```bash
ffmpeg -y -framerate 90 -i .captures/name/%04d.png -c:v hevc_nvenc -preset p5 -tune hq -rc cbr -b:v 100M -maxrate 100M -bufsize 2M -pix_fmt yuv420p .captures/name_hevc100.mp4
```

```bash
ffmpeg -y -i .captures/name_hevc100.mp4 .captures/name_hevc100/%04d.png
```

**3. Measure and look.**

```bash
ffmpeg -i .captures/name_hevc100.mp4 -framerate 90 -i .captures/name/%04d.png -lavfi "[0:v][1:v]ssim=stats_file=-" -f null -
```

- SSIM and PSNR over the whole frame are dominated by black, so also make **crops** of dot-dense regions,
  source next to decoded, enlarged 3–4× with nearest-neighbour scaling. Write a small Python script with PIL
  (PIL is installed; numpy is not).
- vr-test's `tools/contact-sheet.py` tiles images.
- **A "dot survival" metric for the test pattern:** render a known grid of dots, then measure each dot's peak
  luma after decoding divided by before. Report the median and 10th percentile per size, palette and distance.
  The dot positions are known, so no numpy is needed: just sample them with PIL.
- **Temporal shimmer:** encode a still-camera sequence and a slow-yaw one, then compare frame-to-frame
  differences of decoded vs. source (ffmpeg `tblend=all_mode=difference,signalstats`, look at YAVG).

**4. Iterate** on dot size, softness, palette, floor and density using these numbers, then confirm in the
headset (§6.4). The simulator is a proxy: the real stream may use different settings, foveation and a different
encoder configuration. Its job is to rank options, not to predict exact quality.

### 6.4 In-headset fidelity lab (`?lab`; for Alex in M3)

- A dark test room, **pre-filled with dots** (no scanning needed), with test walls at 1, 3, 6 and 12 m.
- Each test wall is split into labelled tiles showing variants:
  - minimum size: 1.5 / 2.5 / 3.5 px;
  - edge: hard / soft A2C / soft A2C with a larger falloff;
  - palette: luma-rich / hue-only / monochrome;
  - floor: 10 / 25 / 40%;
  - density: dedup cell of 1.5 / 2.5 / 4 cm.
- Plus a scanning area to judge fade-in and beam FX in motion.
- **A wrist-menu "Lab" page** with global toggles: style preset A/B/C, minimum px, softness, palette, floor,
  density, occlusion pre-pass, target refresh rate (72/90/120 via `session.updateTargetFrameRate`), and a perf
  HUD.
- **What Alex reports:**
  - Which tiles look crisp versus smeary, still and turning.
  - Whether far dots vanish or crawl.
  - Whether colours read.
  - Comfort in the dark.
  - The SteamVR numbers (§6.5).
- Lock the defaults from his answers and record them in DECISIONS.md.

### 6.5 Settings to check on the PC and headset (ask Alex)

- **SteamVR → Settings → Video:** render resolution (100% or custom) and refresh rate. WebXR's framebuffer
  follows the recommended size; `renderer.xr.setFramebufferScaleFactor` scales it.
- **Frame streaming settings** (in SteamVR or Steam Link on the Frame): codec (HEVC or AV1), bitrate or quality
  slider, whether foveated streaming is on, Wi-Fi link rate.
- **The SteamVR performance graph:** frame time and reprojection rate while scanning and with millions of dots.
- **The game's own Info page** (copy vr-test's wrist-menu Info page): framebuffer size, refresh rates, input
  profiles. This tells you the real eye resolution. Don't assume 2160.

---

## 7. Performance plan

### 7.1 Budgets

See §3.3.

- **Hard rule:** the dot count is governed by measured GPU time, not a fixed number. Raise `maxDots` only when
  the timer queries show headroom.
- On the standalone path, if it ever works, start at `maxDots` of about 0.5–1 M, with minimum px kept at 3 or
  more.

### 7.2 Measuring

- **GPU timers:** wrap `renderer.render` in `EXT_disjoint_timer_query_webgl2` queries (confirmed available in
  Chrome on this PC). Ring-buffer the queries and read results 2–3 frames later.
  - Note: `renderer.info` resets on every `render` call, and XR renders both eyes inside one call.
- **CPU timers:** `performance.now()` around scan, append and upload, and around `renderer.render` (submission).
- **Perf HUD** (wrist menu): dots total and visible, blocks drawn, rays per frame, hits per frame, dedup drop
  rate, GPU ms, CPU ms, FPS, and the reprojection guess (frame interval > 1.5× target).
- **`?bench` mode:** a scripted scene that fills N dots and reports `window.__bench`, like the standalone
  benchmark but through the real renderer. Run it before and after optimizations, and record the numbers in
  DECISIONS.md.

### 7.3 Optimizations, roughly in order of value

1. Upload only appended ranges (`addUpdateRange`). Never `needsUpdate` a whole buffer.
2. Dedup grid: bounds dots by area, and rescanning is free.
3. Per-block frustum culling with correct bounding spheres.
4. Workers for rays (backend B).
5. Compact 8-byte points (Int16 normalized + palette and material bytes).
6. No per-frame allocations; reuse `Ray` and buffers.
7. Occlusion pre-pass (improves readability and the codec; costs a little GPU).
8. LOD by shuffled prefixes for far chunks (only if needed).
9. GPU depth scanning with async readback (backend C, only if ray rate is the limit).
10. Multiview (OVR_multiview2) would halve vertex work for stereo. three r186's XR multiview path needs WebXR
    Layers, which the community Frame browser lacks, and PC Chrome's support with SteamVR is unknown. Don't
    plan on it.

### 7.4 Lessons from vr-test that apply directly

- **Shader variants and render targets.** In three, rendering to a plain (linear) render target uses different
  shader variants (no tone mapping, linear output) than the screen. Alternating between them makes **every
  material switch programs twice a frame**. That cost vr-test 2× CPU in its portal pass.
  - If you add any offscreen pass that draws ordinary materials, use an XR-flagged sRGB target the way
    `vr-test/src/portals/portals.ts` does.
  - Or use dedicated materials that exist only for that pass. For GPU scanning (backend C), use a dedicated
    `ShaderMaterial` for the position pass; then the variant switching doesn't touch the main materials.
- **Draw calls cost about 10 µs each** in Chrome here. Keep them in the low hundreds.
- **XR eye cameras:** read their matrices from `renderer.xr.getCamera().cameras[i]`. Don't call
  `updateMatrixWorld` on them: they have no parent, and recomputing drops the rig transform.
- **Snapshots:** use `snapshot.ts` with `internalFormat = 'RGBA8'`. The old version double-encoded sRGB and made
  everything look brighter than the headset. Fidelity decisions made on wrong snapshots are wrong.
- **Comfort:** Alex noticed lag and "rubber-banding" immediately in vr-test's first inventory. Anything attached
  to the body or hands must be pose-exact in the same frame. Smoothing that lags reads as jank in VR.

---

## 8. Milestones and acceptance criteria

Each milestone ends with: `npm run build` clean, the self-test green on the dev server **and** the production
build (`npm run preview`), DECISIONS.md and README updated, and a short plain-language report to Alex. Commit
or push only when he asks (§10).

### 8.0 Where things stand (2026-10-20)

Alex's answers (§1.1) changed the order: levels come from Blender from the start, walking is analogue,
scans persist, and the first milestone is the technical one. **V1 is done in the emulator** (details and
numbers in DECISIONS.md):

- **Done:** M0 (scaffold, launch configs, benchmarks re-run within 20%) and M1 (scanner, point store with
  dedup and range uploads, dot shader, occlusion pass, perf read-out), plus from later milestones: Blender
  levels with animation (from M5), analogue walking with collision and stairs (M5), saving the scan (M7),
  fading entity dots (M7), the GPU timer and an in-game benchmark (M4, §7.2). 21 self-test checks, green on dev
  and production builds.
- **Measured:** 4 M dots cost 1.0–2.2 ms GPU for both 2160² eyes in normal views (2.8 ms worst case), rays
  1.2–1.9 µs each in the game (850–1,300 per frame in a 1.6 ms budget), 950k dots restore in 200 ms.
- **Not done:** anything on the real headset, and the stream fidelity work (M2). The look has only been
  judged on emulator snapshots.

**Next, in order:**
1. **M3-lite, a first headset session (Alex):** the README's first-run checklist. It's cheap and answers the
   biggest unknown (how dots survive the stream) before building tools around guesses.
2. **M2, fidelity lab and codec simulator** (§6.3–6.4), shaped by what Alex reports.
3. **Ideas the V1 work turned up:**
   - *Distance-scaled dedup.* Heavily scanned surfaces 10 m+ away fill in to near-solid grey (2.5 px dots at
     2.5 cm spacing). A dedup cell that grows with scan distance (a few nested grids) would keep far surfaces
     dotty, save memory, and still let you add detail by walking closer. A lab toggle.
   - *Save hitch.* Each grown block is copied on the main thread when the save runs (every 5 s). Measure it
     in the headset; spread it over frames or move it to a worker if it shows.
   - *Scanner modes* (§5.3: sweep line, pulse) and *gameplay* (§M5): once the look is settled.

The milestone list below is the original plan, kept for reference.

**M0. Scaffold (half a day)**
- New Vite project in `C:\Projects\cc\lidar`, built from vr-test's foundation (§4.1).
- Launch configs (§10).
- `?emulate&autostart` enters an emulated session in a black room with hands.
- `?emulate&selftest` runs boot checks: session started, controllers connected, no frame errors.
- `bench/` runs: the points bench through the dev server, the ray bench with this project's own Rapier.
- **Accept:** the bench numbers are within about 20% of §3.

**M1. Scanner and point cloud (CPU main-thread backend)**
- A procedural test level (room with pillars, corridor, stairs), invisible, with Rapier colliders.
- Spray mode, the point store (Float32 format first) with chunks, blocks, dedup and addUpdateRange, and the dot
  shader with per-eye size, minimum px, alpha-to-coverage, palette and fade-in.
- The occlusion pre-pass toggle, and the perf HUD.
- **Self-test checks:**
  - Scanning a wall adds dots inside the cone only.
  - Rescanning the same wall adds about 0 (dedup).
  - Dots persist.
  - The upload is only the appended range (instrument `addUpdateRange`).
  - 1 M dots render within the GPU budget (timer query) in the emulator.
  - No allocations per frame (count `new` in hot paths, or watch `performance.memory` in Chrome over 300
    frames).
- **Accept:** scanning feels continuous at 90 Hz in the emulator, and the snapshots read clearly.

**M2. Fidelity lab and codec simulator**
- `?lab` scene and the wrist Lab page (§6.4).
- The capture route and sink, plus the ffmpeg scripts (§6.3), in `tools/`.
- **Accept:**
  - A report with crops at 25/50/100/200 Mbps per eye for 3–4 candidate styles.
  - Dot-survival and shimmer numbers.
  - A recommended default style.

**M3. Headset round 1 (Alex)**
- A README "first run on the Frame" checklist focused on the lab: crispness still and turning, far dots, colour,
  comfort in darkness, the SteamVR numbers.
- **Accept:** Alex picks defaults; they're recorded in DECISIONS.md.

**M4. Scale**
- Worker backend B.
- Compact 8-byte points.
- Chunk culling verified.
- `maxDots` raised to what the GPU timers allow (target 4 M on PC).
- Perf regression checks in the self-test: GPU ms at 1 M and 4 M dots, rays per frame without main-thread cost.

**M5. Gameplay foundation**
- **Locomotion:** walking with collision via Rapier's KinematicCharacterController, and teleport only onto
  scanned floor (the `isScanned` query).
- Scanner modes (sweep line, focus, pulse).
- Audio and haptics.
- glTF level loading.
- One small playable level with a goal (find the exit, reach a beacon).
- **Comfort:** the vignette on smooth moves, snap turn default, and **a faint stable reference** (a floor ring
  under your feet or a dim compass in the hand). Darkness with only dots can induce motion sickness.

**M6. GPU depth scanning (only if the ray rate limits play)**
- Backend C with `readRenderTargetPixelsAsync`; compare with B in DECISIONS.md.

**M7. Content and polish**
- Levels, the atmosphere Alex chose (horror or not), transient dots for moving things, an optional save of the
  scan.

---

## 9. Testing and verification

- **Emulator:** `?emulate`, `?emulate&devui` (mouse and keyboard control), `?emulate&autostart`,
  `?emulate&selftest[=names]`.
  - The driver API, from vr-test's `dev/driver.ts`: `setHeadWorld`, `setGripWorld`, `setAimWorld`, `press`,
    `stick`, `frames(n)`, `seconds(s)`, `waitFor(pred)`, `measureGripOffsets()` (call this first),
    `resetWorld()`.
- **Make scans deterministic** in tests: seed the ray pattern from a `?seed` param or the driver.
- **Numeric checks over pictures,** then snapshots for review: `__vr.snapshot(name, {from, to, fov})` → PNG in
  `.snapshots/`, which you can open with the Read tool.
- **Self-test timing gotchas:**
  - The hand-velocity estimate looks back about 85 ms. After teleporting a test hand, wait at least 0.15 s
    before a release that must not count as a throw.
  - Wait on conditions (`waitFor`), not fixed frame counts. Frame timing varies in the throttled pane.
- **On hardware** (Alex only): the README checklist per milestone.
- Always run the full self-test on both the dev server and the production build before reporting "done".

---

## 10. Environment, tools and working rules on this PC

**Machine and paths**
- Windows 11; the workspace is `C:\Projects\cc`. vr-test is at `C:\Projects\cc\vr-test`.
- GPU: RTX 4080 (driver 617.42). Node v22.16. npm. Python 3: PIL yes, numpy no.
- ffmpeg as in §6.3.
- The shell is Git Bash (POSIX); PowerShell is also available.
- **Complex heredocs and quoting fail in Bash here.** Write Python edit scripts to your scratchpad and run them
  with `python -I script.py`.
- **Avoid `sleep` in Bash** (MSYS cygheap failures). Wait inside page scripts instead.

**Dev servers and the Claude browser pane**
- Never start dev servers with Bash. Use `preview_start` with a config in `C:\Projects\cc\.claude\launch.json`.
- Existing entries: `vr-test` (5173), `vr-test-preview` (4173), `spark-portal` (8090).
- Add these entries:

```json
{ "name": "lidar", "runtimeExecutable": "npm", "runtimeArgs": ["--prefix", "lidar-game", "run", "dev", "--", "--port", "5180", "--strictPort"], "port": 5180 },
{ "name": "lidar-preview", "runtimeExecutable": "npm", "runtimeArgs": ["--prefix", "lidar-game", "run", "preview", "--", "--port", "4180", "--strictPort"], "port": 4180 }
```

- **The pane can be 0×0 when hidden.** Before snapshots or self-tests, call `resize_window` 1280×720 on the tab.
  Reset it to the `desktop` preset afterwards.
- **JS tool calls time out at 45 s.** Poll long runs across several calls (`while (!done && t < 40 s) await
  sleep(1000)`).
- **`file://` pages render as static snapshots** in the pane. Serve test pages through the dev server
  (a git-ignored folder works).
- **WebGL in the pane can die** after many reloads. Fix: restart the app, or the headless Edge fallback:
  - `"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --remote-debugging-port=9333
    --user-data-dir=<scratch profile>`, driven by a small Node script over CDP (Page.navigate, Runtime.evaluate).
  - Kill only processes whose command line contains that profile path.
- **Another session may share the folder.** Earlier, a second Claude session ran in vr-test's working tree and
  started its own dev server on the same port.
  - Run `git status` before big edits, and don't overwrite others' uncommitted work.
  - Pick unique ports.

**Git and GitHub**
- Git has **no global identity** here. Set it per repo:
  - `git config user.name alexh95`
  - `git config user.email 5580213+alexh95@users.noreply.github.com`
- End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Push straight to `main`: no branches, no PRs** (Alex's rule for his solo repos). **Commit and push only when
  Alex asks.**
- Creating a GitHub repo: `gh` is logged in as `alexh95` and pushes over SSH, but **ask Alex first**. vr-test is
  private.
- If an auto-mode permission check blocks a push, don't work around it. Tell Alex; he can allow it.

**Memory**
- Sessions started in `C:\Projects\cc` share an auto-memory; it has a `project-lidar-game` entry. Don't
  duplicate what the repo records.

**Working with Alex**
- He tests on the real headset and reports feel tersely ("jank", "rubber bands", "hard to use"). Ask a focused
  question if a choice is genuinely his (like the open questions in §1); otherwise use sensible defaults and say
  what you chose.
- Reports: plain and specific, numbers over adjectives, what's verified and how, what isn't.
- Tell him clearly when something only he can check on the Frame.

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Streaming artifacts make dots smeary or crawling | §6 rules, the offline simulator, the in-headset lab, minimum px ≥ 3, the brightness floor, no flicker |
| Motion sickness in darkness (no horizon, vection from dot fields) | Teleport and snap turn by default, a vignette on smooth moves, a faint stable floor ring or compass, no forced camera motion, slow fade-ins |
| Main-thread hitches (GC, uploads) | Allocation-free hot paths, range uploads, workers for rays |
| Frame drops cause reprojection smear | Keep 20% GPU headroom; the dot cap comes from GPU timers; offer 72 Hz |
| Point memory grows forever | Dedup by area, `maxDots`, block ring or "memory full" |
| The Frame's real eye resolution or codec differs from the assumptions | Read the Info page and SteamVR settings early (M3) and adjust `minPx` and palette |
| The standalone browser never gets reliable WebXR | Plan for the PC path. Standalone is a stretch with a lower dot budget. |
| Copyright | Inspired by Scanner Sombre only: original assets, names and text. |

---

## 12. Appendix: APIs and formulas

**three.js r186** (verified in `vr-test/node_modules`)
- `BufferAttribute.addUpdateRange(start, count)` / `clearUpdateRanges()`, `setUsage(DynamicDrawUsage)`,
  `geometry.setDrawRange(start, count)`.
- `Material.alphaToCoverage = true` (needs `antialias: true`, so MSAA).
- `renderer.readRenderTargetPixelsAsync(rt, x, y, w, h, buffer)`: WebGL2 async readback (PBO + fence).
- `renderer.getCurrentViewport(v4)` inside `onBeforeRender`: the per-eye viewport (pixels).
- `renderer.xr.getCamera().cameras` (eye cameras), `renderer.xr.setFramebufferScaleFactor`,
  `renderer.xr.setFoveation`.
- Point-size pattern: `src/glider/air.ts` in vr-test.

**Rapier 0.21 compat**
- `RAPIER.ColliderDesc.trimesh(Float32Array, Uint32Array)`, `world.castRayAndGetNormal(ray, maxToi, solid,
  filterFlags?, groups?, excludeCollider?, excludeBody?, predicate?)`, `new RAPIER.Ray(origin, dir)` (reuse it:
  mutate `ray.origin` and `ray.dir`).
- `world.createCharacterController(offset)` → `KinematicCharacterController` for walking with collision.
- Benchmark: about 3 µs per ray (§3.2).

**Formulas**
- Pixels per unit at 1 m, per eye: `P = projectionMatrix[1][1] * viewportHeight / 2`. For 2160 px and a 104°
  vertical FOV, P ≈ 844.
- Dot size in px: `clamp(worldDiameter * P / distance, minPx, maxPx)`.
- Angular size of one pixel at 2160 px / 104° ≈ 0.048°. 3 px ≈ 0.14°.
- Dedup key in an 8 m chunk with 2.5 cm cells: `(cx << 20) | (cy << 10) | cz`, with `c* = floor(local/0.025)`
  in 0..319.
- Memory: points × bytes per point (16 now, 8 compact). 4 M × 8 B = 32 MB.
- Rays per second = rays per frame × refresh rate. 500 × 90 = 45 k dots/s before dedup.

**Files in this folder**
- `PLAN.md`: this document.
- `bench/points-bench.html`: the GPU dot-rendering benchmark (§3.1).
- `bench/ray-bench.mjs`: the Rapier ray benchmark (§3.2).
