#!/usr/bin/env node
/**
 * Firmware static checks (no QMK/ZMK toolchain required):
 *  1. AKP codec copies are identical across QMK module / QMK example
 *     keyboard / ZMK module.
 *  2. The pure-C codec compiles and its unit tests pass (clang).
 *  3. Structural sanity of the QMK module, example keyboard and ZMK module.
 *
 * Run: npm run test:firmware   (or: node scripts/firmware-static-check.mjs)
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (name) => console.log(`  ok   ${name}`);
const fail = (name, detail) => {
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

const qmkModule = (p) => path.join(root, 'firmware/qmk/modules/ai_console', p);
const qmkBoard = (p) => path.join(root, 'firmware/qmk/keyboards/ai_console', p);
const zmkModule = (p) => path.join(root, 'firmware/zmk/ai-agent-console', p);

console.log('firmware static checks\n');

/* ---------- 1. codec copies identical ---------- */
console.log('[1] AKP codec copy consistency');
for (const f of ['akp.c', 'akp.h']) {
  const a = fs.readFileSync(qmkModule(f), 'utf8');
  const b = fs.readFileSync(qmkBoard(`ai_console/${f}`), 'utf8');
  const c = fs.readFileSync(zmkModule(f === 'akp.c' ? 'src/akp.c' : 'include/akp/akp.h'), 'utf8');
  if (a === b && a === c) ok(`akp codec copy identical (${f})`);
  else fail(`akp codec copy identical (${f})`, 'copies diverge — re-sync from firmware/qmk/modules/ai_console');
}

/* ---------- 2. compile + run C codec tests ---------- */
console.log('\n[2] pure-C codec unit tests (clang)');
try {
  const tmp = path.join(root, '.tmp-akp-test');
  fs.mkdirSync(tmp, { recursive: true });
  execFileSync('cc', [
    '-std=c99', '-Wall', '-Wextra',
    '-I', qmkModule('.'),
    qmkModule('test/akp_test.c'),
    qmkModule('akp.c'),
    '-o', path.join(tmp, 'akp_test'),
  ], { stdio: 'pipe' });
  const out = execFileSync(path.join(tmp, 'akp_test'), [], { stdio: 'pipe' }).toString();
  if (out.includes('ALL TESTS PASSED')) ok('akp_test.c: ALL TESTS PASSED');
  else fail('akp_test.c', 'test binary reported failures');
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (err) {
  fail('akp_test.c compile/run', String(err.message || err).split('\n')[0]);
}

/* ---------- 3. structural checks ---------- */
console.log('\n[3] QMK module structure');
const qmkRequired = ['akp.c', 'akp.h', 'ai_console.c', 'ai_console.h', 'test/akp_test.c'];
for (const f of qmkRequired) {
  fs.existsSync(qmkModule(f)) ? ok(`QMK module file present: ${f}`) : fail(`QMK module file present: ${f}`);
}
const qmkSrc = fs.readFileSync(qmkModule('ai_console.c'), 'utf8');
qmkSrc.includes('raw_hid_receive_kb') ? ok('raw_hid_receive_kb hook present') : fail('raw_hid_receive_kb hook present');
qmkSrc.includes('ai_console_send_cmd') ? ok('CMD sender present') : fail('CMD sender present');
qmkSrc.includes('ai_console_send_hello') ? ok('HELLO sender present') : fail('HELLO sender present');

console.log('\n[4] QMK example keyboard structure');
const boardRequired = ['rules.mk', 'config.h', 'keyboard.json', 'keymaps/default/keymap.c', 'readme.md', 'ai_console/akp.c', 'ai_console/ai_console.c'];
for (const f of boardRequired) {
  fs.existsSync(qmkBoard(f)) ? ok(`keyboard file present: ${f}`) : fail(`keyboard file present: ${f}`);
}
const rules = fs.readFileSync(qmkBoard('rules.mk'), 'utf8');
const kbJson = JSON.parse(fs.readFileSync(qmkBoard('keyboard.json'), 'utf8'));
const feats = kbJson.features ?? {};
const expected = { raw: 'RAW_ENABLE', encoder: 'ENCODER_ENABLE', oled: 'OLED_ENABLE' };
for (const [key, label] of Object.entries(expected)) {
  feats[key] ? ok(`keyboard.json enables ${label} (${key})`) : fail(`keyboard.json enables ${label} (${key})`);
}
rules.includes('ai_console/akp.c') && rules.includes('ai_console/ai_console.c')
  ? ok('rules.mk adds module sources')
  : fail('rules.mk adds module sources');
rules.includes('keyboards/ai_console/ai_console')
  ? ok('rules.mk sets module VPATH')
  : fail('rules.mk sets module VPATH');
// rgb_matrix support stays in the module even if the demo board leaves it off
const moduleSrc = fs.readFileSync(qmkModule('ai_console.c'), 'utf8');
moduleSrc.includes('rgb_matrix_set_color') && moduleSrc.includes('RGB_MATRIX_ENABLE')
  ? ok('module supports per-key RGB (rgb_matrix)')
  : fail('module supports per-key RGB (rgb_matrix)');
const keymap = fs.readFileSync(qmkBoard('keymaps/default/keymap.c'), 'utf8');
for (const kc of ['AI_SELECT_AGENT', 'AI_APPROVE', 'AI_REJECT', 'AI_NEW_TASK', 'AI_SEND', 'AI_DICTATE', 'AI_FAST_MODE', 'AI_REASONING_UP', 'AI_REASONING_DOWN']) {
  keymap.includes(kc) ? ok(`keymap uses ${kc}`) : fail(`keymap uses ${kc}`);
}
keymap.includes('ai_console_init') && keymap.includes('ai_console_process_record')
  ? ok('keymap wires ai_console_init + ai_console_process_record')
  : fail('keymap wires ai_console_init + ai_console_process_record');

console.log('\n[5] ZMK module structure');
const zmkRequired = [
  'zephyr/module.yml', 'CMakeLists.txt', 'Kconfig',
  'include/raw_hid/raw_hid.h', 'include/raw_hid/events.h', 'include/akp/akp.h',
  'include/behavior_ai_console.h', 'include/dt-bindings/behavior/ai_console.h',
  'src/akp.c', 'src/raw_hid_usb.c', 'src/raw_hid_hog.c', 'src/raw_hid_events.c',
  'src/ai_console.c', 'src/behavior_ai_console.c',
  'dts/bindings/behavior/zmk,behavior-ai-console.yaml',
  'behaviors/ai_console.dtsi',
];
for (const f of zmkRequired) {
  fs.existsSync(zmkModule(f)) ? ok(`ZMK file present: ${f}`) : fail(`ZMK file present: ${f}`);
}
const moduleYml = fs.readFileSync(zmkModule('zephyr/module.yml'), 'utf8');
moduleYml.includes('name: ai-agent-console') ? ok('module.yml names ai-agent-console') : fail('module.yml names ai-agent-console');
const kconfig = fs.readFileSync(zmkModule('Kconfig'), 'utf8');
for (const opt of ['AI_CONSOLE_RAW_HID_USB', 'AI_CONSOLE_RAW_HID_HOG', 'AI_CONSOLE_UNDERGLOW', 'AI_CONSOLE_OLED']) {
  kconfig.includes(opt) ? ok(`Kconfig option ${opt}`) : fail(`Kconfig option ${opt}`);
}
const yaml = fs.readFileSync(zmkModule('dts/bindings/behavior/zmk,behavior-ai-console.yaml'), 'utf8');
yaml.includes('compatible: "zmk,behavior-ai-console"') ? ok('behavior binding compatible') : fail('behavior binding compatible');
const behavior = fs.readFileSync(zmkModule('src/behavior_ai_console.c'), 'utf8');
behavior.includes('zmk_behavior_ai_console') && behavior.includes('ai_console_send_cmd')
  ? ok('behavior sends AKP commands')
  : fail('behavior sends AKP commands');
const consoleSrc = fs.readFileSync(zmkModule('src/ai_console.c'), 'utf8');
consoleSrc.includes('ai_send_hello') && consoleSrc.includes('AKP_MSG_STATE') && consoleSrc.includes('akp_decode_report')
  ? ok('ZMK console handles HELLO/STATE/receive')
  : fail('ZMK console handles HELLO/STATE/receive');

console.log('\n[6] protocol docs cross-reference');
const protoDoc = fs.readFileSync(path.join(root, 'docs/PROTOCOLS.md'), 'utf8');
for (const term of ['0xFF60', '0x61', 'F13', 'heartbeat', 'capability', 'crc16', 'crc8']) {
  protoDoc.toLowerCase().includes(term.toLowerCase()) ? ok(`PROTOCOLS.md covers ${term}`) : fail(`PROTOCOLS.md covers ${term}`);
}

console.log(`\n${failures === 0 ? 'ALL FIRMWARE CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
