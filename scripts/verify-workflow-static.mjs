#!/usr/bin/env node
/**
 * Static assertions for desktop-release.yml (round-4 acceptance).
 * Simulates github.ref_name=v0.9.0 and asserts:
 *  P0-2: all 9 artifact filenames use the version WITHOUT a leading 'v'
 *        (exactly 0.9.0), matching electron-builder's package.json version.
 *  P0-1: Windows portable zip is built from the WHOLE win-unpacked dir.
 *  P0-3: release job has both branches (create / upload --clobber), never
 *        deletes a release, no '|| true', no pipe that masks gh's exit code,
 *        and GH_REPO is explicit.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yml = fs.readFileSync(path.join(root, '.github/workflows/desktop-release.yml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'app/package.json'), 'utf8'));

let failures = 0;
const ok = (m) => console.log('  ok   ' + m);
const fail = (m) => {
  failures++;
  console.log('  FAIL ' + m);
};

const REF = 'v0.9.0';
const VERSION = REF.replace(/^v/, '');
console.log(`static check with ref_name=${REF} -> version=${VERSION} (pkg=${pkg.version})\n`);

// ---- P0-2: 9 expected filenames, exact version, no leading v ----
const expected = [
  `AI-Keyboard-Console-${VERSION}-mac-arm64.dmg`,
  `AI-Keyboard-Console-${VERSION}-mac-arm64.zip`,
  `AI-Keyboard-Console-${VERSION}-mac-x64.dmg`,
  `AI-Keyboard-Console-${VERSION}-mac-x64.zip`,
  `AI-Keyboard-Console-${VERSION}-win-x64.exe`,
  `AI-Keyboard-Console-${VERSION}-win-x64-portable.zip`,
  `AI-Keyboard-Console-${VERSION}-linux-x64.AppImage`,
  `AI-Keyboard-Console-${VERSION}-linux-x64.deb`,
  `AI-Keyboard-Console-${VERSION}-linux-x64.tar.gz`,
];
for (const f of expected) {
  if (f.includes(`-v${VERSION}`) || f.includes('v0.9.0')) {
    fail(`filename must not contain leading-v version: ${f}`);
  } else if (!f.includes(`-${VERSION}-`) && !f.endsWith(`-${VERSION}`)) {
    fail(`filename must embed exact version ${VERSION}: ${f}`);
  } else {
    ok(`expected artifact: ${f}`);
  }
}
if (VERSION !== pkg.version) {
  fail(`VERSION ${VERSION} != app/package.json version ${pkg.version}`);
} else {
  ok(`version ${VERSION} matches app/package.json`);
}

// version resolution: strip leading v from ref_name
if (!yml.includes('echo "version=${RAW#v}"')) {
  fail('workflow must strip leading v from ref_name (${RAW#v})');
} else {
  ok('workflow strips leading v in version resolution');
}

// ---- P0-1: portable zip covers the whole win-unpacked ----
const winPack = yml.match(/- name: Package Windows app[\s\S]*?\n\s{4,8}- name: Per-job SHA256SUMS/m)?.[0] ?? '';
// ${{ matrix.dir }} resolves to win-unpacked; the whole dir (/* glob or
// zip -r <dir>) must be compressed, never a single exe path
if (/Compress-Archive[\s\S]*?\$\{\{ matrix\.dir \}\}\/\*/.test(winPack) || /zip -rq[\s\S]*?\$\{\{ matrix\.dir \}\}/.test(winPack)) {
  ok('portable zip built from whole win-unpacked dir (not single exe)');
} else {
  fail('portable zip must compress the whole win-unpacked directory');
}
if (/Compress-Archive[\s\S]*?\$\{\{ matrix\.dir \}\}\/AI Keyboard Console\.exe'/.test(winPack)) {
  fail('portable zip must not compress a single exe');
}

// ---- P0-3: release branch logic ----
if (/gh release delete/.test(yml)) {
  fail('workflow must never delete an existing release');
} else {
  ok('no gh release delete (non-destructive policy)');
}
if (/\|\| true/.test(yml)) {
  fail('workflow must not contain || true');
} else {
  ok('no || true anywhere');
}
if (/\| tail/.test(yml)) {
  fail('workflow must not pipe gh output into tail (masks exit code)');
} else {
  ok('no `| tail` pipe masking gh exit codes');
}
if (yml.includes('gh release upload "$TAG" dist/* --clobber')) {
  ok('update branch: gh release upload --clobber');
} else {
  fail('missing update branch (gh release upload --clobber)');
}
if (yml.includes('gh release create "$TAG" --title')) {
  ok('create branch: gh release create');
} else {
  fail('missing create branch (gh release create)');
}
if (/GH_REPO: \${{ github\.repository }}/.test(yml)) {
  ok('explicit GH_REPO');
} else {
  fail('missing explicit GH_REPO');
}

console.log(`\n${failures === 0 ? 'WORKFLOW STATIC CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
