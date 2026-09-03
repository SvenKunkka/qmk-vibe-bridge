import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyTurn, colorsForSlots, parseDshSessionText, rgbToHsv } from './controller.mjs';

test('RGB primaries convert to QMK HSV', () => {
  assert.deepEqual(rgbToHsv({ r: 255, g: 0, b: 0 }), { h: 0, s: 255, v: 255 });
  assert.deepEqual(rgbToHsv({ r: 0, g: 0, b: 0 }), { h: 0, s: 0, v: 0 });
  assert.equal(rgbToHsv({ r: 0, g: 120, b: 255 }).v, 255);
});

test('assigned task LEDs use maximum brightness and empty slots stay off', () => {
  const colors = colorsForSlots([
    { state: 'thinking' },
    { state: 'tool' },
    { state: 'waiting' },
    { state: 'done' },
    { state: 'error' },
    { state: 'idle' },
  ]);
  assert.deepEqual(colors.slice(0, 6).map((color) => color.v), [255, 255, 255, 255, 255, 255]);
  assert.deepEqual(colors.slice(0, 5).map((color) => color.h), [170, 213, 21, 85, 0]);
  assert.deepEqual(colors.slice(0, 5).map((color) => color.s), [255, 255, 255, 255, 255]);
  assert.deepEqual(colors.slice(6).map((color) => color.v), [0, 0, 0, 0, 0, 0]);
});

test('completed and interrupted turns classify deterministically', () => {
  assert.equal(classifyTurn('completed', '/missing'), 'done');
  assert.equal(classifyTurn('interrupted', '/missing'), 'error');
  assert.equal(classifyTurn(undefined, '/missing'), 'idle');
});

test('an active request_user_input is waiting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k10-codex-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'a', name: 'request_user_input' } })}\n`);
  assert.equal(classifyTurn('inProgress', file), 'waiting');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pending tools are purple and completed tools return to thinking', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k10-codex-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'a', name: 'exec' } })}\n`);
  assert.equal(classifyTurn('inProgress', file), 'tool');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a' } })}\n`);
  assert.equal(classifyTurn('inProgress', file), 'thinking');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DeepSeek completed sessions are green', () => {
  const text = [
    { type: 'session', id: 'session-one', createdAt: 100, cwd: '/tmp/project', delegationDepth: 0 },
    { type: 'session/title', time: 110, data: { title: 'DeepSeek work' } },
    { type: 'turn/start', time: 120, data: { turn: 1 } },
    { type: 'turn/end', time: 130, data: { turn: 1, reason: { kind: 'completed' } } },
  ].map(JSON.stringify).join('\n');
  assert.deepEqual(parseDshSessionText(text), {
    id: 'session-one',
    title: 'DeepSeek work',
    cwd: '/tmp/project',
    delegationDepth: 0,
    state: 'done',
    turnStatus: 'completed',
    updatedAt: 130,
  });
});

test('DeepSeek pending questions are amber and normal tools are purple', () => {
  const base = [
    { type: 'session', id: 'session-two', createdAt: 100, cwd: '/tmp/project', delegationDepth: 0 },
    { type: 'turn/start', time: 120, data: { turn: 1 } },
  ];
  const question = [...base, { type: 'tool/call', time: 130, data: { callId: 'q', name: 'ask_user_question' } }];
  const tool = [...base, { type: 'tool/call', time: 130, data: { callId: 't', name: 'bash' } }];
  assert.equal(parseDshSessionText(question.map(JSON.stringify).join('\n')).state, 'waiting');
  assert.equal(parseDshSessionText(tool.map(JSON.stringify).join('\n')).state, 'tool');
});

test('empty DeepSeek startup sessions do not consume an F-key slot', () => {
  const text = JSON.stringify({
    type: 'session', id: 'session-empty', createdAt: 100, cwd: '/tmp/project', delegationDepth: 0,
  });
  assert.equal(parseDshSessionText(text), null);
});
