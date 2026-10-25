import { CanvasTexture, LinearFilter, Matrix4, Mesh, MeshBasicMaterial, Plane, PlaneGeometry, Quaternion, Ray, RingGeometry, SRGBColorSpace, Vector3 } from 'three';
import { bus } from '../core/events';
import { damp } from '../core/math';
import { setSetting, settings, type Settings } from '../core/settings';
import { uiTick } from '../audio/sfx';
import { roundRect } from './text';
import type { App } from '../app';

const W = 640;
const H = 560;
const PANEL_W = 0.2;
const PANEL_H = (PANEL_W * H) / W;

export type Page = 'scan' | 'settings' | 'info';

interface Hit {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const _v = new Vector3();
const _n = new Vector3();
const _head = new Vector3();
const _m = new Matrix4();
const _inv = new Matrix4();
const _q = new Quaternion();
const _ray = new Ray();
const _plane = new Plane();

/**
 * Palm-up menu on the free hand (the one not holding the scanner). Point the scanner at it
 * and pull the trigger, or poke it with that hand's index finger. While you point at it
 * the scanner stays quiet.
 */
export class WristMenu {
  readonly mesh: Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly cursor: Mesh;
  page: Page = 'scan';
  private hits: Hit[] = [];
  private hover: string | null = null;
  private opacity = 0;
  visible = false;
  private dirty = true;
  private pokeInside = false;
  private lastLiveDraw = 0;
  private confirmClear = 0;
  /** The pointing hand is on the menu this frame (the scanner should ignore its trigger). */
  engaged = false;

  constructor(private readonly app: App) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.mesh = new Mesh(
      new PlaneGeometry(PANEL_W, PANEL_H),
      new MeshBasicMaterial({ map: this.texture, transparent: true, opacity: 0, toneMapped: false, depthWrite: false }),
    );
    this.mesh.name = 'wrist-menu';
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    this.cursor = new Mesh(new RingGeometry(0.0035, 0.0055, 20), new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, depthTest: false }));
    this.cursor.position.z = 0.001;
    this.cursor.renderOrder = 21;
    this.cursor.visible = false;
    this.mesh.add(this.cursor);
    app.scene.add(this.mesh);
    bus.on('setting', () => (this.dirty = true));
  }

  update(dt: number): void {
    const app = this.app;
    const pointer = app.scanner.hand;
    const holder = app.input.other(pointer);
    const model = app.handModels[holder.handedness];
    this.engaged = false;
    let want = false;
    if (holder.grip.valid && app.inXR) {
      const palm = _v;
      model.palm(palm, _n);
      app.headPosition(_head);
      const toHead = _head.clone().sub(palm);
      const dist = toHead.length();
      toHead.multiplyScalar(1 / dist);
      const facing = _n.dot(toHead);
      want = facing > (this.visible ? 0.35 : 0.6) && dist < 0.75;
      if (want) {
        const pos = palm.clone().addScaledVector(_n, 0.085).add(new Vector3(0, 0.03, 0));
        this.mesh.position.lerp(pos, this.visible ? damp(25, dt) : 1);
        // lookAt(eye, target) makes +Z point from target to eye: the panel's face turns to the head.
        _m.lookAt(_head, this.mesh.position, new Vector3(0, 1, 0));
        _q.setFromRotationMatrix(_m);
        this.mesh.quaternion.slerp(_q, this.visible ? damp(18, dt) : 1);
      }
    }
    if (want && !this.visible) {
      this.visible = true;
      this.dirty = true;
      bus.emit('menu', { open: true });
    } else if (!want && this.visible) {
      this.visible = false;
      this.pokeInside = false;
      bus.emit('menu', { open: false });
    }
    this.opacity += ((this.visible ? 1 : 0) - this.opacity) * damp(14, dt);
    (this.mesh.material as MeshBasicMaterial).opacity = this.opacity;
    this.mesh.visible = this.opacity > 0.02;
    if (!this.mesh.visible) return;

    let hoverId: string | null = null;
    this.cursor.visible = false;
    if (this.visible && pointer.grip.valid) {
      this.mesh.updateMatrixWorld(true);
      _inv.copy(this.mesh.matrixWorld).invert();
      // 1) Poke with the pointing hand's index fingertip.
      const tip = app.handModels[pointer.handedness].indexTip(new Vector3()).applyMatrix4(_inv);
      const inside = Math.abs(tip.x) < PANEL_W / 2 && Math.abs(tip.y) < PANEL_H / 2;
      if (inside && tip.z < 0.03 && tip.z > -0.04) {
        this.engaged = true;
        hoverId = this.hitAt(tip.x, tip.y);
        this.showCursor(tip.x, tip.y);
        if (!this.pokeInside && tip.z < 0.002) {
          this.pokeInside = true;
          if (hoverId) this.click(hoverId);
        }
      }
      if (this.pokeInside && (tip.z > 0.012 || !inside)) this.pokeInside = false;
      // 2) Point the scanner at it and pull the trigger.
      if (!hoverId && pointer.aim.valid) {
        _ray.set(pointer.aim.position, pointer.aim.forward(new Vector3()));
        _plane.setFromNormalAndCoplanarPoint(new Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion), this.mesh.position);
        const hit = _ray.intersectPlane(_plane, new Vector3());
        if (hit && hit.distanceTo(pointer.aim.position) < 1.2) {
          const l = hit.applyMatrix4(_inv);
          if (Math.abs(l.x) < PANEL_W / 2 && Math.abs(l.y) < PANEL_H / 2) {
            this.engaged = true;
            hoverId = this.hitAt(l.x, l.y);
            this.showCursor(l.x, l.y);
            if (pointer.trigger.down && hoverId) this.click(hoverId);
          }
        }
      }
    }
    if (hoverId !== this.hover) {
      this.hover = hoverId;
      this.dirty = true;
      if (hoverId) pointer.pulse(0.08, 8);
    }
    const now = performance.now();
    if (this.page !== 'settings' && now - this.lastLiveDraw > 500) this.dirty = true;
    if (this.confirmClear && now > this.confirmClear) {
      this.confirmClear = 0;
      this.dirty = true;
    }
    if (this.dirty) this.draw();
  }

  private showCursor(x: number, y: number): void {
    this.cursor.position.set(x, y, 0.001);
    this.cursor.visible = true;
  }

  private hitAt(x: number, y: number): string | null {
    const cx = (x / PANEL_W + 0.5) * W;
    const cy = (0.5 - y / PANEL_H) * H;
    for (const h of this.hits) if (cx >= h.x && cx <= h.x + h.w && cy >= h.y && cy <= h.y + h.h) return h.id;
    return null;
  }

  /** Press a control by id, as a poke or trigger pull would (also used by tests). */
  click(id: string): void {
    const app = this.app;
    app.scanner.hand.pulse(0.45, 22);
    uiTick(this.mesh.position, 1.2);
    const [kind, value] = id.split(':');
    switch (kind) {
      case 'page':
        this.page = value as Page;
        break;
      case 'turn':
        setSetting('turn', value as Settings['turn']);
        break;
      case 'vignette':
        setSetting('vignette', value === 'on');
        break;
      case 'hand':
        setSetting('scannerHand', value as Settings['scannerHand']);
        break;
      case 'palette':
        setSetting('palette', value as Settings['palette']);
        break;
      case 'occlusion':
        setSetting('occlusion', value === 'on');
        break;
      case 'minpx':
        setSetting('minPx', +value);
        break;
      case 'rate':
        setSetting('scanRate', +value);
        break;
      case 'action':
        if (value === 'recenter') app.locomotion.recenter();
        if (value === 'save') void app.save.save();
        if (value === 'clear') {
          if (this.confirmClear) {
            this.confirmClear = 0;
            void app.clearScan();
          } else this.confirmClear = performance.now() + 3000;
        }
        break;
    }
    this.dirty = true;
  }

  private draw(): void {
    this.dirty = false;
    const c = this.ctx;
    this.hits = [];
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(10,11,13,0.92)';
    roundRect(c, 0, 0, W, H, 30);
    c.fill();
    c.strokeStyle = 'rgba(210,215,220,0.25)';
    c.lineWidth = 3;
    roundRect(c, 1.5, 1.5, W - 3, H - 3, 29);
    c.stroke();
    c.textBaseline = 'middle';
    this.button('page:scan', 'Scan', 30, 22, 180, 50, this.page === 'scan');
    this.button('page:settings', 'Settings', 230, 22, 180, 50, this.page === 'settings');
    this.button('page:info', 'Info', 430, 22, 180, 50, this.page === 'info');
    if (this.page === 'scan') this.drawScan();
    else if (this.page === 'settings') this.drawSettings();
    else this.drawInfo();
    this.texture.needsUpdate = true;
  }

  private text(lines: string[], y0: number, size = 26): void {
    const c = this.ctx;
    c.textAlign = 'left';
    c.fillStyle = '#d9dcdf';
    c.font = `500 ${size}px ui-monospace, Consolas, monospace`;
    lines.forEach((t, i) => c.fillText(t, 30, y0 + i * (size + 16), W - 60));
  }

  private drawScan(): void {
    this.lastLiveDraw = performance.now();
    const a = this.app;
    const cloud = a.cloud;
    const save = a.save;
    const mb = (cloud.bytes / 1048576).toFixed(0);
    const saveLine =
      save.state === 'error' ? 'save: error (see console)' : save.state === 'saving' ? 'save: writing…' : save.unsaved ? `save: ${save.unsaved.toLocaleString()} new dots pending` : 'save: up to date';
    this.text(
      [
        `${cloud.total.toLocaleString()} dots${cloud.full ? ' (full)' : ''}`,
        `of ${(cloud.maxDots / 1e6).toFixed(1)} M · ${mb} MB · ${cloud.chunks.size} chunks`,
        saveLine,
        `level ${a.level.name} · slot ${save.slot}`,
      ],
      120,
    );
    const y = 330;
    this.button('action:save', 'Save now', 30, y, 186, 60, false, true);
    this.button('action:recenter', 'Back to start', 227, y, 186, 60, false, true);
    this.button('action:clear', this.confirmClear ? 'Sure? Clear' : 'Clear scan', 424, y, 186, 60, !!this.confirmClear, true);
  }

  private drawSettings(): void {
    const rows: [string, [string, string, boolean][]][] = [
      ['Turning', [['turn:snap45', 'Snap 45°', settings.turn === 'snap45'], ['turn:snap30', 'Snap 30°', settings.turn === 'snap30'], ['turn:smooth', 'Smooth', settings.turn === 'smooth']]],
      ['Vignette', [['vignette:on', 'On', settings.vignette], ['vignette:off', 'Off', !settings.vignette]]],
      ['Scanner', [['hand:left', 'Left hand', settings.scannerHand === 'left'], ['hand:right', 'Right hand', settings.scannerHand === 'right']]],
      ['Palette', [['palette:ash', 'Ash', settings.palette === 'ash'], ['palette:tinted', 'Tinted', settings.palette === 'tinted'], ['palette:mono', 'Mono', settings.palette === 'mono']]],
      ['Occlusion', [['occlusion:on', 'On', settings.occlusion], ['occlusion:off', 'X-ray', !settings.occlusion]]],
      ['Min dot', [['minpx:1.5', '1.5 px', settings.minPx === 1.5], ['minpx:2.5', '2.5 px', settings.minPx === 2.5], ['minpx:3.5', '3.5 px', settings.minPx === 3.5]]],
      ['Scan rate', [['rate:5000', '5k/s', settings.scanRate === 5000], ['rate:10000', '10k/s', settings.scanRate === 10000], ['rate:20000', '20k/s', settings.scanRate === 20000]]],
    ];
    const c = this.ctx;
    let y = 100;
    for (const [label, opts] of rows) {
      c.fillStyle = '#d9dcdf';
      c.font = '600 27px system-ui, sans-serif';
      c.textAlign = 'left';
      c.fillText(label, 30, y + 22);
      const total = 420;
      const w = total / opts.length - 8;
      opts.forEach(([id, text, on], i) => this.button(id, text, 196 + i * (w + 8), y, w, 44, on));
      y += 54;
    }
  }

  private drawInfo(): void {
    this.lastLiveDraw = performance.now();
    const a = this.app;
    const s = a.stats;
    const info = a.xr.info;
    const sc = a.scanner;
    const gpu = a.gpu.ms;
    this.text(
      [
        `${s.fps.toFixed(0)} fps · frame ${s.frameMs.toFixed(1)} ms`,
        `gpu ${gpu === null ? 'n/a' : gpu.toFixed(2) + ' ms'} · cpu ${s.updateMs.toFixed(1)} + ${s.renderMs.toFixed(1)} ms`,
        `${s.calls} draws · ${(s.points / 1e6).toFixed(2)} M dots drawn`,
        `rays ${(sc.rate / 1000).toFixed(0)}k/s (cap ${sc.budget}/frame) · ${sc.usPerRay.toFixed(1)} µs/ray`,
        `eye ${info?.framebuffer ? `${info.framebuffer.width}×${info.framebuffer.height}` : '?'} · ${info?.supportedFrameRates?.join('/') ?? 'n/a'} Hz`,
        `L ${a.input.left.profiles[0] ?? '—'}`,
        `R ${a.input.right.profiles[0] ?? '—'}`,
      ],
      110,
      24,
    );
  }

  private button(id: string, text: string, x: number, y: number, w: number, h: number, on: boolean, action = false): void {
    const c = this.ctx;
    const hover = this.hover === id;
    c.fillStyle = on ? '#d9dcdf' : hover ? 'rgba(255,255,255,0.22)' : action ? 'rgba(200,210,220,0.14)' : 'rgba(255,255,255,0.08)';
    roundRect(c, x, y, w, h, 12);
    c.fill();
    if (hover && !on) {
      c.strokeStyle = 'rgba(230,235,240,0.85)';
      c.lineWidth = 3;
      roundRect(c, x + 1.5, y + 1.5, w - 3, h - 3, 11);
      c.stroke();
    }
    c.fillStyle = on ? '#121315' : '#e8eaec';
    c.font = `${on ? 700 : 600} 25px system-ui, sans-serif`;
    c.textAlign = 'center';
    c.fillText(text, x + w / 2, y + h / 2 + 1);
    this.hits.push({ id, x, y, w, h });
  }
}
