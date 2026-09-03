# Hardware Validation (round-15)

Status of every capability vs real hardware. The honest marker set:

- **Implemented** — code exists and is exercised by automated tests.
- **Partially implemented** — some parts implemented.
- **Tested with simulator** — verified against the TCP virtual keyboard.
- **Tested with physical hardware** — verified against a real keyboard.
- **Design only** — not implemented yet.
- **Not supported by upstream protocol** — cannot exist on that protocol.

## Transport layer

| Transport | Status | Notes |
|---|---|---|
| USB HID / Raw HID | **Implemented; enumeration tested with physical hardware on macOS; open/read not yet verified against a real QMK keyboard** | `node-hid`; exact-path open; 0xFF60/0x61 validated; 0x00 report-id prefixing |
| USB CDC-ACM serial | **Implemented; Tested with simulator** | fake-driver boundary tests; real serialport driver design-only |
| BLE GATT | **Design only / PARTIAL** | official ZMK Studio UUIDs implemented; no real BLE host round trip yet — must stay Partial until one completes |
| TCP simulator | **Implemented; Tested with simulator** | virtual keyboards in 5 modes |

## Protocol adapters

| Adapter | Status | Notes |
|---|---|---|
| qmk-rawhid | **Implemented; Tested with simulator; hardware enumeration verified** | zero writes by construction |
| via | **Implemented (identification + dynamic keymap set); Tested with simulator** | real keyboard needed |
| vial | **Partially implemented (identification); Tested with simulator** | definition-JSON pipeline design-only |
| zmk-studio | **Implemented (framing/protobuf/identify/lock); Tested with simulator** | real Studio device needed |
| akp-extension | **Implemented; Tested with simulator** | needs an AKP-enabled keyboard (firmware in `firmware/`) for bidirectional test |

| simulator | **Implemented; Tested with simulator** | never substitutes for real verification |

## What a next hardware session must verify

| Item | Required device / firmware condition |
|---|---|
| Raw HID open + read | any QMK keyboard with `RAW_ENABLE = yes` (0xFF60/0x61) |
| VIA end-to-end | a VIA-enabled QMK keyboard (dynamic keymap) |
| Vial end-to-end | a Vial-enabled keyboard (0xFE handshake + definition) |
| ZMK Studio over USB | a ZMK keyboard with `CONFIG_ZMK_STUDIO=y` (CDC-ACM) |
| ZMK Studio over BLE | same, with the Studio GATT service advertised |
| AKP extension | a keyboard flashed with `firmware/qmk` or `firmware/zmk` module (optional extension) |
| Permission/denied paths | macOS without Accessibility/FDA grants |

None of the above has been performed in this round; nothing in this document
claims otherwise. The generic read-only verification
(`scripts/unknown-rawhid-readonly-test.ts`) runs against whatever Raw HID
interface is connected and asserts the zero-write contract only.
