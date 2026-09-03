#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export const K10 = Object.freeze({
  vendorId: 0x3434,
  productId: 0x0aa0,
  usagePage: 0xff60,
  usage: 0x61,
  reportSize: 32,
  functionLedIndices: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  functionMatrixColumns: Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]),
});

// Exact QMK HSV anchors from quantum/color.h. Using the firmware-native
// palette avoids pulling blue and green toward the same cyan/green region
// after RGB -> HSV conversion and diffusion through the K10 keycaps.
export const STATUS_HSV = Object.freeze({
  thinking: Object.freeze({ h: 170, s: 255, v: 255 }), // HSV_BLUE
  tool: Object.freeze({ h: 213, s: 255, v: 255 }),     // HSV_MAGENTA
  waiting: Object.freeze({ h: 21, s: 255, v: 255 }),  // HSV_ORANGE
  done: Object.freeze({ h: 85, s: 255, v: 255 }),     // HSV_GREEN
  error: Object.freeze({ h: 0, s: 255, v: 255 }),     // HSV_RED
  idle: Object.freeze({ h: 0, s: 0, v: 255 }),        // HSV_WHITE
  off: Object.freeze({ h: 0, s: 0, v: 0 }),
});

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const requireFromApp = createRequire(path.join(projectRoot, 'app', 'package.json'));
const supportDir = path.join(os.homedir(), 'Library', 'Application Support', 'K10CodexController');
const slotsPath = path.join(supportDir, 'slots.json');
const backupPath = path.join(supportDir, 'device-backup.json');
const logPath = path.join(supportDir, 'controller.log');
const stateDbPath = path.join(os.homedir(), '.codex', 'state_5.sqlite');
const historyDbPath = path.join(os.homedir(), '.codex', 'thread_history_1.sqlite');
const sessionIndexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
const dshSessionsPath = path.join(os.homedir(), '.dsh', 'sessions');
const dshBaseUrl = 'http://127.0.0.1:3080/';
const dshAppBundleId = process.env.K10_DSH_APP_BUNDLE_ID ?? 'com.google.Chrome.app.hgiemfgfjhalibdoboikeiepnnjapnpc';
const dshSessionCache = new Map();

function log(message) {
  fs.mkdirSync(supportDir, { recursive: true });
  const line = `${new Date().toISOString()} ${message}`;
  fs.appendFileSync(logPath, `${line}\n`);
  if (process.stdout.isTTY || process.argv.includes('--verbose')) console.log(line);
}

export function rgbToHsv({ r, g, b }, valueScale = 1) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let hueDegrees = 0;
  if (delta !== 0) {
    if (max === rn) hueDegrees = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) hueDegrees = 60 * ((bn - rn) / delta + 2);
    else hueDegrees = 60 * ((rn - gn) / delta + 4);
  }
  if (hueDegrees < 0) hueDegrees += 360;
  return {
    h: Math.round((hueDegrees / 360) * 255),
    s: max === 0 ? 0 : Math.round((delta / max) * 255),
    v: Math.round(max * 255 * Math.max(0, Math.min(1, valueScale))),
  };
}

export function classifyTurn(turnStatus, rolloutPath) {
  if (turnStatus === 'completed') return 'done';
  if (turnStatus === 'failed' || turnStatus === 'interrupted' || turnStatus === 'cancelled') return 'error';
  if (turnStatus !== 'inProgress') return 'idle';

  let text = '';
  try {
    const fd = fs.openSync(rolloutPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, 384 * 1024);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 'thinking';
  }

  const lines = text.split('\n').slice(-300);
  const pending = new Map();
  let latest = 'thinking';
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== 'response_item') continue;
    const payload = row.payload ?? {};
    if (payload.type === 'reasoning') latest = 'thinking';
    if (['custom_tool_call', 'function_call', 'web_search_call', 'tool_search_call', 'local_shell_call', 'apply_patch_call'].includes(payload.type)) {
      const callId = payload.call_id ?? payload.id ?? `${row.ordinal ?? ''}:${payload.name ?? payload.type}`;
      pending.set(callId, payload.name ?? payload.type);
      latest = payload.name === 'request_user_input' ? 'waiting' : 'tool';
    }
    if (['custom_tool_call_output', 'function_call_output'].includes(payload.type)) {
      const callId = payload.call_id ?? payload.id;
      if (callId) pending.delete(callId);
      latest = 'thinking';
    }
  }
  if ([...pending.values()].some((name) => name === 'request_user_input')) return 'waiting';
  if (pending.size > 0) return 'tool';
  return latest;
}

export function loadCodexSlots(limit = 8, startSlot = 1) {
  const indexedNames = new Map();
  try {
    for (const line of fs.readFileSync(sessionIndexPath, 'utf8').split('\n')) {
      if (!line) continue;
      const item = JSON.parse(line);
      if (item.id && item.thread_name) indexedNames.set(item.id, item.thread_name);
    }
  } catch {
    // The state database title remains a usable fallback during app startup.
  }
  const state = new DatabaseSync(stateDbPath, { readOnly: true });
  const history = new DatabaseSync(historyDbPath, { readOnly: true });
  try {
    const threads = state.prepare(`
      SELECT id,
             COALESCE(NULLIF(name, ''), NULLIF(title, ''), NULLIF(first_user_message, ''), 'Untitled') AS title,
             rollout_path,
             recency_at_ms,
             is_pinned
        FROM threads
       WHERE archived = 0
         AND preview <> ''
         AND source = 'vscode'
         AND agent_path IS NULL
         AND (thread_source IS NULL OR thread_source = '' OR thread_source = 'user')
       ORDER BY recency_at_ms DESC, id DESC
       LIMIT ?
    `).all(limit);
    const latestTurn = history.prepare(`
      SELECT status, error_json, started_at, completed_at
        FROM thread_turns
       WHERE thread_id = ?
       ORDER BY started_at DESC
       LIMIT 1
    `);
    return threads.map((thread, index) => {
      const turn = latestTurn.get(thread.id);
      const stateName = classifyTurn(turn?.status, thread.rollout_path);
      return {
        provider: 'codex',
        slot: startSlot + index,
        key: `F${startSlot + index}`,
        emittedKey: `F${startSlot + index + 12}`,
        id: thread.id,
        title: indexedNames.get(thread.id) ?? thread.title,
        state: stateName,
        turnStatus: turn?.status ?? 'none',
        updatedAt: thread.recency_at_ms,
        url: `codex://threads/${thread.id}`,
      };
    });
  } finally {
    state.close();
    history.close();
  }
}

function listDshSessionFiles(root = dshSessionsPath) {
  const files = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name === 'session.jsonl.zstd') files.push(fullPath);
    }
  };
  visit(root);
  return files;
}

function eventTime(row, fallback) {
  const value = Number(row?.time ?? row?.createdAt);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function parseDshSessionText(text, fallbackUpdatedAt = 0) {
  let id = '';
  let title = '';
  let cwd = '';
  let delegationDepth = 0;
  let state = 'idle';
  let turnStatus = 'none';
  let running = false;
  let hasActivity = false;
  let updatedAt = fallbackUpdatedAt;
  const pending = new Map();

  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    updatedAt = Math.max(updatedAt, eventTime(row, 0));
    const data = row.data ?? {};
    if (row.type === 'session') {
      id = row.id ?? id;
      cwd = row.cwd ?? cwd;
      delegationDepth = row.delegationDepth ?? delegationDepth;
    } else if (row.type === 'session/title') {
      title = data.title ?? title;
    } else if (row.type === 'turn/start') {
      hasActivity = true;
      running = true;
      pending.clear();
      state = 'thinking';
      turnStatus = 'inProgress';
    } else if (row.type === 'tool/call') {
      const callId = data.callId ?? `${data.turn ?? ''}:${data.step ?? ''}:${data.name ?? 'tool'}`;
      const name = data.name ?? 'tool';
      pending.set(callId, name);
      state = ['ask_user_question', 'request_user_input'].includes(name) ? 'waiting' : 'tool';
    } else if (row.type === 'tool/result') {
      const callId = data.message?.source?.callId ?? data.callId;
      if (callId) pending.delete(callId);
      if (running) state = 'thinking';
    } else if (['approval/requested', 'question/requested'].includes(row.type)) {
      pending.set(`${row.type}:${row.seq ?? updatedAt}`, row.type);
      state = 'waiting';
    } else if (['approval/resolved', 'question/resolved'].includes(row.type)) {
      pending.clear();
      if (running) state = 'thinking';
    } else if (row.type === 'turn/end') {
      running = false;
      pending.clear();
      turnStatus = data.reason?.kind ?? 'completed';
      state = turnStatus === 'completed' || turnStatus === 'stop' ? 'done' : 'error';
    }
  }

  if (!id || !hasActivity) return null;
  if (running) {
    if ([...pending.values()].some((name) => ['ask_user_question', 'request_user_input', 'approval/requested', 'question/requested'].includes(name))) state = 'waiting';
    else if (pending.size > 0) state = 'tool';
  }
  return {
    id,
    title: title || path.basename(cwd) || 'Untitled DeepSeek task',
    cwd,
    delegationDepth,
    state,
    turnStatus,
    updatedAt,
  };
}

function readDshSession(file) {
  const stat = fs.statSync(file);
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = dshSessionCache.get(file);
  if (cached?.signature === signature) return cached.session;
  try {
    // DSH appends independent Zstandard frames. The system zstd decoder is
    // intentionally used because Node's sync decoder stops after frame one.
    const text = execFileSync('/opt/homebrew/bin/zstd', ['-dc', file], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    });
    const session = parseDshSessionText(text, stat.mtimeMs);
    dshSessionCache.set(file, { signature, session });
    return session;
  } catch {
    return cached?.session ?? null;
  }
}

export function loadDshSlots(limit = 4, startSlot = 9, root = dshSessionsPath) {
  return listDshSessionFiles(root)
    .map(readDshSession)
    .filter((session) => session && session.delegationDepth === 0)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
    .slice(0, limit)
    .map((session, index) => ({
      provider: 'deepseek',
      slot: startSlot + index,
      key: `F${startSlot + index}`,
      emittedKey: `F${startSlot + index + 12}`,
      id: session.id,
      title: session.title,
      state: session.state,
      turnStatus: session.turnStatus,
      updatedAt: session.updatedAt,
      url: `${dshBaseUrl}?k10-session=${encodeURIComponent(session.id)}`,
    }));
}

export function loadSlots() {
  return [...loadCodexSlots(8, 1), ...loadDshSlots(4, 9)];
}

export function writeSlots(slots) {
  fs.mkdirSync(supportDir, { recursive: true });
  const output = {
    generatedAt: new Date().toISOString(),
    keyboard: 'Keychron K10 Max ANSI RGB 3434:0AA0',
    ordering: 'F1-F8: 8 most recently active visible Codex tasks; F9-F12: 4 most recently active DeepSeek tasks',
    legend: {
      thinking: 'blue',
      tool: 'purple',
      waiting: 'amber',
      done: 'green',
      error: 'red',
      idle: 'slate',
    },
    slots,
  };
  const temp = `${slotsPath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(output, null, 2)}\n`);
  fs.renameSync(temp, slotsPath);
  return output;
}

class K10Hid {
  constructor(HID) {
    this.HID = HID;
    this.device = null;
    this.path = null;
    this.slotQueue = [];
  }

  enumerate() {
    return this.HID.devices().filter((d) =>
      d.vendorId === K10.vendorId && d.productId === K10.productId &&
      d.usagePage === K10.usagePage && d.usage === K10.usage && d.path,
    );
  }

  open() {
    const devices = this.enumerate();
    if (devices.length !== 1) throw new Error(`expected exactly one K10 Max Raw HID interface, found ${devices.length}`);
    this.path = devices[0].path;
    this.device = new this.HID.HID(this.path);
    return devices[0];
  }

  close() {
    try { this.device?.close(); } catch { /* ignore */ }
    this.device = null;
  }

  roundTrip(report, validator = (data) => data[0] === report[0], timeoutMs = 700) {
    if (!this.device) throw new Error('K10 Max is not open');
    const packet = new Array(K10.reportSize).fill(0);
    report.slice(0, K10.reportSize).forEach((value, index) => { packet[index] = value & 0xff; });
    this.device.write([0, ...packet]);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = this.device.readTimeout(Math.min(120, deadline - Date.now()));
      if (response?.[0] === 0xad && response?.[1] === 0x01 && response?.[2] >= 1 && response?.[2] <= 12) {
        this.slotQueue.push(response[2]);
        continue;
      }
      if (response?.length && validator(response)) return response;
    }
    throw new Error(`no valid HID response for command 0x${packet[0].toString(16)}`);
  }

  pollSlot(timeoutMs = 20) {
    if (this.slotQueue.length) return this.slotQueue.shift();
    if (!this.device) return null;
    const response = this.device.readTimeout(timeoutMs);
    if (response?.[0] === 0xad && response?.[1] === 0x01 && response?.[2] >= 1 && response?.[2] <= 12) {
      return response[2];
    }
    return null;
  }

  probe() {
    const via = this.roundTrip([0x01], (r) => r[0] === 0x01);
    const keychronRgb = this.roundTrip([0xa8, 0x01], (r) => r[0] === 0xa8 && r[1] === 0x01 && r[2] === 0);
    const ledCount = this.roundTrip([0xa8, 0x05], (r) => r[0] === 0xa8 && r[1] === 0x05 && r[2] === 0);
    return {
      viaProtocol: `0x${via[1].toString(16).padStart(2, '0')}${via[2].toString(16).padStart(2, '0')}`,
      keychronRgbProtocol: `${keychronRgb[3] ?? 0}.${keychronRgb[4] ?? 0}`,
      ledCount: ledCount[3] ?? 0,
      path: this.path,
    };
  }

  getKeycode(layer, row, col) {
    const r = this.roundTrip([0x04, layer, row, col], (d) => d[0] === 0x04 && d[1] === layer && d[2] === row && d[3] === col);
    return ((r[4] ?? 0) << 8) | (r[5] ?? 0);
  }

  setKeycode(layer, row, col, keycode) {
    const hi = (keycode >> 8) & 0xff;
    const lo = keycode & 0xff;
    this.roundTrip(
      [0x05, layer, row, col, hi, lo],
      (r) => r[0] === 0x05 && r[1] === layer && r[2] === row && r[3] === col && r[4] === hi && r[5] === lo,
    );
  }

  setRgbMatrixValue(valueId, ...values) {
    this.roundTrip([0x07, 0x03, valueId, ...values], (r) => r[0] === 0x07 && r[1] === 0x03 && r[2] === valueId);
  }

  setPerKeyHsv(start, colors) {
    if (colors.length < 1 || colors.length > 9) throw new Error('Keychron per-key chunks must contain 1..9 LEDs');
    const payload = [0xa8, 0x0a, start, colors.length];
    for (const color of colors) payload.push(color.h, color.s, color.v);
    this.roundTrip(payload, (r) => r[0] === 0xa8 && r[1] === 0x0a && r[2] === 0);
  }

  getPerKeyHsv(start, count) {
    if (count < 1 || count > 9) throw new Error('Keychron per-key chunks must contain 1..9 LEDs');
    const response = this.roundTrip(
      [0xa8, 0x09, start, count],
      (r) => r[0] === 0xa8 && r[1] === 0x09 && r[2] === 0,
    );
    return Array.from({ length: count }, (_, i) => ({
      h: response[3 + i * 3],
      s: response[4 + i * 3],
      v: response[5 + i * 3],
    }));
  }

  enterBootloader() {
    if (!this.device) throw new Error('K10 Max is not open');
    const packet = new Array(K10.reportSize).fill(0);
    packet[0] = 0x0b;
    this.device.write([0, ...packet]);
  }
}

function loadHid() {
  return requireFromApp('node-hid');
}

function openK10() {
  const k10 = new K10Hid(loadHid());
  const info = k10.open();
  log(`opened ${info.product ?? 'Keychron K10 Max'} at exact Raw HID path`);
  return k10;
}

function currentKeymap(k10) {
  const keymap = {};
  for (const layer of [0, 1, 2, 3]) {
    keymap[layer] = K10.functionMatrixColumns.map((col) => k10.getKeycode(layer, 0, col));
  }
  return keymap;
}

function configureKeys(k10) {
  const existing = currentKeymap(k10);
  fs.mkdirSync(supportDir, { recursive: true });
  if (!fs.existsSync(backupPath)) {
    const backup = {
      createdAt: new Date().toISOString(),
      device: { vendorId: K10.vendorId, productId: K10.productId },
      matrix: { row: 0, columns: K10.functionMatrixColumns },
      keymap: existing,
    };
    fs.writeFileSync(backupPath, `${JSON.stringify(backup, null, 2)}\n`);
  }

  // Always source the Fn media row from the immutable first-run backup.
  // This keeps configure-keys idempotent: running it after a firmware flash
  // cannot copy an already-remapped F13..F24 row over the media layer.
  const original = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const originalMacBase = original.keymap['0'] ?? original.keymap[0];
  if (!Array.isArray(originalMacBase) || originalMacBase.length !== 12) {
    throw new Error(`invalid F-row backup at ${backupPath}`);
  }

  const f13ToF24 = Array.from({ length: 12 }, (_, i) => 0x0068 + i);
  for (let i = 0; i < K10.functionMatrixColumns.length; i++) {
    const col = K10.functionMatrixColumns[i];
    k10.setKeycode(0, 0, col, f13ToF24[i]);
    k10.setKeycode(1, 0, col, originalMacBase[i]);
    k10.setKeycode(2, 0, col, f13ToF24[i]);
    // Layer 3 already contains the regular Windows multimedia functions.
  }
  return { backupPath, before: existing, after: currentKeymap(k10) };
}

function restoreKeys(k10) {
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  for (const layer of [0, 1, 2, 3]) {
    const values = backup.keymap[String(layer)] ?? backup.keymap[layer];
    for (let i = 0; i < K10.functionMatrixColumns.length; i++) {
      k10.setKeycode(layer, 0, K10.functionMatrixColumns[i], values[i]);
    }
  }
  return currentKeymap(k10);
}

export function colorsForSlots(slots) {
  return Array.from({ length: 12 }, (_, i) => {
    const slot = slots[i];
    return { ...(slot ? (STATUS_HSV[slot.state] ?? STATUS_HSV.idle) : STATUS_HSV.off) };
  });
}

function pushColors(k10, colors) {
  // K10 F1..F12 use RGB indices 1..12. The firmware hook forces every
  // other RGB index off, so only these two RAM-only writes are required.
  k10.setPerKeyHsv(1, colors.slice(0, 9));
  k10.setPerKeyHsv(10, colors.slice(9, 12));
}

async function focusThread(slot) {
  if (!slot?.url) return false;
  let args;
  if (slot.provider === 'deepseek') {
    const endpoint = new URL('/api/k10-focus', dshBaseUrl);
    endpoint.searchParams.set('session', slot.id);
    const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(800) });
    if (!response.ok) throw new Error(`DeepSeek focus endpoint returned HTTP ${response.status}`);
    args = ['-b', dshAppBundleId];
  } else {
    args = ['-b', 'com.openai.codex', slot.url];
  }
  const child = spawn('/usr/bin/open', args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  log(`focus ${slot.key} ${slot.provider}: ${slot.title} (${slot.id})`);
  return true;
}

async function runDaemon() {
  let k10 = null;
  let lastSignature = '';
  let slots = [];
  let lastSlotRefresh = 0;
  let lastColorRefresh = 0;
  while (true) {
    try {
      const now = Date.now();
      if (now - lastSlotRefresh >= 600) {
        slots = loadSlots();
        writeSlots(slots);
        lastSlotRefresh = now;
      }
      if (!k10) {
        k10 = openK10();
        const probe = k10.probe();
        if (probe.ledCount !== 108) throw new Error(`unexpected RGB LED count ${probe.ledCount}; refusing to drive this layout`);
        // Keep the standard solid effect enabled. The custom firmware's final
        // indicator pass replaces its pixels and does not persist status to EEPROM.
        k10.setRgbMatrixValue(0x02, 0x01);
        k10.setRgbMatrixValue(0x01, 0xff);
        log(`hardware verified: VIA ${probe.viaProtocol}, RGB ${probe.keychronRgbProtocol}, ${probe.ledCount} LEDs`);
      }

      const selectedSlot = k10.pollSlot(25);
      if (selectedSlot) await focusThread(slots[selectedSlot - 1]);

      if (now - lastColorRefresh >= 650) {
        const colors = colorsForSlots(slots);
        const signature = JSON.stringify(colors);
        if (signature !== lastSignature) {
          pushColors(k10, colors);
          lastSignature = signature;
        }
        lastColorRefresh = now;
      }
    } catch (error) {
      log(`loop warning: ${error.message}`);
      k10?.close();
      k10 = null;
      lastSignature = '';
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function main() {
  const command = process.argv[2] ?? 'run';
  if (command === 'slots') {
    console.log(JSON.stringify(writeSlots(loadSlots()), null, 2));
    return;
  }
  if (command === 'probe') {
    const k10 = openK10();
    try { console.log(JSON.stringify(k10.probe(), null, 2)); } finally { k10.close(); }
    return;
  }
  if (command === 'rgb-read') {
    const k10 = openK10();
    try {
      const colors = [...k10.getPerKeyHsv(1, 9), ...k10.getPerKeyHsv(10, 3)];
      console.log(JSON.stringify(colors.map((color, index) => ({ key: `F${index + 1}`, ...color })), null, 2));
    } finally {
      k10.close();
    }
    return;
  }
  if (command === 'configure-keys') {
    const k10 = openK10();
    try { console.log(JSON.stringify(configureKeys(k10), null, 2)); } finally { k10.close(); }
    return;
  }
  if (command === 'restore-keys') {
    const k10 = openK10();
    try { console.log(JSON.stringify(restoreKeys(k10), null, 2)); } finally { k10.close(); }
    return;
  }
  if (command === 'bootloader') {
    const k10 = openK10();
    k10.enterBootloader();
    k10.close();
    console.log('K10 Max bootloader request sent.');
    return;
  }
  if (command === 'run') {
    await runDaemon();
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    log(`fatal: ${error.stack ?? error.message}`);
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
