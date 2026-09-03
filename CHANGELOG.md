# Changelog

## Unreleased

- Added the hardware-verified Keychron K10 Max ANSI RGB task-row integration.
- F1-F8 indicate and focus recent Codex tasks; F9-F12 indicate and focus recent
  DeepSeek Harness tasks in the installed standalone Chrome app.
- Added the matching QMK keymap, host controller, DSH focus plugin, tests, pure
  maximum-brightness HSV status palette, and strict non-F-row blackout.
- Verified the K10 keymap with the current Keychron QMK toolchain and verified
  the live device as VIA protocol `0x000c`, Keychron RGB protocol `1.0`, with
  108 LEDs. The broader compatibility claims below remain unchanged.

## 0.9.0 (round-17)

**Round-15 (requirements reset)** — layered architecture
(AI Event Provider → Normalizer → Mapping → Capability Gate → Adapter →
Transport); AKP demoted to an optional adapter; DP-104/Glacier-specific logic
removed; read-only default; QMK Raw HID 0xFF60/0x61 detection; ZMK Studio
framing/protobuf; Profile registry; English-default i18n.

**Round-16 (independent review fixes)** — ZMK Studio unlock is physical-only
(no fake unlock RPC); bare Raw HID reports transport-only (never
protocol-identified); VIA/Vial capability declarations match implementations;
VIA set-keycode echo-verified; ask-policy real one-time confirmation; default
interface filtering with a diagnostic "show all" switch.

**Round-17 (this release)** — Protocol Evidence table
(`docs/PROTOCOL_EVIDENCE.md`); extensible Profile/Definition registry with
VIA definition import (schema validation, size limits, prototype-pollution
guard, SHA-256 pinning, preview); **real non-AKP AI indicator output**: VIA
lighting (rgblight / rgb_matrix / backlight channels) with official commands,
channel probing, echo + readback verification, and sent-unverified semantics;
**local Agent Provider API** (127.0.0.1 HTTP + SSE, token auth with secure
storage, idempotency, rate limits, conflict policies, SDK examples); master
"Disable all writes" switch (ON by default); 8-page UI; cross-platform
GitHub Actions (macOS/Windows/Linux matrix, draft-only releases, per-platform
manifests).

## Status

- **Software side**: fully implemented and locally verified (113→N tests).
- **Hardware**: only generic unknown-Raw-HID zero-write verified; VIA/ZMK
  Studio/AKP real-device flows NOT verified (honest).
- **Cloud**: GitHub Actions workflows prepared; verify the public `main` run
  separately after publication.
