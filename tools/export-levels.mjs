// Export every levels/*.blend to public/levels/*.glb with Blender in the background.
// `npm run levels` (all) or `npm run levels -- hall` (some). Set BLENDER to pick a build.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const blender = process.env.BLENDER ?? 'C:/Software/blender/blender-5.2.1-windows-x64/blender.exe';
if (!existsSync(blender)) {
  console.error(`Blender not found at ${blender}. Set BLENDER=<path to blender.exe>.`);
  process.exit(1);
}
const only = process.argv.slice(2);
const levels = readdirSync(join(root, 'levels'))
  .filter((f) => f.endsWith('.blend'))
  .map((f) => basename(f, '.blend'))
  .filter((n) => only.length === 0 || only.includes(n));
if (levels.length === 0) {
  console.error('No levels to export.');
  process.exit(1);
}
for (const name of levels) {
  const out = join(root, 'public', 'levels', `${name}.glb`);
  execFileSync(blender, ['-b', join(root, 'levels', `${name}.blend`), '--python', join(root, 'tools', 'blender', 'export_glb.py'), '--', out], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}
