import { PerspectiveCamera, SRGBColorSpace, Vector3, WebGLRenderTarget, type Camera } from 'three';
import type { App } from '../app';

export interface SnapshotOptions {
  width?: number;
  height?: number;
  fov?: number;
  /** Use this camera instead of the player's eyes. */
  camera?: Camera;
  /** Or place a camera here, looking at `to` (world coordinates). */
  from?: [number, number, number];
  to?: [number, number, number];
  /** Supersampling factor (1 shows dots at their true pixel size; default 1). */
  ss?: number;
  /** 4× MSAA like the headset's layer, so alpha-to-coverage softens dot edges (default true). */
  msaa?: boolean;
  /** Hide the hands, scanner and menu: measure the dots alone. */
  dotsOnly?: boolean;
}

/**
 * Render the player's view (or a given camera) offscreen and POST it to the dev server,
 * which writes .snapshots/<name>.png. Works with the page hidden.
 */
function snapshotCamera(app: App, o: SnapshotOptions, width: number, height: number): Camera {
  let cam = o.camera;
  if (!cam) {
    const pc = new PerspectiveCamera(o.fov ?? 90, width / height, app.xrCamera.near, app.xrCamera.far);
    if (o.from) {
      pc.position.set(...o.from);
      pc.lookAt(new Vector3(...(o.to ?? [0, 1, 0])));
    } else if (app.inXR && app.input.head.valid) {
      app.input.head.matrix.decompose(pc.position, pc.quaternion, pc.scale);
      pc.scale.set(1, 1, 1);
    } else {
      app.camera.getWorldPosition(pc.position);
      app.camera.getWorldQuaternion(pc.quaternion);
    }
    pc.updateMatrixWorld(true);
    cam = pc;
  }
  return cam;
}

/** Render offscreen (sRGB, as the headset shows it) and read the pixels back, bottom row first. */
export function renderPixels(app: App, cam: Camera, W: number, H: number, msaa = true): Uint8Array {
  const rt = new WebGLRenderTarget(W, H, { samples: msaa ? 4 : 0 });
  rt.texture.colorSpace = SRGBColorSpace;
  (rt as WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  // For an XR-flagged target the shaders encode sRGB themselves, as for the headset's RGBA8
  // layer. Plain RGBA8 storage keeps the hardware from encoding a second time.
  rt.texture.internalFormat = 'RGBA8';
  const r = app.renderer;
  const xrEnabled = r.xr.enabled;
  const prevTarget = r.getRenderTarget();
  r.xr.enabled = false;
  r.setRenderTarget(rt);
  r.clear();
  r.render(app.scene, cam);
  r.setRenderTarget(prevTarget);
  r.xr.enabled = xrEnabled;
  const px = new Uint8Array(W * H * 4);
  r.readRenderTargetPixels(rt, 0, 0, W, H, px);
  rt.dispose();
  return px;
}

/** Average display brightness (0..1, Rec. 709 luma) of a view, and the share of lit pixels. */
export function measureView(app: App, o: SnapshotOptions = {}): { luma: number; lit: number } {
  const W = o.width ?? 320;
  const H = o.height ?? 180;
  const cam = snapshotCamera(app, o, W, H);
  if (cam instanceof PerspectiveCamera) {
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
  }
  const hidden = o.dotsOnly ? [app.handModels.left.root, app.handModels.right.root, app.scanner.model, app.wristMenu.mesh].filter((x) => x.visible) : [];
  for (const x of hidden) x.visible = false;
  const px = renderPixels(app, cam, W, H, o.msaa ?? true);
  for (const x of hidden) x.visible = true;
  let sum = 0;
  let lit = 0;
  for (let i = 0; i < px.length; i += 4) {
    const y = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    sum += y;
    if (y > 8) lit++;
  }
  return { luma: sum / (W * H * 255), lit: lit / (W * H) };
}

export async function snapshot(app: App, name: string, o: SnapshotOptions = {}): Promise<string> {
  const width = o.width ?? 1280;
  const height = o.height ?? 720;
  const cam = snapshotCamera(app, o, width, height);
  const ss = o.ss ?? 1;
  const W = width * ss;
  const H = height * ss;
  if (cam instanceof PerspectiveCamera) {
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
  }
  const px = renderPixels(app, cam, W, H, o.msaa ?? true);
  const big = document.createElement('canvas');
  big.width = W;
  big.height = H;
  const bctx = big.getContext('2d')!;
  const img = bctx.createImageData(W, H);
  // Flip rows: GL origin is bottom-left.
  for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  bctx.putImageData(img, 0, 0);
  let canvas = big;
  if (ss !== 1) {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(big, 0, 0, width, height);
  }
  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
  const resp = await fetch(`/__snapshot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
  const json = (await resp.json()) as { file: string };
  return json.file;
}
