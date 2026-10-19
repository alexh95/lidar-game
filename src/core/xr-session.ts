import type { WebGLRenderer } from 'three';
import { bus } from './events';

export type XRSupport = 'supported' | 'no-immersive-vr' | 'no-webxr' | 'insecure';

export interface SessionInfo {
  referenceSpace: 'local-floor' | 'local';
  boundedSpace: XRBoundedReferenceSpace | null;
  handTracking: boolean;
  enabledFeatures: readonly string[] | null;
  supportedFrameRates: readonly number[] | null;
  frameRate: number | null;
  framebuffer: { width: number; height: number } | null;
  environmentBlendMode: string | null;
  startedAt: number;
}

/**
 * Starts and ends the immersive session, negotiating optional features so the
 * app runs on anything from a full PC VR runtime to a bare-bones one.
 */
export class XRSessionManager {
  session: XRSession | null = null;
  info: SessionInfo | null = null;
  onStart: ((s: XRSession, info: SessionInfo) => void) | null = null;
  onEnd: (() => void) | null = null;

  constructor(private readonly renderer: WebGLRenderer) {}

  async support(): Promise<XRSupport> {
    if (!window.isSecureContext) return 'insecure';
    if (!navigator.xr) return 'no-webxr';
    try {
      return (await navigator.xr.isSessionSupported('immersive-vr')) ? 'supported' : 'no-immersive-vr';
    } catch {
      return 'no-immersive-vr';
    }
  }

  async start(): Promise<void> {
    if (this.session || !navigator.xr) return;
    const init: XRSessionInit = {
      requiredFeatures: [],
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    };
    const session = await navigator.xr.requestSession('immersive-vr', init);

    // Prefer floor-relative tracking; fall back to 'local' (we then assume a standing height).
    let referenceSpace: 'local-floor' | 'local' = 'local-floor';
    try {
      await session.requestReferenceSpace('local-floor');
    } catch {
      referenceSpace = 'local';
    }
    this.renderer.xr.setReferenceSpaceType(referenceSpace);

    let boundedSpace: XRBoundedReferenceSpace | null = null;
    try {
      boundedSpace = (await session.requestReferenceSpace('bounded-floor')) as XRBoundedReferenceSpace;
      if (!boundedSpace.boundsGeometry || boundedSpace.boundsGeometry.length < 3) boundedSpace = null;
    } catch {
      boundedSpace = null;
    }

    await this.renderer.xr.setSession(session);
    this.session = session;

    const s = session as XRSession & { enabledFeatures?: readonly string[]; supportedFrameRates?: Float32Array; frameRate?: number };
    const layer = session.renderState.baseLayer;
    this.info = {
      referenceSpace,
      boundedSpace,
      handTracking: s.enabledFeatures ? s.enabledFeatures.includes('hand-tracking') : false,
      enabledFeatures: s.enabledFeatures ?? null,
      supportedFrameRates: s.supportedFrameRates ? Array.from(s.supportedFrameRates) : null,
      frameRate: s.frameRate ?? null,
      framebuffer: layer ? { width: layer.framebufferWidth, height: layer.framebufferHeight } : null,
      environmentBlendMode: session.environmentBlendMode ?? null,
      startedAt: performance.now(),
    };

    session.addEventListener('end', () => {
      this.session = null;
      this.onEnd?.();
      bus.emit('session-end');
    });
    this.onStart?.(session, this.info);
    bus.emit('session-start', { referenceSpace, bounded: !!boundedSpace, handTracking: this.info.handTracking });
  }

  async end(): Promise<void> {
    await this.session?.end();
  }
}
