# Capability Model (round-15)

The unified vocabulary every Protocol Adapter uses to declare what a device
can do. A capability that a protocol does not define must be declared
`unsupported` or `unknown` — **never** simulated as supported.

## Capability ids

| id | meaning |
|---|---|
| `read-key-event` | receive key events from the keyboard |
| `read-encoder-event` | receive encoder (knob) events |
| `set-indicator` | set a status indicator / LED |
| `set-rgb` | set RGB lighting (global) |
| `set-rgb-matrix` | set per-key RGB |
| `set-backlight` | set backlight |
| `display-text` | show text on a display (OLED) |
| `display-icon` | show icons on a display |
| `haptic` | haptic feedback |
| `runtime-keymap` | change keymap at runtime |
| `approval-input` | approve/reject controls for agent workflows |
| `profile-switch` | switch keyboard profiles |

## Capability states

| state | meaning |
|---|---|
| `supported` | the adapter can perform this now (subject to the gate) |
| `unsupported` | the upstream protocol does not define it |
| `unknown` | cannot be determined without more information |
| `read-only` | available for reading only, never written |
| `requires-user-profile` | needs the user to assign/confirm a profile or supply data (e.g. a Vial definition) |
| `requires-optional-extension` | needs the optional extension (e.g. AKP firmware) on the device |

## Declared states per protocol

| capability | qmk-rawhid | via | vial | zmk-studio | akp-extension | simulator |
|---|---|---|---|---|---|---|
| read-key-event | unknown | unsupported | unsupported | unsupported | supported | supported |
| read-encoder-event | unknown | unsupported | unsupported | unsupported | supported | supported |
| set-indicator | unknown | unknown | unknown | unsupported | supported | supported |
| set-rgb | unknown | requires-user-profile* | unknown | unsupported | supported | supported |
| set-rgb-matrix | unknown | requires-user-profile* | unsupported | unsupported | supported | supported |
| set-backlight | unknown | requires-user-profile* | unsupported | unsupported | unsupported | supported |
| display-text | unknown | unsupported | unsupported | unsupported | supported | supported |
| display-icon | unknown | unsupported | unsupported | unsupported | unsupported | supported |
| haptic | unknown | unsupported | unsupported | unsupported | unsupported | supported |
| runtime-keymap | unknown | supported | unsupported | supported | unsupported | supported |
| approval-input | unknown | unsupported | unsupported | unsupported | supported | supported |
| profile-switch | unknown | unsupported | unsupported | unsupported | unsupported | supported |

Notes:

- **QMK Raw HID** is a transport: it declares nothing, so everything is
  `unknown` and nothing is written.
- **VIA** (round-17): `runtime-keymap` implemented (dynamic keymap writes).
  Lighting (`set-rgb` → rgblight channel 2, `set-rgb-matrix` → rgb_matrix
  channel 3, `set-backlight` → backlight channel 1) is IMPLEMENTED with the
  official commands (via.c: set 0x07 / get 0x08 / save 0x09; unhandled 0xFF
  at byte 0) and becomes usable only after a **bound definition** + official
  **channel probe** — hence `requires-user-profile` (marked \*). Without a
  bound definition, lighting stays unusable. Haptics remain unsupported.
- **Vial** (round-16): identification only; keymap editing (needs the
  definition JSON) and lighting are NOT implemented — declared `unsupported`.
- **ZMK Studio** supports runtime keymap only; RGB/OLED/haptics are
  `unsupported` by the upstream protocol. Unlock is a **physical** action on
  the keyboard (core.proto has no unlock RPC); the host waits for
  `lock_state_changed` and writes nothing while locked.
- **AKP** (optional extension) supports the indicator/RGB/text/input family
  but not runtime keymap, backlight-as-distinct, icons, haptics or profile
  switching.
- **Consistency rule (round-16)**: a capability may only be declared
  `supported`/`read-only`/`requires-*` when the adapter has a real handler
  (enforced by an acceptance test); everything else must be `unsupported`
  or `unknown`.

## Enforcement

The [Capability Gate](SECURITY.md) refuses any op whose capability is not
declared `supported` (or `read-only` for reads). The Mapping Engine marks ops
infeasible when the declared state is anything else, and the UI shows the
reason.
