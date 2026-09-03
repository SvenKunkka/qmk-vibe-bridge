# Release Validation (round-15)

How this release was validated, what was NOT validated, and the layer model.

## Layers

| Layer | Meaning |
|---|---|
| LOCAL | everything run on this macOS machine |
| PACKAGED | the packaged .app / dmg artifacts |
| HARDWARE | real keyboards |
| CLOUD | CI runners (Windows / Linux) |

## Acceptance matrix (round-15, all 18 items)

| # | Item | Where | Status |
|---|---|---|---|
| 1 | QMK Raw HID-looking interface → transport-available | simulator acceptance A1 | ✔ |
| 2 | no AKP HELLO → never "firmware incompatible" | simulator acceptance A2 | ✔ |
| 3 | unknown Raw HID write count strictly 0 | simulator acceptance A3 + e2e + scripts/unknown-rawhid-readonly-test.ts | ✔ |
| 4 | writes only after matching a verified profile | simulator acceptance A4 | ✔ |
| 5 | Capability Gate rejects undeclared capabilities | core gate.test.ts + acceptance A5 | ✔ |
| 6 | AKP as optional adapter handshakes independently | simulator acceptance A6 | ✔ |
| 7 | AKP handshake result does not affect other adapters | simulator acceptance A7 | ✔ |
| 8 | ZMK Studio framing encode/decode | core zmk-studio.test.ts (escaping, stream, malformed) | ✔ |
| 9 | ZMK Studio protobuf messages | core zmk-studio.test.ts (device info, lock, error, keymap) | ✔ |
| 10 | USB Serial Transport boundary | core transports.test.ts | ✔ |
| 11 | BLE UUIDs + transport boundary | core transports.test.ts | ✔ |
| 12 | BLE not hardware-verified → marked Partial | acceptance A12 + HARDWARE_VALIDATION.md | ✔ |
| 13 | multi-HID interfaces never misopened | core transports.test.ts + app hid-discovery.test.ts | ✔ |
| 14 | permission/denied + disconnect never flip to Ready | core transports.test.ts | ✔ |
| 15 | default English | core i18n.test.ts + acceptance A15 + app DOM | ✔ |
| 16 | Chinese switch + persistence | acceptance A16 + app DOM | ✔ |
| 17 | AI Event → Capability Mapping simulated e2e | simulator acceptance A17 + e2e | ✔ |
| 18 | connected test keyboard → generic read-only only | scripts/unknown-rawhid-readonly-test.ts (no profile, no conclusion, 0 writes) | ✔ (see below) |

## Commands & exit codes (this round, LOCAL)

| Command | Tests | Exit |
|---|---|---|
| `npm run typecheck` | all workspaces TS | 0 |
| `npm run test -w packages/akp-codec` | 21 | 0 |
| `npm run test -w packages/core` | 46 | 0 |
| `npm run test -w packages/simulator` | 13 (incl. 11 acceptance) | 0 |
| `npm run test -w app` | 11 (DOM + HID discovery) | 0 |
| `npm run test` (root) | 91 total | 0 |
| `npm run build` | all workspaces + app bundle | 0 |
| `npm run acceptance` | scripts/acceptance.sh (full pipeline) | 0 |
| `npx tsx scripts/unknown-rawhid-readonly-test.ts` | generic zero-write | 0 or SKIPPED |

## Packaged / smoke layer (PACKAGED)

- macOS packaging: `npm run pack:mac` (electron-builder `--mac dir`).
- packaged smoke: run the packaged binary with `--smoke-test` (headless
  acceptance: unknown Raw HID zero-write, AKP optional adapter, VIA
  identification, ZMK Studio framing + lock, locale persistence).
- packaged UI smoke: `--ui-smoke-test` loads the real renderer through real
  IPC and asserts English default + Chinese switch/persistence DOM states.
- dual-launch: `scripts/dual-launch-test.sh` starts two isolated instances
  and asserts the single-instance lock and independent user-data.

## HARDWARE layer (this round)

- Generic read-only verification against whatever Raw HID interface is
  connected (enumeration + zero-write contract). No control profile is ever
  created, no product conclusion is drawn, no data is sent.
- **Nothing else is claimed as hardware-verified.** VIA / Vial / ZMK Studio /
  AKP bidirectional tests require real devices — see HARDWARE_VALIDATION.md.

## CLOUD layer

- **No Windows/Linux artifacts are claimed as verified.** No CI runner has
  completed in this round; any claim would be fabricated.

## Round-16 fixes (independent review)

| Bug | Fix | Regression tests |
|---|---|---|
| P1-1 ZMK Studio fake unlock | unlock is now a zero-write waiting state; only explicit `lock` sends the core.lock RPC; physical unlock (lock_state_changed notification) gates keymap ops (official core.proto has no unlock RPC) | core zmk-studio.test.ts (4) + simulator acceptance (1) + app smoke |
| P1-2 bare QMK Raw HID status misreport | qmk-rawhid identifies as `transport-only` → capabilitiesKnown=false, status stays transport-available, UI shows the read-only banner (never "protocol identified") | core transports.test.ts (1) |
| P1-3 VIA capability/implementation drift | unimplemented capabilities declared `unsupported`; acceptance check: every declared supported/read-only/requires-* capability has an adapter handler | core profiles.test.ts (2) |
| P1-4 non-AKP AI output honesty | compat matrix + capability model state VIA/ZMK provide NO AI lighting/OLED path; only simulator + akp-extension do | docs + matrix |
| P2-5 VIA set-keycode fake success | roundTrip waits for and validates the echo (cmd + layer/row/col/keycode); timeout/mismatch fails honestly | core via.test.ts (6) |
| P2-6 policy=ask fake | real confirmation: one-time, payload-bound, expiring tokens; UI confirmation panel; zero writes until confirmed | core confirmation.test.ts (4) |
| P2-7 UI enumeration noise | default list only shows strict Raw HID / known profiles / ZMK CDC-GATT / explicit; "show all interfaces" diagnostic off by default | core transports.test.ts (4) |

## Explicitly NOT done

- No keyboard was flashed.
- Nothing was pushed to GitHub; no public release was created.
