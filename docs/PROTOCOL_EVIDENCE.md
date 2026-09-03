# Protocol Evidence Table (round-17)

This file records, for every protocol the software speaks, the **official
source**, **version/commit**, **command numbers**, **direction**, **length**,
**response semantics** and **limitations**. No capability is implemented from
memory or guesswork; anything not evidenced here is marked `experimental` and
defaults to no-write.

Legend: `→` = host→device, `←` = device→host.

---

## 1. QMK Raw HID

- Source: QMK Firmware `docs/feature_rawhid.md` (master).
  https://docs.qmk.fm/features/rawhid
  https://github.com/qmk/qmk_firmware/blob/master/docs/feature_rawhid.md
- Defaults (config.h): `RAW_USAGE_PAGE` = `0xFF60`, `RAW_USAGE_ID` = `0x61`.
- Report length: fixed `RAW_EPSIZE` = **32 bytes** both directions ("all
  reports in both directions must be exactly RAW_EPSIZE (currently 32) bytes
  long").
- Direction: bidirectional byte pipe; `raw_hid_receive(data, length)` fires
  on host→device reports; `raw_hid_send()` device→host.
- Limitations: defines **no** control semantics (no RGB/OLED/keymap). It is a
  transport only. Detection of `0xFF60/0x61` ⇒ `qmk-rawhid-looking`,
  `transport-available`, `capabilities-unknown`; **zero writes** until a
  verified profile matches.
- Host-side requirement from the doc: filter on usage page AND usage id to
  avoid opening keyboard/mouse/media interfaces; open the interface, not the
  whole device.

---

## 2. VIA

- Firmware source: QMK `quantum/via.h` + `quantum/via.c` (master).
  https://github.com/qmk/qmk_firmware/blob/master/quantum/via.h
  https://github.com/qmk/qmk_firmware/blob/master/quantum/via.c
- App source: the-via/app `src/utils/keyboard-api.ts`, `keyboard-values.ts`.
  https://github.com/the-via/app/blob/main/src/utils/keyboard-api.ts
- Spec: VIA Version 3 Specification (keyboard definitions).
  https://www.caniusevia.com/docs/specification
- `VIA_PROTOCOL_VERSION` = `0x000D` (via.h). Firmware version is per-keyboard.
- Wire: 32-byte Raw HID report; QMK `raw_hid_receive` treats `data[0]` as
  command id, `data[1..]` as data (`via.c`).
- Commands (`enum via_command_id`, via.h):
  - `id_get_protocol_version` = `0x01` → ← returns `[0x01, hi, lo]`
    (version big-endian at data[1..2]).
  - `id_get_keyboard_value` = `0x02` (uptime, layout options, switch matrix
    state — read-only).
  - `id_set_keyboard_value` = `0x03`.
  - `id_dynamic_keymap_get_keycode` = `0x04`, `…_set_keycode` = `0x05`
    (payload `[layer, row, col, keycode hi, keycode lo]`).
  - `id_dynamic_keymap_reset` = `0x06`; `id_custom_set_value` = `0x07`;
    `id_custom_get_value` = `0x08`; `id_custom_save` = `0x09`;
    `id_eeprom_reset` = `0x0A`; `id_bootloader_jump` = `0x0B`; macros
    `0x0C–0x10`; dynamic keymap layer count `0x11`, buffers `0x12/0x13`,
    encoders `0x14/0x15`.
  - Unknown command → response `command_id = 0xFF` (`id_unhandled`, via.c).
- Channels (`enum via_channel_id`): custom `0`, **backlight `1`,
  rgblight `2`, rgb_matrix `3`**, audio `4`, led_matrix `5`.
- Lighting value ids (`via.h`):
  - backlight: brightness `1`, effect `2`.
  - rgblight / rgb_matrix: brightness `1`, effect `2`, effect_speed `3`,
    color `4`.
- Lighting wire format (`via.c` `via_qmk_*_command`, data =
  `[command_id, channel_id, value_id, value_data…]`):
  - Set: `→ [0x07, channel, value_id, value_data…]`.
    - rgblight color: `[0x07, 2, 4, hue, sat]` (HSV; value preserved).
    - rgb_matrix color: `[0x07, 3, 4, hue, sat]`.
    - rgblight brightness: `[0x07, 2, 1, level(0–255)]`.
    - backlight brightness: `[0x07, 1, 1, level(0–255)]`.
  - Read back (verification): `→ [0x08, channel, value_id]` →
    `← [0x08, channel, value_id, value_data…]` (e.g. color returns hue,sat).
  - Save: `→ [0x09, channel]`.
  - If the firmware does not compile that channel, the response carries
    `command_id = 0xFF` (unhandled) — this is the official "channel not
    supported" signal and is how per-device lighting support is probed.
- Echo semantics (the-via/app `_hidCommand`): the response must begin with
  the command bytes (`buffer.slice(0, commandBytes.length-1)` equals
  `commandBytes.slice(1)`); otherwise the app throws "Receiving incorrect
  response for command".
- Definition (v3 spec): JSON with `name`, `vendorId`, `productId`, `matrix`,
  `layouts`, `labels`, `customKeycodes`, `menus`… The spec does **not**
  declare a lighting property — lighting support lives in the firmware and is
  discovered by probing channels (above). Definitions gate identity, not
  lighting truth.
- Limitations: no OLED text, no AI-specific actions, no approval input.

---

## 3. Vial

- Source: vial-kb/vial-qmk `quantum/vial.h` + `vial.c` (master).
  https://github.com/vial-kb/vial-qmk/blob/master/quantum/vial.h
  https://github.com/vial-kb/vial-qmk/blob/master/quantum/vial.c
  Docs: https://get.vial.today/
- `VIAL_PROTOCOL_VERSION` = `0x00000006`; `VIAL_RAW_EPSIZE` = 32.
- Wire: all packets fixed 32 bytes; `msg[0] = 0xFE` (Vial magic prefix),
  `msg[1] = command` (vial.c `vial_handle_cmd`).
- Commands (`vial.h`): `vial_get_keyboard_id` `0x00` (→ returns
  `[0xFE, 0x00, version u32 LE, keyboard UID 8B, vialrgb flag]`),
  `vial_get_size` `0x01`, `vial_get_def` `0x02`, encoders `0x03/0x04`,
  `vial_get_unlock_status` `0x05`, `vial_unlock_start` `0x06`,
  `vial_unlock_poll` `0x07`, `vial_lock` `0x08`, qmk settings `0x09–0x0C`,
  dynamic entries `0x0D`.
- Unlock: the Vial unlock flow requires a **physical action on the keyboard**
  (unlock_start/poll); there is no remote unlock.
- Limitations: keymap editing needs the keyboard definition JSON
  (get_def); lighting (vialrgb) needs firmware support. Nothing here is
  implemented beyond identification in this release (declared unsupported).

---

## 4. ZMK Studio RPC

- Source: ZMK Firmware `docs/docs/development/studio-rpc-protocol.md` (main).
  https://zmk.dev/docs/development/studio-rpc-protocol
  https://github.com/zmkfirmware/zmk/blob/main/docs/docs/development/studio-rpc-protocol.md
- Messages: zmk-studio-messages `proto/zmk/studio.proto`, `core.proto`,
  `keymap.proto`, `behaviors.proto`, `meta.proto` (main).
  https://github.com/zmkfirmware/zmk-studio-messages
- Framing: SoF `0xAB`, Esc `0xAC`, EoF `0xAD`; special bytes inside the
  payload are escaped with Esc.
- Transports:
  - USB: CDC-ACM serial ("basic serial/UART transport … usually used with
    CDC ACM devices over USB").
  - BLE: GATT service `00000000-0196-6107-c967-c5cfb1c2482a`, one
    characteristic `00000001-0196-6107-c967-c5cfb1c2482a`; client writes
    framed messages, device uses GATT Indications.
- `core.proto` (exact, round-17 evidence):
  - `core.Request` oneof: `get_device_info`=1, `get_lock_state`=2,
    `lock`=3, `reset_settings`=4. **There is NO unlock RPC.** Unlock is a
    physical action on the keyboard.
  - `core.Response` oneof: `get_device_info`=1 (name, serial_number),
    `get_lock_state`=2 (LockState: LOCKED=0, UNLOCKED=1), `reset_settings`=4.
  - `core.Notification` oneof: `lock_state_changed`=1 (LockState).
- `keymap.proto`: get_keymap, set_layer_binding, check/save/discard changes,
  physical layouts, move/add/remove/restore layers, set_layer_props.
- `meta.proto`: `simple_error` codes: GENERIC=0, UNLOCK_REQUIRED=1,
  RPC_NOT_FOUND=2, MSG_DECODE_FAILED=3, MSG_ENCODE_FAILED=4.
- Limitations: **no RGB, no backlight, no OLED, no haptics, no key/encoder
  event streams, no approval input, no profile switch** in Studio RPC.
  Runtime keymap ≠ generic RGB/OLED control. If firmware does not enable
  Studio: endpoint unavailable (UI text, no "flash our firmware").

---

## 5. AKP Extension (this project, optional)

- The migrated custom protocol, now an optional adapter (compatibility layer
  C). Framing: 32-byte Raw HID frames, frame header magic `0xA5`,
  flags/length/crc8, fragmentation; messages magic `0x4B`, crc16; message
  types HELLO/CAPS/HEARTBEAT/CMD/STATE/RGB/SCREEN/ACK/ERR/DICTATE/ENCODER/
  KEYEVENT/LOG (see `packages/akp-codec/`).
- Identification = device-initiated HELLO; absence ⇒ protocol unknown,
  read-only. Never a gate for other protocols.

---

## 6. Platform: Electron / node-hid / serial / BLE

Evidence is from node-hid, serialport, Electron and platform docs plus this
repo's own test runs:

- **node-hid (macOS)**: IOKit; opening a HID path can fail with
  `0xE00002C1` privilege violation when the process lacks USB/IOKit
  entitlement — observed on this machine; mapped to `permission-denied`.
  Reports written via node-hid need a report-id prefix byte (`0x00` for
  report-id 0) — used by our driver.
- **node-hid (Windows)**: requires a WinUSB/libusb driver for the target
  interface; keyboards with the default HID driver may need Zadig (user
  action, documented). Not verified locally.
- **node-hid (Linux)**: access to `/dev/hidraw*` requires udev rules or the
  user to be in the `plugdev`/`input` group; the repo ships a udev rule
  template that the user must install explicitly.
- **serialport (CDC-ACM)**: macOS `tty.usbmodem*`/`cu.*`; Linux
  `/dev/ttyACM*` (dialout group); Windows COM ports. Driver is injected and
  not yet bound to a real backend (Design).
- **BLE GATT**: no cross-platform native BLE host is wired in this release;
  ZMK Studio GATT UUIDs are implemented and boundary-tested with a fake
  driver (Partial). A real round trip requires a Bluetooth-capable machine +
  a ZMK Studio device (Not Verified).
- **Electron packaging**: electron-builder; macOS codesigning requires a
  Developer ID cert (ad-hoc = "unsigned/not notarized"); Windows NSIS needs
  no cert for unsigned builds (SmartScreen warning); Linux AppImage needs no
  cert. Windows/Linux artifacts are built and verified by GitHub Actions
  runners only (CLOUD NOT RUN until the workflow runs).
