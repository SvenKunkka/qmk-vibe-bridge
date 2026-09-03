/**
 * Simulator CLI — no hardware required (round-15).
 *
 *   vibebridge-sim all                       # virtual keyboard (akp) + agent
 *   vibebridge-sim keyboard [--mode MODE]    # keyboard only, interactive
 *   vibebridge-sim agent                     # virtual agent only
 *   vibebridge-sim scenario                  # scripted e2e scenario, exits
 *
 * MODES: akp | unknown-rawhid | via | zmk-studio | simulator
 */

import * as readline from 'node:readline';
import { VirtualKeyboardServer, type VirtualKeyboardMode } from './virtual-keyboard';
import { VirtualAgentServer } from './virtual-agent';
import { rgbToHex } from '@vibebridge/akp-codec';

const KB_PORT = 18902;
const AGENT_PORT = 18903;

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  const tag = level === 'info' ? 'ℹ' : level === 'warn' ? '⚠' : '✖';
  console.log(`  ${tag} ${msg}`);
}

async function runKeyboard(mode: VirtualKeyboardMode, interactive = true): Promise<VirtualKeyboardServer> {
  const kb = new VirtualKeyboardServer({
    port: KB_PORT,
    mode,
    onLog: log,
    onState: (state, color) => {
      console.log(`  ⌨  keyboard shows STATE=${state}  ● ${rgbToHex(color)}`);
    },
    onScreen: (lines) => {
      console.log(`  ⌨  OLED: ${lines.map((l) => (l || ' ').padEnd(21)).join('│')}`);
    },
  });
  await kb.start();
  console.log(`\n  ⌨  Virtual keyboard ready on tcp://127.0.0.1:${KB_PORT} (mode: ${mode})`);
  if (interactive) {
    console.log('  Commands: key F13..F24 | knob cw|ccw | scenario | help | quit');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.setPrompt('vkb> ');
    rl.prompt();
    rl.on('line', async (line) => {
      const parts = line.trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase();
      try {
        if (cmd === 'key' && parts[1]) {
          await kb.pressKey(parts[1].toUpperCase());
        } else if (cmd === 'knob' && parts[1]) {
          await kb.knob(parts[1] === 'cw' ? 1 : -1);
        } else if (cmd === 'scenario') {
          await runScenario(kb);
        } else if (cmd === 'quit' || cmd === 'exit') {
          rl.close();
          process.exit(0);
        } else {
          console.log('  Commands: key F13..F24 | knob cw|ccw | scenario | help | quit');
        }
      } catch (err) {
        log('error', String((err as Error).message));
      }
      rl.prompt();
    });
  }
  return kb;
}

async function runAgent(): Promise<VirtualAgentServer> {
  const agent = new VirtualAgentServer({ port: AGENT_PORT, onLog: log, onAction: (a) => log('info', `agent got action: ${a}`) });
  await agent.start();
  console.log(`\n  🤖 Virtual agent ready on tcp://127.0.0.1:${AGENT_PORT} (JSON lines)`);
  return agent;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runScenario(kb: VirtualKeyboardServer): Promise<void> {
  console.log('\n  ——— Demo scenario ———');
  const sequence: Array<[string, number]> = [
    ['F16', 300], // new_task
    ['F14', 600], // approve (when waiting)
    ['F17', 400], // send
    ['F19', 300], // fast_mode
    ['F20', 300], // reasoning_up
    ['F13', 300], // select_agent
    ['F18', 500], // dictate
    ['F21', 300], // reasoning_down
  ];
  for (const [key, wait] of sequence) {
    await kb.pressKey(key);
    await sleep(wait);
  }
  console.log('  ——— scenario complete ———\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modeArg = args.indexOf('--mode');
  const mode: VirtualKeyboardMode = (modeArg >= 0 ? (args[modeArg + 1] as VirtualKeyboardMode) : 'akp') ?? 'akp';
  const cmd = args[0] ?? 'all';
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   Vibe Bridge — Virtual Hardware Simulator (round-15)        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  if (cmd === 'keyboard' || cmd === 'kb') {
    await runKeyboard(mode, true);
  } else if (cmd === 'agent') {
    await runAgent();
    setInterval(() => {}, 1 << 30);
  } else if (cmd === 'scenario') {
    const kb = await runKeyboard(mode, false);
    const agent = await runAgent();
    await sleep(500);
    await runScenario(kb);
    await kb.stop();
    await agent.stop();
    console.log('\n  ✔ scenario finished\n');
    process.exit(0);
  } else {
    const kb = await runKeyboard(mode, false);
    const agent = await runAgent();
    await sleep(600);
    await runScenario(kb);
    console.log('\n  Both simulators running. Start the app (npm run start -w app) and it will connect automatically.\n');
    setInterval(() => {}, 1 << 30);
  }
}

main().catch((err) => {
  console.error('simulator failed:', err);
  process.exit(1);
});
