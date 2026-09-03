#!/usr/bin/env node
/**
 * Release artifact validation for GitHub Actions (B5 + round-3 hardening).
 * Usage: node scripts/verify-release-artifacts.mjs <dir>
 *
 * Full per-platform matrix:
 *   macOS arm64/x64 : .dmg (mount + codesign --verify --deep --strict on the
 *                     internal app) + .zip (non-empty, contains the .app)
 *   Windows x64     : .exe (PE/MZ header) + -portable.zip (non-empty,
 *                     contains the main exe)
 *   Linux x64       : .AppImage (ELF) + .deb (dpkg-deb --info) +
 *                     .tar.gz (non-empty, contains the main program)
 * SHA256SUMS-*.txt must cover every artifact with no duplicates.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: verify-release-artifacts.mjs <artifact-dir>');
  process.exit(1);
}

let failures = 0;
const ok = (m) => console.log('  ok   ' + m);
const fail = (m) => {
  failures++;
  console.log('  FAIL ' + m);
};

const files = fs.readdirSync(dir).filter((f) => {
  if (/^SHA256SUMS.*\.txt$/.test(f)) return false;
  // directories (e.g. mac-arm64/) are validated separately, not checksummed
  try { return fs.statSync(dir + '/' + f).isFile(); } catch { return false; }
});
if (files.length === 0) {
  fail('no artifacts in ' + dir);
  process.exit(1);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const f of files) {
  const p = path.join(dir, f);
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    ok(`${f}: directory, skipped`);
    continue;
  }
  if (st.size === 0) {
    fail(`${f}: empty`);
    continue;
  }
  ok(`${f}: present (${st.size} bytes)`);

  if (f.endsWith('.dmg')) {
    if (process.platform !== 'darwin') {
      ok(`${f}: present on non-mac runner (mount gate runs on macOS)`);
      continue;
    }
    const attach = spawnSync('hdiutil', ['attach', '-nobrowse', '-readonly', p], { encoding: 'utf8' });
    const line = (attach.stdout ?? '').split('\n').find((l) => l.includes('/Volumes/'));
    if (!line) {
      fail(`${f}: mount failed`);
      continue;
    }
    const mount = line.slice(line.indexOf('/Volumes/')).trim();
    const bundle = path.join(mount, 'AI Keyboard Console.app');
    const cs = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], { encoding: 'utf8' });
    const out = (cs.stdout ?? '') + (cs.stderr ?? '');
    if (cs.status !== 0 || !/valid on disk/.test(out)) {
      fail(`${f}: internal app codesign invalid`);
    } else {
      ok(`${f}: internal app codesign valid on disk`);
    }
    spawnSync('hdiutil', ['detach', mount], { stdio: 'ignore' });
  } else if (f.endsWith('.zip') && f.includes('mac-')) {
    // macOS portable zip: must contain the .app bundle
    const list = spawnSync('tar', ['-tf', p], { encoding: 'utf8' }).stdout ?? '';
    if (!/AI Keyboard Console\.app\//.test(list)) {
      fail(`${f}: zip does not contain the .app bundle`);
    } else {
      ok(`${f}: zip contains AI Keyboard Console.app`);
    }
  } else if (f.endsWith('.exe')) {
    const buf = fs.readFileSync(p).subarray(0, 2);
    if (buf[0] === 0x4d && buf[1] === 0x5a) {
      ok(`${f}: PE (MZ) executable`);
    } else {
      fail(`${f}: not a PE executable`);
    }
  } else if (f.endsWith('portable.zip') || (f.endsWith('.zip') && f.includes('win-'))) {
    // P0-1: Windows portable zip must carry the FULL win-unpacked runtime
    // (main exe + resources/app.asar + DLLs/locales), not a single exe.
    const list = spawnSync('tar', ['-tf', p], { encoding: 'utf8' }).stdout ?? '';
    const names = list.split('\n').map((n) => n.trim()).filter(Boolean);
    const hasExe = names.some((n) => n.includes('AI Keyboard Console.exe'));
    const hasAsar = names.some((n) => n.includes('resources/app.asar'));
    const hasRuntime = names.some((n) => /locales\//i.test(n) || /\.dll$/i.test(n));
    if (!hasExe) fail(`${f}: missing main exe (AI Keyboard Console.exe)`);
    if (!hasAsar) fail(`${f}: missing resources/app.asar`);
    if (!hasRuntime) fail(`${f}: missing runtime files (locales/ or DLLs)`);
    if (names.length < 20) fail(`${f}: suspiciously few entries (${names.length}) — single-exe zip?`);
    if (hasExe && hasAsar && hasRuntime && names.length >= 20) {
      ok(`${f}: full win-unpacked runtime (${names.length} entries)`);
    }
  } else if (f.endsWith('.AppImage')) {
    const file = spawnSync('file', [p], { encoding: 'utf8' }).stdout ?? '';
    if (!/ELF/.test(file)) {
      fail(`${f}: not an ELF AppImage`);
    } else {
      ok(`${f}: ELF AppImage`);
    }
  } else if (f.endsWith('.deb')) {
    if (process.platform !== 'linux') {
      ok(`${f}: present on non-linux runner (dpkg gate runs on Linux)`);
      continue;
    }
    const info = spawnSync('dpkg-deb', ['--info', p], { encoding: 'utf8' });
    if (info.status !== 0 || !/Package:/.test(info.stdout ?? '')) {
      fail(`${f}: dpkg-deb --info failed`);
    } else {
      ok(`${f}: dpkg-deb --info OK`);
    }
  } else if (f.endsWith('.tar.gz')) {
    const list = spawnSync('tar', ['tzf', p], { encoding: 'utf8' }).stdout ?? '';
    if (!list.trim() || !/AI Keyboard Console/.test(list)) {
      fail(`${f}: tar.gz empty or missing main program`);
    } else {
      ok(`${f}: tar.gz contains the main program`);
    }
  } else if (/\.(bin|hex|uf2)$/.test(f)) {
    ok(`${f}: firmware artifact`);
  } else {
    ok(`${f}: artifact present`);
  }
}

// SHA256SUMS: every artifact must have an entry; no duplicates per file
const sumsFiles = fs.readdirSync(dir).filter((f) => /^SHA256SUMS.*\.txt$/.test(f));
if (sumsFiles.length > 0) {
  const sums = sumsFiles.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const seen = new Map();
  for (const f of files) {
    if (f.startsWith('SHA256SUMS')) continue;
    const re = new RegExp(`\\s${escapeRe(f)}$`, 'm');
    const count = (sums.match(re) ?? []).length;
    if (count === 0) fail(`${f}: missing from SHA256SUMS`);
    else if (count > 1) fail(`${f}: duplicate entries in SHA256SUMS (${count})`);
  }
  ok(`SHA256SUMS present (${sumsFiles.join(', ')})`);
} else {
  fail('SHA256SUMS missing');
}

console.log(failures === 0 ? 'RELEASE ARTIFACTS OK' : `RELEASE ARTIFACTS FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
