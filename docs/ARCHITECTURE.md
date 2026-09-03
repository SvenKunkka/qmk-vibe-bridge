# Architecture (round-15)

## Layered pipeline

```
┌──────────────┐   ┌──────────────┐   ┌────────────────┐   ┌────────────────┐
│ AI Event     │ → │ AI Event     │ → │ Mapping Engine │ → │ Capability     │
│ Provider     │   │ Normalizer   │   │                │   │ Gate           │
│  simulator   │   │ (canonical   │   │ (AI state →    │   │ (8-step write  │
│  codex/dsh/  │   │  AiEvent)    │   │  capability    │   │  guard)        │
│  claude      │   └──────────────┘   │  ops)          │   └───────┬────────┘
└──────────────┘                      └────────────────┘           │ allowed
                                                                    ▼
                                          ┌───────────────────────────────────┐
                                          │ Protocol Adapter (per device)     │
                                          │  qmk-rawhid │ via │ vial │        │
                                          │  zmk-studio │ akp-extension │     │
                                          │  simulator                        │
                                          └───────────────┬───────────────────┘
                                                          ▼
                                          ┌───────────────────────────────────┐
                                          │ Transport (byte stream only)      │
                                          │  usb-hid │ usb-cdc-acm │ ble-gatt │
                                          │  tcp-simulator                     │
                                          └───────────────┬───────────────────┘
                                                          ▼
                                                  Keyboard (QMK / ZMK)
```

Rules that shape every layer:

- **Transports** discover, open, read, write and disconnect — they never
  interpret business commands.
- **Adapters** own protocol identification, capability declaration,
  encode/decode, payload validation, error handling and their own lifecycle.
  No adapter is a global connection gate for any other device.
- **Capabilities** are declared per adapter+device; protocols that do not
  define a capability must say `unsupported`/`unknown` — never fake support.
- **The gate** is the single write authority: default behavior is read-only.

## Modules

### `packages/core/src/ai/`
- `types.ts` — `AiEvent` + `AiEventProvider` (the AI side is fully decoupled).
- `normalizer.ts` — canonicalizes provider observations (and legacy names).
- `hub.ts` — `AiEventHub`: provider registry, active source, fan-out.
- `providers/simulator.ts` — virtual agent (SIMULATED events only).
- `providers/agent-source.ts` — wraps the DSH / Codex / Claude Code log
  watchers into providers (simulated=false, confidence-scored).

### `packages/core/src/transports/`
- `types.ts` — `DeviceTransport` (open/close/write/setHandlers, `exactPath`,
  `mtu`) + `TransportCandidate` + `NullTransport` (test double).
- `hid.ts` — Raw HID transport with strict open policy: exact path required,
  usage page **and** usage id validated (0xFF60/0x61), 32-byte reports,
  report-id 0x00 prefixing handled by the app-layer driver.
- `serial.ts` — USB CDC-ACM serial transport (ZMK Studio over USB).
- `ble.ts` — BLE GATT transport with the official ZMK Studio service /
  characteristic UUIDs. **DESIGN/PARTIAL** until verified on real hardware.
- `tcp.ts` — length-prefixed TCP transports for the simulator.

### `packages/core/src/adapters/`
- `types.ts` — `ProtocolAdapter` interface (`identify`, `apply`, `close`).
- `factory.ts` — profileId → adapter instance.
- `qmk-rawhid.ts` — transport-only adapter: capabilities unknown, **zero
  writes, no probes**.
- `via.ts` — VIA identification via GET_PROTOCOL_VERSION (cmd 0x01) and
  dynamic-keymap writes (gated).
- `vial.ts` — Vial identification via 0xFE + get_keyboard_id.
- `zmk-studio/` — `framing.ts` (SoF 0xAB / Esc 0xAC / EoF 0xAD), `protobuf.ts`
  (minimal proto3 codec), `messages.ts` (Request/Response/Notification,
  core+keymap subset), `index.ts` (adapter: identify via get_device_info,
  lock/unlock handling).
- `akp-extension/` — the migrated custom protocol as an **optional** adapter
  (`session.ts` = AKP session, `index.ts` = adapter). Never a global gate.
- `simulator.ts` — JSON protocol for the virtual keyboard.

### `packages/core/src/capabilities/`
- `model.ts` — the 12 capability ids + state union + `CapabilityOp`.
- `gate.ts` — the 8-step Capability Gate + payload validation.
- `audit.ts` — append-only `WriteAudit` (source of truth for write counts).

### `packages/core/src/profiles/`
- `types.ts` — the 17-field `ProtocolProfile` schema.
- `builtin.ts` — the six built-in profiles with official source URLs.
- `registry.ts` — interface → profile matching (usage-page / VID-PID registry
  / GATT service / user-assigned), plus user-assignment persistence.

### `packages/core/src/mapping/`
- `engine.ts` — AI event → capability ops with feasibility (declared state).

### `packages/core/src/devices/`
- `states.ts` — the 10-state ladder.
- `manager.ts` — enumerate → register → connect (open transport by exact
  path, run adapter identification) → applyOp (gate → adapter → audit).

### `packages/core/src/`
- `core.ts` — `ConsoleCore`: wires everything, AI event fan-out, IPC surface.
- `settings.ts`, `i18n.ts` — persistence (English default) + dictionaries.
- `keymap.ts`, `actions.ts` — key → action mapping and executor (unchanged).

### `packages/simulator/`
- `virtual-keyboard.ts` — TCP virtual keyboards: modes `akp`,
  `unknown-rawhid`, `via`, `zmk-studio`, `simulator`.
- `virtual-agent.ts` — TCP virtual agent (authoritative scripted states).
- `cli.ts` — `vibebridge-sim [keyboard|agent|scenario|all] [--mode MODE]`.

### `app/` (Electron)
- `src/main/index.ts` — window, IPC, simulator hosting, smoke tests.
- `src/main/hid.ts` — node-hid driver (exact-path open, 0x00 report id),
  enumerator + opener injected into the core.
- `src/preload/preload.ts` — context-isolated API.
- `src/renderer/` — English-default UI (Agent / Devices / Pending ops /
  Write audit / Settings).

### `firmware/`
Optional AKP extension modules for QMK and ZMK (compatibility matrix layer C).
They exist so the optional extension can be built by users who want it — the
desktop software neither flashes them nor requires them.

## Key flows

**Enumerate** → `DeviceManager.refresh()` collects `TransportCandidate`s from
injected enumerators; each becomes a `hardware-detected` device with a
`ProfileMatch[]` from the registry.

**Connect** → user picks an interface (and optionally a profile) →
`connect(id, profileId?)` opens the transport by exact path, instantiates the
adapter, runs `identify()` (protocol-defined handshake only), and computes the
status: identified + any `supported` capability → `ready`; identified but only
user-profile/extension capabilities → `limited`; identification failed →
`transport-available` with the read-only banner (never "incompatible").

**AI event** → `dispatchAiEvent` maps the event against each device's declared
capabilities, emits the "pending operations" view, and applies feasible ops
through the gate. The gate decides; the audit records everything.
