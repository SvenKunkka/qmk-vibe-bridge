#!/usr/bin/env node
/**
 * Create a LOCAL-ONLY DMG from the ad-hoc signed app bundle.
 * No certificate => no notarization; the DMG is for local development only.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
const arch = process.argv[2] ?? 'mac-arm64';
const version = process.argv[3] ?? pkg.version;
const bundle = path.join(app, `release/${arch}/AI Keyboard Console.app`);
const dmg = path.join(app, `release/AI-Keyboard-Console-${version}-${arch}.dmg`);
if (!fs.existsSync(bundle)) {
  console.error('make-dmg: app bundle missing — run pack:mac first');
  process.exit(1);
}
fs.rmSync(dmg, { force: true });
execFileSync(
  'hdiutil',
  ['create', '-volname', 'AI Keyboard Console', '-srcfolder', bundle, '-ov', '-format', 'UDZO', dmg],
  { stdio: 'inherit' },
);
console.log('make-dmg: created', dmg);
