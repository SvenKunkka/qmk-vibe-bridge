# Security (round-15)

## Default behavior: read-only

The default write policy is **read-only**. Fresh installs never write to any
device. Every write must pass all eight gates in order:

1. **Exact interface matched** — the transport is bound to a precise endpoint
   (HID path / serial device / GATT UUID / TCP address). A transport without
   an exact path refuses to open.
2. **Protocol Adapter identified** — the device has an adapter whose
   identification succeeded.
3. **Profile version matched** — the matched profile carries a version
   (observed on the wire where the protocol reports one).
4. **Capability explicitly declared** — the op's capability must be declared
   `supported` (or `read-only` for reads). `unsupported` and `unknown` are
   refused. Capabilities are never guessed.
5. **Capability Gate allows** — the current write policy (read-only / ask /
   allow) permits the op.
6. **Payload structure & length validated** — e.g. colors in 0..255, text
   bounded, per-op schema checks.
7. **User policy allows** — writes must be explicitly enabled for the
   device+profile combo (Settings → write policy + per-device enable).
8. **Write audit recorded** — every attempt (allowed or blocked) is appended
   to the audit log; writes that reach a transport increment the device's
   write counter.

## Hard prohibitions

- **No VID/PID blind-open.** Interfaces are opened by exact path only; the
  Raw HID resolver validates BOTH usage page (0xFF60) and usage id (0x61) and
  refuses keyboard/mouse/media interfaces.
- **No probe packets to unknown Raw HID endpoints.** A 0xFF60/0x61 interface
  with no verified profile receives zero bytes.
- **No fallback to other HID interfaces.** If a write/identify fails on one
  interface, the manager never tries another interface of the same device.
- **No "firmware incompatible" verdicts.** A device that does not answer a
  handshake is "protocol unknown" and stays read-only.
- **No auto-flashing.** The software never flashes firmware.

## Unknown devices

Unknown devices, unknown protocols and unknown versions stay at **zero
writes** regardless of the write policy setting (the gate refuses at step 4
for `unknown` capabilities).

## Audit

`packages/core/src/capabilities/audit.ts` — append-only log. The UI shows the
target device, exact interface, transport, adapter, profile, known/unknown
capabilities, the pending operation, recent writes and the reason for every
blocked op. Test assertions read `WriteAudit.countWrites()` as the source of
truth for zero-write guarantees.

## Permissions

- macOS: opening HID interfaces may surface IOKit privilege errors; those are
  mapped to the `permission-denied` terminal state — never to `ready`, and
  never auto-reconnected.
- The executor (keystroke macros) requires macOS Accessibility permission;
  the default executor is "log only" for headless/smoke runs.
