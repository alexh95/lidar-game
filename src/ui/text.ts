import { CanvasTexture, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three';

export interface LabelOptions {
  /** Width of the plane in metres; height follows the canvas aspect. */
  width: number;
  px?: number; // canvas width in pixels
  aspect?: number; // height / width
  font?: string;
  color?: string;
  background?: string | null;
  align?: CanvasTextAlign;
  padding?: number;
  lineHeight?: number;
  radius?: number;
}

/** A flat text panel rendered through a 2D canvas. Cheap, crisp enough for VR at arm's length. */
export function makeLabel(lines: string | string[], o: LabelOptions): Mesh {
  const px = o.px ?? 512;
  const aspect = o.aspect ?? 0.25;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = Math.round(px * aspect);
  drawLabel(canvas, Array.isArray(lines) ? lines : [lines], o);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = 4;
  const mat = new MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, depthWrite: false });
  const mesh = new Mesh(new PlaneGeometry(o.width, o.width * aspect), mat);
  mesh.renderOrder = 5;
  mesh.userData.canvas = canvas;
  return mesh;
}

export function drawLabel(canvas: HTMLCanvasElement, lines: string[], o: LabelOptions): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (o.background) {
    ctx.fillStyle = o.background;
    roundRect(ctx, 0, 0, w, h, o.radius ?? Math.min(w, h) * 0.12);
    ctx.fill();
  }
  ctx.fillStyle = o.color ?? '#fff';
  ctx.textAlign = o.align ?? 'center';
  ctx.textBaseline = 'middle';
  ctx.font = o.font ?? `600 ${Math.round(h * 0.42)}px system-ui, sans-serif`;
  const pad = o.padding ?? w * 0.05;
  const lh = o.lineHeight ?? h / Math.max(lines.length, 1);
  const x = ctx.textAlign === 'left' ? pad : ctx.textAlign === 'right' ? w - pad : w / 2;
  const top = (h - lh * lines.length) / 2 + lh / 2;
  lines.forEach((line, i) => ctx.fillText(line, x, top + i * lh, w - pad * 2));
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
