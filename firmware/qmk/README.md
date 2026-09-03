> **Optional extension (compatibility matrix layer C).** This firmware module is optional: the desktop software never flashes it and never requires it. Keyboards without it simply stay read-only. See docs/COMPATIBILITY.md.

# AI Console — QMK module (AKP v1)

Drop-in module that turns a QMK keyboard into an AI Agent control console.

## What it provides

| Feature | How |
|---|---|
| **Raw HID** bidirectional link | `RAW_ENABLE` + `akp.c` (protocol codec) |
| **F13–F24 action keys** | `AI_APPROVE` … `AI_RESUME` custom keycodes |
| **Custom keys** | `AI_CUSTOM_0..3` or your own via `ai_console_send_cmd()` |
| **Encoder** | `ai_console_encoder_update()` — host maps knob to action |
| **Per-key RGB** | solid status color + binary per-key payloads |
| **OLED** | 4-line agent status screen (`ai_console_oled_render()`) |
| **Status LED** | optional GPIO; on=connected, blink=awaiting approval |
| **Capability negotiation** | HELLO advertises features; host disables what the board lacks |

## Install into your keyboard

1. Copy the module into your keyboard folder:

   ```sh
   cp -r modules/ai_console <your-qmk>/keyboards/<vendor>/<board>/ai_console
   ```

2. In your keyboard's `rules.mk`:

   ```make
   RAW_ENABLE = yes
   SRC += ai_console/akp.c ai_console/ai_console.c
   # optional (only what your board has):
   ENCODER_ENABLE = yes
   OLED_ENABLE = yes
   RGB_MATRIX_ENABLE = yes
   ```

3. In your keymap: see `keyboards/ai_console/keymaps/default/keymap.c` for the
   full wiring (`ai_console_init`, `ai_console_process_record`, OLED/encoder/RGB
   hooks).

4. Optional `config.h` tweaks:

   ```c
   #define AI_CONSOLE_HOST_TIMEOUT_MS 6000   // host watchdog
   #define AI_CONSOLE_OLED_LINES 4
   #define AI_CONSOLE_OLED_LINE_LEN 21
   #define AI_CONSOLE_STATUS_LED_PIN D2      // comment out = no status LED
   #define AI_CONSOLE_STATUS_LED_ON_LEVEL 1
   ```

## Unit tests (no QMK required)

The codec is pure C99 — test it on the host:

```sh
cc -std=c99 -Wall -Wextra -Imodules/ai_console \
   modules/ai_console/test/akp_test.c modules/ai_console/akp.c -o akp_test
./akp_test
```

Vectors are cross-checked against the TypeScript implementation in
`packages/protocol` (run `npm test` from the repo root to verify both sides).
