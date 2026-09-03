# PROTOCOLS (round-15)

This document describes every protocol the software can speak, what the
protocol actually defines, and what it does **not** define. Every entry cites
its official source. Capability status per protocol is listed here and
enforced by the [Capability Model](CAPABILITY_MODEL.md).

Legend for implementation status:

| Marker | Meaning |
|---|---|
| Implemented | code exists and is exercised by tests |
| Partially implemented | some parts implemented; others design-only |
| Tested with simulator | verified against the TCP virtual keyboard |
| Tested with physical hardware | verified against a real keyboard |
| Design only | not implemented yet |
| Not supported by upstream protocol | the protocol does not define this |

---

## 1. QMK Raw HID (transport)

Official source: https://docs.qmk.fm/features/rawhid
(spec text: qmk/qmk_firmware `docs/feature_rawhid.md`)

What the protocol defines:

- HID Usage Page `0xFF60`, Usage ID `0x61` by default
  (`RAW_USAGE_PAGE` / `RAW_USAGE_ID` in `config.h`).
- HID reports fixed at `RAW_EPSIZE` = **32 bytes** in both directions.
- Bidirectional byte transfer only.

What it does **not** define: no RGB, no OLED, no keymap, no AI control —
nothing beyond a byte pipe.

Software behavior:

- An interface at 0xFF60/0x61 is classified `qmk-rawhid-looking`,
  `transport-available`, `capabilities-unknown`.
- **No** AKP HELLO is expected, **no** probe packets are ever sent, and no
  "firmware incompatible" verdict exists.
- Zero writes until a verified control profile matches (VIA, Vial, AKP
  extension, vendor protocols).

Implementation status: **Implemented, Tested with simulator.** Physical
hardware enumeration verified on macOS (generic read-only test); open/read
still to be validated against a real QMK keyboard.

## 2. VIA

Official sources: https://www.caniusevia.com/docs/specification
(spec text: the-via/app `src/utils/keyboard-api.ts`, QMK `quantum/via.c` /
`quantum/via.h`)

What the protocol defines (32-byte Raw HID reports, `[cmd, data…]`):

- `GET_PROTOCOL_VERSION` (0x01) — `VIA_PROTOCOL_VERSION` 0x000D.
- Keyboard values (uptime, layout options, switch matrix state — read-only).
- Dynamic keymap: get/set keycodes, layer count, buffers, encoders.
- Custom values, EEPROM reset, bootloader jump, macros.

What it does **not** define: OLED text, AI-specific actions, approval input.

Software behavior:

- Profile matches only via the upstream VID/PID registry or explicit **user
  assignment** — usage 0xFF60/0x61 alone is never enough (every QMK Raw HID
  keyboard matches those).
- Identification = the protocol's own `GET_PROTOCOL_VERSION` handshake.
- Writes (dynamic keymap) only after the Capability Gate passes.

Capability status (see CAPABILITY_MODEL.md, round-16): only `runtime-keymap`
is declared supported (dynamic keymap writes). Lighting/haptics/matrix reads
are declared `unsupported` — the VIA lighting path is NOT implemented (it
would require a per-keyboard definition/profile for exact channel values).

Implementation status: **Implemented (identification + limited
runtime-keymap writes), Tested with simulator.** Hardware validation pending.
VIA provides NO AI lighting/OLED output path in this release.

## 3. Vial

Official sources: https://get.vial.today/ (spec text: vial-kb/vial-qmk
`quantum/vial.c` / `vial.h`)

What the protocol defines:

- All packets fixed at 32 bytes; `msg[0] = 0xFE` (Vial magic prefix),
  `msg[1] = command`.
- `get_keyboard_id` returns `VIAL_PROTOCOL_VERSION` (0x00000006) + keyboard
  UID + vialrgb flag; definitions, encoders, unlock flow, dynamic entries
  (tap dance / combos / key overrides), QMK settings.

What it does **not** define: OLED text, AI-specific actions, approval input.

Software behavior: same match policy as VIA (user-assigned or VID/PID
registry), identification via the 0xFE handshake, gated writes.

Capability status: `runtime-keymap` requires the keyboard definition JSON
(`requires-user-profile`); lighting requires firmware support.

Implementation status: **Partially implemented (identification), Tested with
simulator.** Vial keymap editing requires the definition JSON pipeline
(design-only).

## 4. ZMK Studio RPC

Official source: https://zmk.dev/docs/development/studio-rpc-protocol
(spec text: zmkfirmware/zmk `docs/docs/development/studio-rpc-protocol.md` +
zmkfirmware/zmk-studio-messages `proto/zmk/*.proto`)

What the protocol defines:

- Protobuf messages: `Request` (request_id + oneof core/behaviors/keymap),
  `Response` (`RequestResponse` | `Notification`).
- Framing: SoF `0xAB`, Esc `0xAC`, EoF `0xAD` with escaping.
- Transports: USB CDC-ACM serial; BLE GATT service
  `00000000-0196-6107-c967-c5cfb1c2482a` with one characteristic
  `00000001-0196-6107-c967-c5cfb1c2482a` (writes; GATT Indications to host).
- Core: get_device_info, get_lock_state, lock, reset_settings; lock state
  notifications.
- Keymap: get/set layer bindings, save/discard, move/add/remove/restore
  layers, physical layouts.
- Errors: meta `simple_error` (`UNLOCK_REQUIRED`, `RPC_NOT_FOUND`,
  `MSG_DECODE_FAILED`, `MSG_ENCODE_FAILED`).

What it does **not** define: RGB, backlight, OLED, haptics, key-event
streams, encoder streams, approval input, profile switch. **ZMK Studio
supporting runtime keymap does not mean it provides RGB or OLED control.**

Software behavior:

- BLE devices match by the official GATT service UUID; serial devices require
  user assignment.
- Identification = framed `get_device_info` request/response. If the firmware
  does not enable Studio, the UI shows **"Studio endpoint unavailable.
  Feature not enabled in current keyboard firmware."** — never "flash our
  firmware".

Capability status: `runtime-keymap` supported (requires unlock); everything
else unsupported by the upstream protocol.

Lock semantics (round-16, per zmk-studio-messages core.proto): core.Request
defines ONLY `lock` — there is **no unlock RPC**. Unlock is a physical action
on the keyboard; the host waits for `core.Notification.lock_state_changed`
(or polls `get_lock_state`). The adapter never sends an unlock RPC, writes
nothing while locked, and reports needsPhysicalUnlock.

Implementation status: **Framing + protobuf + identification + lock handling:
Implemented, Tested with simulator.** Real CDC-ACM / BLE round trips: Design
only / Partial — see HARDWARE_VALIDATION.md.

## 5. AKP Extension (optional extension)

Official source: this repository, [docs/ARCHITECTURE.md](ARCHITECTURE.md) —
the migrated custom protocol (previously a global gate, now an optional
adapter, compatibility matrix layer C).

What the protocol defines (32-byte Raw HID frames, messages: HELLO, CAPS,
HEARTBEAT, CMD, STATE, RGB, SCREEN, ACK, ERR, DICTATE, ENCODER, KEYEVENT,
LOG): status LED, RGB / per-key RGB, OLED text, encoder and key events,
approval inputs (F13–F24 / dedicated keys). Framing: 4-byte frame header
(magic 0xA5, flags, length, crc8) with fragmentation; messages carry a
2-byte crc16.

What it does **not** define: runtime keymap editing, backlight as a distinct
control, icons, haptics, profile switching.

Software behavior:

- The adapter waits for the device-initiated HELLO (zero writes during
  identification) and replies CAPS only after identification.
- Absence of HELLO → **protocol unknown, read-only** (never "incompatible").
- AKP never gates QMK, VIA, Vial or ZMK Studio adapters.

Implementation status: **Implemented, Tested with simulator.** Physical
hardware bidirectional test requires an AKP-enabled keyboard (firmware under
`firmware/`) — not yet verified.

## 6. Simulator (TCP)

The simulator transport + adapter (`packages/simulator/`, mode `simulator`)
for end-to-end tests and demos. Simulator results never substitute for real
protocol verification.
