import { DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three';
import type { PaletteName } from '../core/settings';

/**
 * Surface materials, keyed by the Blender material's name. A dot stores only its
 * material's index (one byte); the shader looks the colour up in a small texture,
 * so palettes switch live without touching a single dot.
 *
 * The world is meant to feel colourless: materials differ mostly in brightness, with
 * the faintest tints. Brightness is also what survives the headset's video stream
 * (its 4:2:0 chroma is a quarter resolution), so the information lives there anyway.
 */

export interface MaterialDef {
  name: string;
  /** Dots on it fade after a few seconds (moving things). */
  entity: boolean;
  /** Display (sRGB) colour per palette at full brightness; distance shading dims it. */
  colors: Record<PaletteName, [number, number, number]>;
}

const grey = (v: number): [number, number, number] => [v, v, v];

export const MATERIALS: MaterialDef[] = [
  // Index 0 is the fallback for names the game doesn't know.
  { name: 'default', entity: false, colors: { ash: grey(0.8), tinted: grey(0.8), mono: grey(0.85) } },
  { name: 'concrete', entity: false, colors: { ash: [0.78, 0.8, 0.82], tinted: [0.7, 0.74, 0.8], mono: grey(0.85) } },
  { name: 'plaster', entity: false, colors: { ash: [0.86, 0.84, 0.8], tinted: [0.92, 0.86, 0.74], mono: grey(0.85) } },
  { name: 'tile', entity: false, colors: { ash: [0.95, 0.95, 0.95], tinted: [0.85, 0.92, 0.95], mono: grey(0.85) } },
  { name: 'metal', entity: false, colors: { ash: [0.66, 0.72, 0.8], tinted: [0.45, 0.65, 1.0], mono: grey(0.85) } },
  { name: 'wood', entity: false, colors: { ash: [0.72, 0.64, 0.55], tinted: [0.95, 0.6, 0.3], mono: grey(0.85) } },
  { name: 'stone', entity: false, colors: { ash: [0.62, 0.62, 0.6], tinted: [0.65, 0.62, 0.52], mono: grey(0.85) } },
  { name: 'entity', entity: true, colors: { ash: [1.0, 0.82, 0.68], tinted: [1.0, 0.4, 0.3], mono: grey(1.0) } },
];

const byName = new Map(MATERIALS.map((m, i) => [m.name, i]));

/**
 * Index for a Blender/glTF material name. Blender's duplicate suffixes (".001") are
 * ignored, and any name starting with "entity" counts as an entity material.
 */
export function materialIndex(gltfName: string | undefined): number {
  const base = (gltfName ?? '').toLowerCase().replace(/\.\d+$/, '').trim();
  const known = byName.get(base);
  if (known !== undefined) return known;
  if (base.startsWith('entity')) return byName.get('entity')!;
  if (base) console.warn(`[level] unknown material "${gltfName}": drawn as default`);
  return 0;
}

export const isEntityMaterial = (index: number): boolean => MATERIALS[index]?.entity ?? false;

/** 256×1 RGBA float texture: rgb = display colour of material i. */
export function createPaletteTexture(): DataTexture {
  const data = new Float32Array(256 * 4);
  const tex = new DataTexture(data, 256, 1, RGBAFormat, FloatType);
  tex.magFilter = tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

export function writePalette(tex: DataTexture, palette: PaletteName): void {
  const data = tex.image.data as Float32Array;
  for (let i = 0; i < 256; i++) {
    const c = (MATERIALS[i] ?? MATERIALS[0]).colors[palette];
    data[i * 4] = c[0];
    data[i * 4 + 1] = c[1];
    data[i * 4 + 2] = c[2];
    data[i * 4 + 3] = 1;
  }
  tex.needsUpdate = true;
}
