import { NoToneMapping, SRGBColorSpace, WebGLRenderer } from 'three';
import type { Quality } from '../config';

export function createRenderer(canvas: HTMLCanvasElement, quality: Quality): WebGLRenderer {
  const renderer = new WebGLRenderer({
    canvas,
    // MSAA stays on: the dots' soft edges use alpha-to-coverage, which needs it.
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    // The XR compositor reads the framebuffer directly; no need to preserve it.
    preserveDrawingBuffer: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'high' ? 2 : 1.25));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = SRGBColorSpace;
  // No tone mapping anywhere: a dot's brightness must be exactly what the palette says,
  // so the brightness floor that keeps dim dots alive through the video stream holds.
  renderer.toneMapping = NoToneMapping;
  renderer.setClearColor(0x000000, 1);
  renderer.shadowMap.enabled = false;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.xr.setFramebufferScaleFactor(quality === 'high' ? 1.0 : 0.85);
  // Fixed foveation blurs the periphery of the eye buffer, which dots don't survive well.
  renderer.xr.setFoveation(0);
  return renderer;
}
