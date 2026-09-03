/**
 * esbuild bundling for the Electron app.
 *   main     -> dist/main/index.js    (CJS, electron + node-hid external)
 *   preload  -> dist/preload/preload.js
 *   renderer -> dist/renderer/app.js  (+ copies index.html / styles.css)
 */

import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'main'), { recursive: true });
fs.mkdirSync(path.join(dist, 'preload'), { recursive: true });
fs.mkdirSync(path.join(dist, 'renderer'), { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
  tsconfig: path.join(root, 'tsconfig.json'),
};

await build({
  ...common,
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: path.join(dist, 'main/index.js'),
  external: ['electron', 'node-hid'],
  format: 'cjs',
});

await build({
  ...common,
  entryPoints: [path.join(root, 'src/preload/preload.ts')],
  outfile: path.join(dist, 'preload/preload.js'),
  external: ['electron'],
  format: 'cjs',
});

await build({
  ...common,
  entryPoints: [path.join(root, 'src/renderer/app.ts')],
  outfile: path.join(dist, 'renderer/app.js'),
  platform: 'browser',
  format: 'iife',
});

fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(dist, 'renderer/index.html'));
fs.copyFileSync(path.join(root, 'src/renderer/styles.css'), path.join(dist, 'renderer/styles.css'));
console.log('app bundle written to', dist);
