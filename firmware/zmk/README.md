> **Optional extension (compatibility matrix layer C).** This firmware module is optional: the desktop software never flashes it and never requires it. Keyboards without it simply stay read-only. See docs/COMPATIBILITY.md.

# AI Agent Console — ZMK module (AKP v1)

Standalone [ZMK module](https://zmk.dev/docs/features/modules) that turns a ZMK
keyboard into an AI Agent control console: **USB Raw HID + BLE (HOG)**, custom
**behaviors**, encoder, RGB underglow status colors and an OLED status widget.

The module is self-contained (transport + codec + behaviors) and speaks the
same **AKP v1** protocol as the QMK module and the desktop app.

## Features

| Feature | Implementation |
|---|---|
| USB Raw HID (bidirectional) | custom HID interface, usage page 0xFF60 / usage 0x61, 32-byte reports |
| BLE (HID over GATT) | HOG report characteristic |
| Custom behaviors | `&ai_console_key AI_APPROVE` etc. (F13–F24 equivalents) |
| Encoder | bind `&ai_console_key` to `sensor_rotate_left/right` |
| RGB status | underglow color per agent state (idle white / thinking blue / tool purple / waiting orange / done green / error red / disconnected off) |
| OLED status | LVGL widget, 4 lines |
| Capability negotiation | HELLO advertises features; the host disables what the board lacks |
| Compat mode | stock keyboards: bind plain `&kp F13..F24` — one-way control, no module |

## Install

1. Add the module to `config/west.yml`:

```yaml
manifest:
  remotes:
    - name: zmkfirmware
      url-base: https://github.com/zmkfirmware
    - name: vibebridge
      url-base: https://github.com/vibebridge
  projects:
    - name: zmk
      remote: zmkfirmware
      revision: main
      import: app/west.yml
    - name: ai-agent-console
      remote: vibebridge
      revision: main
  self:
    path: config
```

2. Include the behavior definitions and use the keycodes in your keymap:

```c
#include <dt-bindings/behavior/ai_console.h>
#include <behaviors/ai_console.dtsi>

/ {
    keymap {
        compatible = "zmk,keymap";
        default_layer {
            bindings = <
                &ai_console_key AI_SELECT_AGENT  &ai_console_key AI_APPROVE
                &ai_console_key AI_REJECT        &ai_console_key AI_NEW_TASK
                &ai_console_key AI_SEND          &ai_console_key AI_DICTATE
                &ai_console_key AI_FAST_MODE     &ai_console_key AI_REASONING_UP
                &ai_console_key AI_REASONING_DOWN
            >;
        };
    };
};
```

3. Encoder (knob) — in the same overlay:

```c
sensor-bindings = <&ai_console_key AI_REASONING_UP>, <&ai_console_key AI_REASONING_DOWN>;
```

4. Build (GitHub Actions or local west):

```sh
west build -b nice_nano_v2 -- -DSHIELD=your_shield
west flash
```

Kconfig options: `CONFIG_AI_CONSOLE_UNDERGLOW` (needs `ZMK_RGB_UNDERGLOW`) and
`CONFIG_AI_CONSOLE_OLED` (needs `ZMK_DISPLAY` + a display shield such as
nice_view) are on by default when the underlying feature exists; disable them on
boards without RGB or a screen — the host stops sending those payloads too.

## Compat mode (no firmware change)

Stock ZMK keyboards: bind `&kp F13` … `&kp F24` in the top row. The desktop app
registers global F13–F24 shortcuts and maps them to the actions — one-way
control with zero firmware work. Install this module for bidirectional status
feedback (state colors + OLED) on top.

## Unit tests (host, no ZMK toolchain)

The AKP codec is pure C99 and identical to the QMK module's:

```sh
cc -std=c99 -Wall -Wextra -Iinclude/akp \
   firmware/zmk/ai-agent-console/src/akp.c \
   firmware/qmk/modules/ai_console/test/akp_test.c -o akp_test
./akp_test
```

Firmware integration itself requires the ZMK toolchain (`west` + nRF SDK) —
see `docs/FLASHING_ZMK.md` and `docs/HARDWARE_VALIDATION.md`.
