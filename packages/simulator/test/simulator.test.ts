/**
 * Simulator e2e (round-15): virtual keyboard + virtual agent + core.
 * The full AI-event -> mapping -> gate -> adapter -> keyboard path.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConsoleCore } from '@vibebridge/core';
import { VirtualKeyboardServer, VirtualAgentServer } from '../src/index';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('virtual hardware end-to-end (round-15)', () => {
  test('full loop: agent states -> keyboard ops; simulator profile', async () => {
    const kb = new VirtualKeyboardServer({ port: 0, mode: 'simulator' });
    const agent = new VirtualAgentServer({ port: 0, auto: false, thinkingMs: 80, toolMs: 60, continueMs: 60 });
    const kbPort = await kb.start();
    const agentPort = await agent.start();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-e2e-'));
    const settingsPath = path.join(dir, 'config.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      agentSources: [
        { id: 'virtual', kind: 'virtual', label: 'Virtual Agent', enabled: true, host: '127.0.0.1', port: agentPort },
        { id: 'dsh', kind: 'dsh', label: 'DSH', enabled: false },
      ],
      activeAgentSource: 'virtual',
      executor: 'off',
      writePolicy: 'allow',
      devices: [],
    }));

    const core = new ConsoleCore({ settingsPath });
    await core.start();
    core.setWritesDisabled(false);
    await core.addSimulatorDevice({ id: 'vk', label: 'Virtual KB', kind: 'virtual', host: '127.0.0.1', port: kbPort, mtu: 32, enabled: true });
    core.assignProfile(`tcp://127.0.0.1:${kbPort}`, 'simulator');
    await core.connectDevice('vk', 'simulator');
    core.setDeviceWriteEnabled('vk', true);
    await sleep(400);

    const dev = core.devices.get('vk');
    assert.equal(dev?.status, 'ready');
    assert.equal(dev?.adapterId, 'simulator');

    // AI event -> mapping -> gate -> adapter -> keyboard
    await core.dispatchAiEvent({ type: 'tool-running', source: 'virtual', agentId: 'sim', text: 'running tests', ts: Date.now(), confidence: 1, simulated: true });
    await sleep(400);
    assert.ok(core.writeCount() >= 1, 'ops reached the keyboard');

    // keyboard action -> executor (off: recorded, no crash)
    const res = await core.triggerAction('approve');
    assert.ok(res, 'action executes');

    await core.stop();
    await kb.stop();
    await agent.stop();
  });

  test('unknown-rawhid mode stays read-only with zero writes', async () => {
    const kb = new VirtualKeyboardServer({ port: 0, mode: 'unknown-rawhid' });
    const kbPort = await kb.start();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-e2e-ro-'));
    const settingsPath = path.join(dir, 'config.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      agentSources: [], activeAgentSource: 'none', executor: 'off', writePolicy: 'read-only', devices: [],
    }));
    const core = new ConsoleCore({ settingsPath });
    await core.start();
    await core.addSimulatorDevice({ id: 'vk', label: 'Virtual KB', kind: 'virtual', host: '127.0.0.1', port: kbPort, mtu: 32, enabled: true });
    await sleep(300);
    const dev = core.devices.get('vk');
    assert.equal(dev?.status, 'transport-available');
    await core.dispatchAiEvent({ type: 'thinking', source: 'virtual', ts: Date.now(), confidence: 1, simulated: true });
    await sleep(200);
    assert.equal(core.writeCount(), 0);
    assert.equal(kb.totalHostWrites(), 0);
    await core.stop();
    await kb.stop();
  });
});
