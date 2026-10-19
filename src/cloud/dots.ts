import { type DataTexture, type Material, type Points, ShaderMaterial, Vector4, type WebGLRenderer } from 'three';

/**
 * The dot shader, shared by the persistent cloud and the fading entity dots.
 *
 * A dot stores its world position, its birth time and a material index. Everything else
 * is decided here, every frame:
 * - colour: the material's palette entry, dimmed by the dot's *current* distance to the
 *   eye (a log falloff from uNear to uFar), never below uFloor. Move and the shading moves
 *   with you, so brightness reads as depth.
 * - size: a fixed world diameter, so near dots are big and far dots small, but never under
 *   uMinPx eye-buffer pixels (the headset's video stream erases anything smaller).
 * - a new dot grows in over uGrow seconds instead of popping (popping costs the video
 *   encoder bits; growth is smooth).
 * - entity dots (uLife > 0) dim and shrink, then vanish uLife seconds after they appeared.
 * Edges are soft through alpha-to-coverage (MSAA), so the dots stay opaque: no blending,
 * no sorting.
 */

const vertexShader = /* glsl */ `
attribute vec4 aPoint;
attribute float aMat;
uniform sampler2D uPalette;
uniform float uTime;
uniform float uViewportH;
uniform float uDotSize;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uGrow;
uniform float uNear;
uniform float uFar;
uniform float uFloor;
uniform float uLife;
varying vec3 vColor;
varying float vPx;

void main() {
  float age = uTime - aPoint.w;
  float fade = 1.0;
  if (uLife > 0.0) {
    if (age > uLife || age < -0.05) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vColor = vec3(0.0);
      vPx = 0.0;
      return;
    }
    fade = 1.0 - smoothstep(0.2 * uLife, uLife, age);
  }
  vec4 mv = modelViewMatrix * vec4(aPoint.xyz, 1.0);
  float d = max(length(mv.xyz), 1e-3);
  // Nudge toward the eye so a dot wins the depth test against the surface it lies on.
  mv.xyz *= max(0.0, 1.0 - (0.006 + 0.004 * d) / d);
  gl_Position = projectionMatrix * mv;

  float pxPerUnit = projectionMatrix[1][1] * uViewportH * 0.5;
  float px = clamp(uDotSize * pxPerUnit / d, uMinPx, uMaxPx);
  px *= smoothstep(0.0, 1.0, age / uGrow) * mix(0.6, 1.0, fade);
  gl_PointSize = px;
  vPx = px;

  float k = clamp(log2(max(d, uNear) / uNear) / log2(uFar / uNear), 0.0, 1.0);
  float b = mix(1.0, uFloor, k) * fade;
  vec3 display = texture2D(uPalette, vec2((aMat + 0.5) / 256.0, 0.5)).rgb * b;
  // The palette and the floor are in display (sRGB) terms; three encodes back on output.
  vColor = pow(display, vec3(2.2));
}`;

const fragmentShader = /* glsl */ `
varying vec3 vColor;
varying float vPx;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = length(q);
  // About a pixel of soft edge, turned into MSAA coverage by alpha-to-coverage.
  float edge = clamp(1.6 / max(vPx, 1.0), 0.05, 0.7);
  float a = 1.0 - smoothstep(1.0 - edge, 1.0, r);
  if (a <= 0.02) discard;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}`;

export interface DotUniforms {
  uPalette: { value: DataTexture };
  uTime: { value: number };
  uViewportH: { value: number };
  /** World diameter of a dot (m). */
  uDotSize: { value: number };
  uMinPx: { value: number };
  uMaxPx: { value: number };
  uGrow: { value: number };
  /** Distance shading: full brightness inside uNear, the floor beyond uFar (m). */
  uNear: { value: number };
  uFar: { value: number };
  /** Dimmest a dot gets from distance (display brightness, 0..1). */
  uFloor: { value: number };
}

export function createDotUniforms(palette: DataTexture): DotUniforms {
  return {
    uPalette: { value: palette },
    uTime: { value: 0 },
    uViewportH: { value: 1000 },
    uDotSize: { value: 0.011 },
    uMinPx: { value: 2.5 },
    uMaxPx: { value: 12 },
    uGrow: { value: 0.16 },
    uNear: { value: 1.2 },
    uFar: { value: 30 },
    uFloor: { value: 0.3 },
  };
}

export function createDotMaterial(shared: DotUniforms, life = 0): ShaderMaterial {
  const m = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { ...shared, uLife: { value: life } },
    depthTest: true,
    depthWrite: true,
    transparent: false,
  });
  m.alphaToCoverage = true;
  m.name = life > 0 ? 'dots-fading' : 'dots';
  return m;
}

const _vp = new Vector4();

/**
 * Per-draw hook: the point size needs the current eye's viewport height (each eye, and an
 * offscreen snapshot, may differ), and shared uniforms must be re-sent for this draw.
 */
export function attachViewportHook(points: Points, shared: DotUniforms): void {
  points.onBeforeRender = (renderer: WebGLRenderer, _scene, _camera, _geometry, material: Material) => {
    renderer.getCurrentViewport(_vp);
    shared.uViewportH.value = _vp.w > 0 ? _vp.w : renderer.domElement.height;
    (material as ShaderMaterial).uniformsNeedUpdate = true;
  };
}
