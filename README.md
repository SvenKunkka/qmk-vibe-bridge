<!-- SVENKUNKKA-README-NAV:BEGIN -->
[中文项目说明](#project-overview-zh) · [English overview](#project-overview-en) · [维护者 X / Maintainer on X](https://x.com/Svenu1s5)
<!-- SVENKUNKKA-README-NAV:END -->

# Vibe Bridge (QMK VIBE BRIDGE)

A cross-platform desktop bridge that connects **AI agents / IDEs / automation
tools** to keyboards over the **communication interfaces the keyboard's
existing firmware already exposes** — QMK, ZMK, and their ecosystems.

```
AI Agent / IDE / Automation tool
        │  (thinking, tool-running, waiting-for-approval, done, error, …)
        ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Vibe Bridge (this app)                      │
│  AI Event Provider → Normalizer → Mapping Engine                │
│        → Capability Gate → Protocol Adapter → Transport          │
└─────────────────────────────────────────────────────────────────┘
        │  only the keyboard's own protocols (Raw HID, VIA, Vial,
        ▼   ZMK Studio RPC, CDC-ACM, BLE GATT, optional extensions)
Keyboard (QMK / ZMK) — lights, indicators, OLED, keys, knobs, …
```

The software is **read-only by default**. It never flashes firmware, never
requires a special firmware, and never claims that every QMK/ZMK keyboard
supports RGB, OLED, or AI-specific actions.

## What this software does

1. Receives AI agent events (`idle`, `thinking`, `tool-running`,
   `waiting-for-approval`, `waiting-for-user`, `done`, `error`,
   `disconnected`) from configurable providers (simulator, Codex, DeepSeek
   Harness, Claude Code, …).
2. Identifies the protocols the connected keyboard's **existing firmware**
   exposes (QMK Raw HID, VIA, Vial, ZMK Studio RPC, …).
3. Maps AI states to **capabilities** the keyboard actually declares
   (`set-indicator`, `set-rgb`, `display-text`, `runtime-keymap`, …) — never
   faking a capability the protocol does not define.
4. Provides device management, protocol identification, capability display,
   mapping configuration, **write audit**, and safety controls.
5. Runs on macOS, Windows and Linux.

## What this software does NOT do

- It does **not** flash firmware to ordinary keyboards.
- It does **not** require every keyboard to install project firmware.
- It does **not** treat the optional AKP extension as a universal
  compatibility standard.
- It does **not** claim all QMK/ZMK keyboards support RGB, OLED or AI actions.

## Quick start (macOS dev build)

```sh
npm install
npm run build
npm run simulate            # terminal 1: virtual keyboard + virtual agent
npm run start -w app        # terminal 2: the desktop app (connects to the simulator)
```

Fresh installs default to **English**; Chinese is switchable in Settings and
the choice persists across restarts and upgrades.

## Status ladder (per interface)

`Hardware detected → Transport found → Protocol identified → Capabilities
known → Limited support | Ready`, with terminal states `Unsupported`,
`Permission denied`, `Disconnected`, `Error`.

A Raw HID interface (0xFF60/0x61) with no verified control profile shows:

> QMK Raw HID transport found. No verified control profile is selected. The
> device will remain read-only.

## Testing

```sh
npm run typecheck           # TypeScript typecheck, all workspaces
npm test                    # unit tests (akp-codec 21 + core 46 + simulator 13 + app 11)
npm run acceptance          # full acceptance pipeline (scripts/acceptance.sh)
npx tsx scripts/unknown-rawhid-readonly-test.ts   # generic zero-write verification
```

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layered architecture and module map |
| [docs/PROTOCOLS.md](docs/PROTOCOLS.md) | QMK Raw HID, VIA, Vial, ZMK Studio RPC, AKP extension — with official sources |
| [docs/ADAPTER_DEVELOPMENT.md](docs/ADAPTER_DEVELOPMENT.md) | How to add a Protocol Adapter |
| [docs/CAPABILITY_MODEL.md](docs/CAPABILITY_MODEL.md) | The unified capability vocabulary and honest state declarations |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | Three-tier compatibility matrix |
| [docs/SECURITY.md](docs/SECURITY.md) | Read-only default, capability gate, write audit |
| [docs/HARDWARE_VALIDATION.md](docs/HARDWARE_VALIDATION.md) | What needs real hardware; current status |
| [docs/RELEASE_VALIDATION.md](docs/RELEASE_VALIDATION.md) | Acceptance runs, layers LOCAL/PACKAGED/HARDWARE/CLOUD |
| [docs/INSTALL.md](docs/INSTALL.md) | Install & run (dev / packaged / permissions) |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Troubleshooting |

## Local Agent API (round-17)

Agents / LLMs / automation push AI events to the app over a **127.0.0.1-only
HTTP + SSE API** with a bearer token (stored in the OS keychain). See
[examples/](examples/README.md) for curl + a CLI sender + a Codex-style
adapter sketch. The app never listens publicly.

## VIA lighting (round-17)

A real non-AKP AI indicator output path: after importing + binding a VIA
definition, the app probes the official lighting channels (rgblight /
rgb_matrix / backlight) and drives them with the official commands, verifying
every write via echo + readback (never fake "applied"). See
[docs/PROTOCOL_EVIDENCE.md](docs/PROTOCOL_EVIDENCE.md).

## Keychron K10 Max Codex + DeepSeek task row

The repository includes the hardware-verified K10 Max ANSI RGB integration in
[`tools/k10-codex-controller`](tools/k10-codex-controller/README.md):

- F1-F8 show the eight most recently active Codex tasks.
- F9-F12 show the four most recently active DeepSeek Harness tasks.
- Pressing a key focuses that task; DeepSeek tasks open in the installed
  standalone Chrome app instead of an ordinary browser tab.
- Holding Fn preserves the standard multimedia controls.
- Only F1-F12 light; status colors use full saturation and brightness.

The matching QMK keymap and local DSH focus plugin are included as source. The
integration is intentionally locked to the verified K10 Max ANSI RGB USB
identity and layout; it is not advertised as a universal Keychron profile.

## Repository layout

```
packages/akp-codec/    AKP extension codec (used ONLY by the akp-extension adapter)
packages/core/         layered core: ai/ transports/ adapters/ capabilities/ profiles/ mapping/ devices/
packages/simulator/    virtual keyboards (modes: akp, unknown-rawhid, via, zmk-studio, simulator) + virtual agent
app/                   Electron desktop app (main / preload / renderer)
firmware/qmk/          OPTIONAL AKP extension module for QMK (compatibility layer C)
firmware/zmk/          OPTIONAL AKP extension module for ZMK (compatibility layer C)
docs/                  documentation
scripts/               acceptance.sh, unknown-rawhid-readonly-test.ts, dual-launch-test.sh, …
```

## Honesty statement

- Heuristic agent-status parsing of real tool logs shows a confidence score;
  the simulator's status is always labelled **SIMULATED**.
- Simulator tests prove the SOFTWARE pipeline — they never prove keyboard
  compatibility. Hardware status is tracked in
  [docs/HARDWARE_VALIDATION.md](docs/HARDWARE_VALIDATION.md) with explicit
  Implemented / Partial / Design-only markers.


---

<!-- SVENKUNKKA-PROJECT-INFO:BEGIN -->

<a id="project-overview-zh"></a>
## 中文项目说明

连接 AI 工具状态与 QMK/ZMK 键盘现有通信接口的跨平台桌面桥接工具。按设备实际能力映射灯光、指示和显示动作，提供协议识别、映射配置与写入审计。

**使用入口：** 运行 `npm install`、`npm run build`，再分别启动 `npm run simulate` 与 `npm run start -w app`；真实设备范围见 [兼容性说明](docs/COMPATIBILITY.md)。

**范围说明：** 默认只读，不自动刷固件；没有已验证控制配置的 Raw HID 设备保持只读，模拟器不证明真实硬件兼容。

<a id="project-overview-en"></a>
## English project overview

A cross-platform desktop bridge between AI tool states and communication interfaces already exposed by QMK/ZMK firmware. It maps events to actual lighting, indicator and display capabilities, with protocol identification, configuration and write auditing.

**Getting started:** Run `npm install` and `npm run build`, then start `npm run simulate` and `npm run start -w app` in separate terminals. See the [compatibility guide](docs/COMPATIBILITY.md) for devices.

**Scope:** Read-only by default and does not flash firmware. Raw HID devices without a verified control profile remain read-only; simulation does not prove hardware compatibility.

**仓库维护者 / Repository maintainer:** [SvenKunkka](https://github.com/SvenKunkka) · [X / Twitter](https://x.com/Svenu1s5)

<!-- SVENKUNKKA-PROJECT-INFO:END -->
