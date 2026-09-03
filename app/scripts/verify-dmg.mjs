#!/usr/bin/env node
/**
 * Mount the DMG and run codesign --verify --deep --strict on the app inside.
 * Fails loudly if the internal app does not pass — this is the automated
 * release gate for macOS artifacts (A5).
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
const arch = process.argv[2] ?? 'mac-arm64';
const version = process.argv[3] ?? pkg.version;
const dmg = path.join(app, process.argv[2]?.endsWith('.dmg') ? process.argv[2] : `release/AI-Keyboard-Console-${version}-${arch}.dmg`);
if (!fs.existsSync(dmg)) {
  console.error('verify-dmg: DMG not found:', dmg);
  process.exit(1);
}

// mount
const attach = spawnSync('hdiutil', ['attach', '-nobrowse', '-readonly', dmg], { encoding: 'utf8' }).stdout ?? '';
const mntLine = attach.split('\n').find((l) => l.includes('/Volumes/'));
if (!mntLine) {
  console.error('verify-dmg: mount failed\n' + attach);
  process.exit(1);
}
// the mount point may contain spaces ("/Volumes/AI Keyboard Console") — take
// everything from the first /Volumes/ occurrence to end of line
const mountPoint = mntLine.slice(mntLine.indexOf('/Volumes/')).trim();
const bundle = path.join(mountPoint, 'AI Keyboard Console.app');
console.log('verify-dmg: mounted at', mountPoint);

try {
  const res = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], { encoding: 'utf8' });
  const out = (res.stdout ?? '') + (res.stderr ?? '');
  if (res.status !== 0 || !/valid on disk/.test(out)) {
    console.error('verify-dmg: codesign did NOT report valid on disk (status=' + res.status + ')\n' + out);
    process.exit(1);
  }
  console.log('verify-dmg: internal app codesign OK (valid on disk)');
} finally {
  try {
    spawnSync('hdiutil', ['detach', mountPoint], { stdio: 'ignore' });
  } catch {
    /* ignore detach errors */
  }
}
