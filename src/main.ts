import { flags } from './config';
import { App } from './app';
import type { Emu } from './dev/emulator';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function boot(): Promise<void> {
  let emu: Emu | null = null;
  if (flags.emulate) {
    // Must run before anything checks navigator.xr.
    const { installHiddenFrameClock } = await import('./dev/frame-clock');
    installHiddenFrameClock();
    const { installEmulator } = await import('./dev/emulator');
    emu = await installEmulator({ devui: flags.devui, stereo: flags.stereo });
  }

  const app = new App($('view') as unknown as HTMLCanvasElement);
  await app.init();
  app.start();
  $('loading').remove();

  const overlay = $('overlay');
  const button = $<HTMLButtonElement>('enter');
  const status = $('status');
  overlay.hidden = false;

  const setStatus = (text: string, kind: '' | 'warn' | 'err' = '') => {
    status.textContent = text;
    status.className = kind;
  };
  const restored = app.cloud.total > 0 ? ` Your scan is back: ${app.cloud.total.toLocaleString()} dots.` : '';

  const support = await app.xr.support();
  switch (support) {
    case 'supported':
      button.disabled = false;
      button.textContent = 'Enter VR';
      setStatus((emu ? 'Emulated headset (IWER). Add &devui to drive it with mouse and keyboard.' : 'Ready. Put on your headset after pressing the button.') + restored);
      break;
    case 'insecure':
      button.textContent = 'VR needs HTTPS';
      setStatus('WebXR only runs on https:// or http://localhost. Use `npm run dev:lan` for an HTTPS URL on your network.', 'err');
      break;
    case 'no-webxr':
      button.textContent = 'No WebXR in this browser';
      setStatus('Open this page in Chrome or Edge on a PC with SteamVR, or add ?emulate to the URL.', 'warn');
      break;
    case 'no-immersive-vr':
      button.textContent = 'No VR headset found';
      setStatus('WebXR is here but no headset answered. Start SteamVR (and connect the Frame), then reload.', 'warn');
      break;
  }

  button.addEventListener('click', async () => {
    if (app.xr.session) {
      await app.xr.end();
      return;
    }
    button.disabled = true;
    try {
      await app.enterVR();
    } catch (err) {
      setStatus(`Could not start VR: ${(err as Error).message}`, 'err');
    } finally {
      button.disabled = false;
    }
  });

  app.xr.onStart = ((prev) => (s, info) => {
    prev?.(s, info);
    button.textContent = 'Exit VR';
    overlay.style.opacity = '0.4';
  })(app.xr.onStart);
  app.xr.onEnd = ((prev) => () => {
    prev?.();
    button.textContent = 'Enter VR';
    overlay.style.opacity = '';
  })(app.xr.onEnd);

  (window as unknown as { __app: App }).__app = app;
  if (emu) (window as unknown as { __emu: Emu }).__emu = emu;
  const { installProbe } = await import('./dev/probe');
  installProbe(app, emu);

  if (emu && (flags.autostart || flags.selftest)) {
    await app.enterVR();
    if (flags.selftest) {
      const { runSelfTest } = await import('./dev/selftest');
      await runSelfTest(app, emu, flags.selftestOnly);
    }
  }
  if (emu && !flags.selftest) {
    const { createDriver } = await import('./dev/driver');
    (window as unknown as { __driver: unknown }).__driver = createDriver(app, emu);
  }
}

boot().catch((err) => {
  console.error(err);
  const l = document.getElementById('loading');
  if (l) l.textContent = `Failed to start: ${(err as Error).message}`;
});
