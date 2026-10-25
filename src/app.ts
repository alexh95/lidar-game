import { Group, HemisphereLight, PerspectiveCamera, Quaternion, Scene, Vector3, type WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { flags, tuning } from './config';
import { bus } from './core/events';
import { createRenderer } from './core/renderer';
import { settings } from './core/settings';
import { GpuTimer, Stats } from './core/stats';
import { XRSessionManager } from './core/xr-session';
import { XRInput } from './input/xr-input';
import { Physics } from './physics/physics';
import { Level } from './level/level';
import { createPaletteTexture, writePalette } from './level/materials';
import { createDotMaterial, createDotUniforms, type DotUniforms } from './cloud/dots';
import { PointStore } from './cloud/store';
import { FadingDots } from './cloud/fading';
import { ScanSave } from './cloud/persist';
import { Scanner } from './scan/scanner';
import { Locomotion } from './play/locomotion';
import { createHandMaterial, HandModel } from './hands/hand-model';
import { WristMenu } from './ui/wrist-menu';
import { audio } from './audio/audio';
import { Ambience } from './audio/sfx';

const AUTOSAVE_SECONDS = 5;

export class App {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  /** Player root: tracking space is placed in the world through this. */
  readonly rig = new Group();
  readonly xrCamera = new PerspectiveCamera(70, 1, 0.03, 400);
  /** Free camera for the desktop preview. */
  readonly desktopCamera = new PerspectiveCamera(60, 1, 0.03, 400);
  readonly input = new XRInput();
  readonly xr: XRSessionManager;
  readonly stats = new Stats();
  readonly gpu: GpuTimer;
  readonly rigQuat = new Quaternion();
  readonly palette = createPaletteTexture();
  readonly dotUniforms: DotUniforms = createDotUniforms(this.palette);
  physics!: Physics;
  level!: Level;
  cloud!: PointStore;
  fading!: FadingDots;
  save!: ScanSave;
  scanner!: Scanner;
  locomotion!: Locomotion;
  wristMenu!: WristMenu;
  handModels!: { left: HandModel; right: HandModel };
  readonly ambience = new Ambience();
  private orbit!: OrbitControls;
  /** Extra height when the runtime only offers 'local' (eye-level origin). */
  floorOffset = 0;
  /** Seconds since the app started: dots' birth times and the shader's clock. */
  time = 0;
  frameCount = 0;
  private last = performance.now();
  private lastSave = 0;
  private needsSpawn = false;
  readonly errors: string[] = [];
  /** Called once per frame after everything updated (tests hook in here). */
  onFrame: ((dt: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = createRenderer(canvas, settings.quality);
    this.xr = new XRSessionManager(this.renderer);
    this.gpu = new GpuTimer(this.renderer);
  }

  get inXR(): boolean {
    return this.renderer.xr.isPresenting;
  }

  get camera(): PerspectiveCamera {
    return this.inXR ? this.xrCamera : this.desktopCamera;
  }

  async init(): Promise<void> {
    this.physics = await Physics.create();
    this.level = await Level.load(flags.level, this.physics);
    const scene = this.scene;
    scene.name = 'lidar-game';
    scene.add(this.level.root);
    this.level.root.visible = settings.occlusion;

    // The dots.
    writePalette(this.palette, settings.palette);
    this.dotUniforms.uMinPx.value = settings.minPx;
    this.dotUniforms.uGrow.value = tuning.growSeconds;
    this.cloud = new PointStore(createDotMaterial(this.dotUniforms), this.dotUniforms, tuning.dedupCell, tuning.maxDots);
    this.fading = new FadingDots(tuning.entityCapacity, createDotMaterial(this.dotUniforms, tuning.entityLife), this.dotUniforms, tuning.entityLife);
    scene.add(this.cloud.root, this.fading.points);
    this.save = new ScanSave(this.cloud, this.level.name, this.level.hash, flags.slot);
    if (!flags.fresh) await this.save.restore(this.time);

    // Only the hands and the scanner are lit: a faint sky and the scanner's lens.
    scene.add(new HemisphereLight(0x8a9096, 0x101012, 0.35));

    this.rig.name = 'rig';
    this.rig.add(this.xrCamera);
    scene.add(this.rig, this.desktopCamera);
    const handMat = createHandMaterial();
    handMat.color.setHex(0x8d8a86);
    this.handModels = { left: new HandModel('left', handMat), right: new HandModel('right', handMat) };
    for (const h of [this.handModels.left, this.handModels.right]) h.setGlow(0x2a2e31);
    scene.add(this.handModels.left.root, this.handModels.right.root);

    this.scanner = new Scanner(this);
    this.locomotion = new Locomotion(this);
    this.wristMenu = new WristMenu(this);
    const sp = this.level.spawn;
    this.locomotion.placeAt(sp.position, sp.yaw);

    // Desktop preview: orbit around the spawn.
    const fwd = new Vector3(-Math.sin(sp.yaw), 0, -Math.cos(sp.yaw));
    this.desktopCamera.position.copy(sp.position).add(new Vector3(0, 1.7, 0)).addScaledVector(fwd, -0.5);
    this.orbit = new OrbitControls(this.desktopCamera, this.renderer.domElement);
    this.orbit.target.copy(sp.position).add(new Vector3(0, 1.4, 0)).addScaledVector(fwd, 3);
    this.orbit.enableDamping = true;
    this.orbit.update();

    bus.on('setting', (e) => {
      const key = e.data?.key;
      if (key === 'palette') writePalette(this.palette, settings.palette);
      if (key === 'minPx') this.dotUniforms.uMinPx.value = settings.minPx;
      if (key === 'occlusion') this.level.root.visible = settings.occlusion;
    });

    this.xr.onStart = (_s, info) => {
      this.floorOffset = info.referenceSpace === 'local' ? 1.6 : 0;
      this.needsSpawn = true;
      this.ambience.start();
    };
    this.xr.onEnd = () => {
      this.input.clear();
      this.locomotion.reset();
      this.handModels.left.root.visible = this.handModels.right.root.visible = false;
      this.scanner.model.visible = false;
      void this.save.save();
      this.resize();
    };
    const flush = () => void this.save.save();
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
    window.addEventListener('pagehide', flush);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    bus.emit('level-loaded', { level: this.level.name, triangles: this.level.triangles, restored: this.cloud.total });
  }

  resize(): void {
    if (this.inXR) {
      // IWER (the emulator) sizes the canvas from the window: keep it in sync.
      if (flags.emulate) {
        const c = this.renderer.domElement;
        if (window.innerWidth > 0 && (c.width !== window.innerWidth || c.height !== window.innerHeight)) {
          c.width = window.innerWidth;
          c.height = window.innerHeight;
        }
      }
      return;
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.desktopCamera.aspect = w / Math.max(h, 1);
    this.desktopCamera.updateProjectionMatrix();
  }

  start(): void {
    this.renderer.setAnimationLoop((t, frame) => this.frame(t, frame));
  }

  async enterVR(): Promise<void> {
    await audio.unlock();
    await this.xr.start();
  }

  private frame(_t: number, xrFrame?: XRFrame): void {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.time += dt;
    this.frameCount++;
    try {
      this.update(dt, xrFrame);
    } catch (err) {
      this.report(err);
    }
    const t1 = performance.now();
    this.gpu.begin();
    this.renderer.render(this.scene, this.camera);
    this.gpu.end();
    const t2 = performance.now();
    this.stats.tick(dt, this.renderer, t1 - now, t2 - t1);
  }

  private update(dt: number, xrFrame?: XRFrame): void {
    const inXR = this.inXR;
    if (inXR && xrFrame) {
      if (flags.emulate && this.renderer.domElement.width === 0) this.resize();
      const ref = this.renderer.xr.getReferenceSpace();
      if (ref) this.input.update(xrFrame, ref);
      const info = this.xr.info;
      const layer = xrFrame.session.renderState.baseLayer;
      if (info && layer && !info.framebuffer) info.framebuffer = { width: layer.framebufferWidth, height: layer.framebufferHeight };
    }
    this.updateRig();
    if (inXR && this.needsSpawn && this.input.head.valid) {
      this.needsSpawn = false;
      const sp = this.level.spawn;
      this.locomotion.placeAt(sp.position, sp.yaw);
    }

    // Moving things move first, so rays this frame hit them where they're drawn.
    this.level.update(dt);
    this.physics.step();

    if (inXR) {
      this.wristMenu.update(dt);
      if (this.locomotion.update(dt)) this.updateRig();
      this.scanner.update(dt, this.time, this.wristMenu.engaged);
      for (const h of this.input.hands) {
        const holding = h === this.scanner.hand;
        this.handModels[h.handedness].update(h, h.grip.matrix, 1, holding, dt, true);
      }
    } else {
      this.orbit.update();
    }

    this.cloud.flush();
    this.fading.flush();
    this.dotUniforms.uTime.value = this.time;

    if (this.time - this.lastSave > AUTOSAVE_SECONDS) {
      this.lastSave = this.time;
      if (this.save.unsaved > 0) void this.save.save();
    }
    audio.updateListener(this.camera);
    this.onFrame?.(dt);
  }

  private report(err: unknown): void {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    if (this.errors.includes(msg)) return;
    this.errors.push(msg);
    if (this.errors.length > 20) this.errors.shift();
    console.error('[lidar] frame error:', err);
  }

  /** Recompose world-space poses after the rig moved. */
  updateRig(): void {
    this.rig.updateMatrixWorld(true);
    this.rig.getWorldQuaternion(this.rigQuat);
    if (this.inXR) {
      this.renderer.xr.updateCamera(this.xrCamera);
      this.input.updateWorld(this.rig.matrixWorld, this.rigQuat, 1);
    }
  }

  /** Head position in world space (desktop: camera position). */
  headPosition(out: Vector3): Vector3 {
    if (this.inXR && this.input.head.valid) return out.copy(this.input.head.position);
    return this.camera.getWorldPosition(out);
  }

  /** Forget the whole scan, here and in the save. */
  async clearScan(): Promise<void> {
    this.cloud.clear();
    this.fading.clear();
    await this.save.erase();
    bus.emit('cloud-cleared');
  }
}
