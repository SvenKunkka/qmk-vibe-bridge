#!/usr/bin/env node
/**
 * Ad-hoc sign the packaged macOS app so codesign --verify --deep --strict
 * passes. Real Developer ID signing is a distribution concern — without a
 * Developer ID this app is LOCAL-ONLY and must not be distributed.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arch = process.argv[2] ?? 'mac-arm64';
const candidates = [`release/${arch}/AI Keyboard Console.app`, `release/${arch === 'mac-x64' ? 'mac' : arch}/AI Keyboard Console.app`, 'release/mac/AI Keyboard Console.app'];
const bundle = candidates.map((c) => path.join(app, c)).find((c) => fs.existsSync(c));
if (!bundle) {
  console.error('ad-hoc-sign: app bundle not found');
  process.exit(1);
}

// list identities: no Developer ID => local-only
let identities = '';
try {
  identities = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' });
} catch {
  /* ignore */
}
const hasDevId = /Developer ID Application/i.test(identities);
console.log(`ad-hoc-sign: bundle=${bundle}`);
console.log(`ad-hoc-sign: identities=${(identities.match(/\d+\)/g) ?? []).length}`);
console.log(`ad-hoc-sign: developer-id-present=${hasDevId}${hasDevId ? '' : ' (LOCAL-ONLY, do not distribute)'}`);

execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], { stdio: 'inherit' });
console.log('ad-hoc-sign: codesign verify OK');
