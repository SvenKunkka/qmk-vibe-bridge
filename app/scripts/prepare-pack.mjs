// Copy node-hid (with its prebuilt NAPI binary) into app/node_modules so
// electron-builder can pack it without workspace symlink issues.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = path.join(root, 'app');
const dest = path.join(app, 'node_modules', 'node-hid');
rmSync(dest, { recursive: true, force: true });
mkdirSync(path.dirname(dest), { recursive: true });
cpSync(path.join(root, 'node_modules', 'node-hid'), dest, { recursive: true });
// drop dev/build leftovers that are not needed at runtime
for (const p of ['binding.gyp', 'src', 'node_modules']) {
  rmSync(path.join(dest, p), { recursive: true, force: true });
}
console.log('prepared app/node_modules/node-hid');
