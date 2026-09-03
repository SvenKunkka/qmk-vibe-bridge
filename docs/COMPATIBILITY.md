# Compatibility (round-15)

Three tiers. The software never flashes firmware, never requires firmware
changes, and never claims blanket support.

## Tier A — no firmware changes needed

Keyboards whose **current firmware already provides a verified protocol**
(VIA, Vial, ZMK Studio, or a documented vendor protocol) can be connected
directly for the capabilities that protocol defines:

| Protocol | Works out of the box when | Capabilities |
|---|---|---|
| VIA | keyboard exposes 0xFF60/0x61 + VIA protocol, with a **bound definition** | **protocol identification + runtime-keymap writes + lighting (rgblight / rgb_matrix / backlight channels) with official commands, channel probing, echo+readback verification** (round-17). No OLED text, no haptics |
| Vial | keyboard exposes 0xFF60/0x61 + Vial magic (0xFE) | **identification only** (round-16); keymap editing and lighting not implemented |
| ZMK Studio | firmware enables ZMK Studio over USB CDC-ACM or BLE GATT | runtime keymap (unlock is a PHYSICAL action on the keyboard; host waits for lock_state_changed) |

**The user must already have enabled these features in their firmware.** This
software will not flash or enable them.

## Tier B — depends on the keyboard's existing firmware configuration

| Feature | Condition |
|---|---|
| QMK Raw HID transport | `RAW_ENABLE = yes` in the keyboard's firmware |
| VIA / Vial | VIA/Vial enabled in the firmware |
| ZMK Studio | `CONFIG_ZMK_STUDIO=y` in the firmware |
| RGB / OLED / etc. via the above | the protocol defines it AND the firmware enables it |

If the condition is not met, the UI says exactly that (e.g. "Studio endpoint
unavailable. Feature not enabled in current keyboard firmware.") — it never
says "flash our firmware to continue".

## Tier C — optional extensions

Capabilities that no standard protocol exposes (AI-specific RGB animations,
OLED text for agent state, dedicated approval keys, custom icons, complex
bidirectional state sync) can be provided by optional extensions:

- The **AKP extension** (firmware modules under `firmware/`, desktop adapter
  `akp-extension`) is the project's own optional extension. It belongs to
  this tier only.
- Vendor or community extensions can be added as new profiles/adapters via
  [ADAPTER_DEVELOPMENT.md](ADAPTER_DEVELOPMENT.md).

## What is NOT claimed

- All QMK keyboards are supported.
- All ZMK keyboards are supported.
- Any keyboard needs this project's firmware to be safe to use (it stays
  read-only without a verified profile).
- Simulator passes prove keyboard compatibility.
- **ZMK Studio can drive AI lighting/OLED output.** Studio RPC defines no
  RGB/OLED — that remains unsupported (UI text: "Upstream Studio protocol
  does not expose AI lighting on this firmware").
- **VIA lighting is implemented (round-17)** but requires a bound definition
  and a firmware that compiles the channel (official probe). Without either,
  it stays read-only/unsupported. This is a REAL non-AKP AI indicator output
  path — verified on the virtual device + fake transports, NOT yet on real
  hardware.

## Support status

See [HARDWARE_VALIDATION.md](HARDWARE_VALIDATION.md) for what has been
verified on real hardware and [RELEASE_VALIDATION.md](RELEASE_VALIDATION.md)
for the acceptance runs.
