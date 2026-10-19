import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * Dev-only: POST /__snapshot?name=foo with a PNG body saves .snapshots/foo.png.
 * The page's `__vr.snapshot()` renders the player's view offscreen and posts it,
 * so an agent can look at the scene even when the browser pane is hidden.
 */
function snapshotSink(): Plugin {
  const dir = fileURLToPath(new URL('./.snapshots', import.meta.url));
  return {
    name: 'snapshot-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__snapshot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const url = new URL(req.url ?? '', 'http://x');
        const name = (url.searchParams.get('name') ?? 'snapshot').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${name}.png`);
          writeFileSync(file, Buffer.concat(chunks));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ file }));
        });
      });
    },
  };
}

// `--mode lan` serves over HTTPS on every interface so a headset browser on the
// LAN gets a secure context (WebXR refuses to run on plain http:// unless the
// host is localhost). The certificate is self-signed: accept it once per device.
export default defineConfig(({ mode }) => ({
  plugins: [snapshotSink(), ...(mode === 'lan' ? [basicSsl({ name: 'lidar-game' })] : [])],
  server: { port: 5180 },
  preview: { port: 4180 },
  build: {
    target: 'es2022',
    // Rapier's compat build inlines its wasm as base64, so the main chunk is
    // ~5 MB (1.9 MB gzipped) by design. Keep the warning for anything bigger.
    chunkSizeWarningLimit: 5600,
  },
}));
