#!/usr/bin/env node
/**
 * Environment doctor — checks the local setup for the AI Keyboard Console.
 * Read-only: reports versions, permissions and integration points.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = process.cwd();
let issues = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const warn = (m) => {
  issues++;
  console.log(`  ⚠ ${m}`);
};

console.log('AI Keyboard Console — environment doctor\n');

try {
  ok(`Node ${process.version}`);
} catch {
  warn('Node not found');
}

// node-hid
try {
  const hid = require(require.resolve('node-hid', { paths: [path.join(root, 'node_modules')] }));
  ok(`node-hid loaded (${hid.devices().length} HID devices)`);
  const akp = hid.devices().filter((d) => d.usagePage === 0xff60 || d.usage === 0x61);
  if (akp.length > 0) {
    ok(`found ${akp.length} Raw-HID(0xFF60/0x61) device(s) — AKP compatibility not verified`);
  } else {
    ok('no Raw-HID(0xFF60/0x61) devices found (expected without our firmware)');
  }
} catch (err) {
  warn(`node-hid unavailable: ${err.message} (cd app && npm run rebuild)`);
}

// electron
try {
  const v = execFileSync(
    path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    ['--version'],
    { encoding: 'utf8' },
  ).trim();
  ok(`electron ${v}`);
} catch {
  warn('electron binary missing — reinstall: cd app && npm install electron@33.4.11');
}

// zstd
try {
  execFileSync('unzstd', ['--version'], { stdio: 'pipe' });
  ok('unzstd available (DSH log decoding)');
} catch {
  warn('unzstd missing — brew install zstd (needed for DeepSeek Harness source)');
}

// agent logs
const dshRoot = path.join(os.homedir(), '.dsh', 'sessions');
if (fs.existsSync(dshRoot)) ok('~/.dsh/sessions present');
else warn('~/.dsh/sessions missing (DSH never run on this machine)');
const codexRoot = path.join(os.homedir(), '.codex', 'sessions');
if (fs.existsSync(codexRoot)) ok('~/.codex/sessions present');
else warn('~/.codex/sessions missing');
const claudeRoot = path.join(os.homedir(), '.claude', 'projects');
if (fs.existsSync(claudeRoot)) ok('~/.claude/projects present');
else warn('~/.claude/projects missing');

// accessibility permission (macOS) — with a hard timeout so the doctor
// never blocks on a permission prompt
if (process.platform === 'darwin') {
  const { spawn } = await import('node:child_process');
  const probe = new Promise((resolve) => {
    const child = spawn('osascript', [
      '-e',
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ]);
    let out = '';
    let done = false;
    const finish = (msg) => {
      if (done) return;
      done = true;
      resolve(msg);
    };
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => finish(out.trim() ? `macOS Accessibility OK (frontmost: ${out.trim()})` : 'accessibility probe returned nothing'));
    child.on('error', () => finish('osascript unavailable'));
    setTimeout(() => {
      child.kill();
      finish('macOS Accessibility probe timed out (likely awaiting permission) — macro executor will fail until granted');
    }, 3000);
  });
  const msg = await probe;
  msg.startsWith('macOS Accessibility OK') ? ok(msg) : warn(msg);
}

// qmk toolchain
const qmkCandidates = ['qmk', path.join(os.homedir(), 'Library', 'Python', '3.14', 'bin', 'qmk')];
let qmkOk = false;
for (const c of qmkCandidates) {
  try {
    const v = execFileSync(c, ['--version'], { encoding: 'utf8' }).trim();
    ok(`qmk ${v}`);
    qmkOk = true;
    break;
  } catch { /* try next */ }
}
if (qmkOk) {
  if (fs.existsSync(path.join(os.homedir(), 'qmk_firmware'))) {
    ok('~/qmk_firmware present');
  } else {
    warn('~/qmk_firmware missing (qmk setup)');
  }
} else {
  warn('qmk CLI not on PATH (pip install qmk)');
}

console.log(`\n${issues === 0 ? 'Environment looks good.' : `${issues} item(s) need attention.`}`);
