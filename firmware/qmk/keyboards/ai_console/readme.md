# AI Console 75

A demo 75% keyboard that turns your board into an **AI Agent control console**.
Ships with the AKP (Agent Keyboard Protocol) module: Raw HID, F13–F24 action
keys, encoder, per-key RGB status, OLED status screen and a status LED.

## Layout

- **Top row F13–F24** — control console keys (see `keymaps/default/keymap.c`)
- **Encoder** — CW/CCW adjust reasoning depth; press sends
- **Per-key RGB** — reflects agent state (idle white, thinking blue, tool
  purple, waiting orange, done green, error red, disconnected off)
- **OLED (128x32)** — 4-line status: app name / agent / step / hint
- **Status LED** — on when connected, blinks while awaiting approval

## Copy & build

```sh
cp -r keyboards/ai_console <your-qmk>/keyboards/
cd <your-qmk>
qmk compile -kb ai_console -km default     # build
qmk flash   -kb ai_console -km default     # flash (bootloader)
```

## Wiring (placeholder pins)

`config.h` uses STM32F103-style pins; adjust to your MCU:

| Signal  | Pin |
|---------|-----|
| Rows    | B0–B5 |
| Cols    | A0–A7, C0–C7 |
| Encoder | D0, D1 |
| Status LED | D2 |
| RGB data | PB1 (set `RGB_DI_PIN` if your matrix differs) |

## Porting the module to your own keyboard

1. Copy `modules/ai_console/` into your keyboard folder.
2. `rules.mk`: add `SRC += ai_console/akp.c ai_console/ai_console.c`
   plus `RAW_ENABLE = yes` (and `ENCODER_ENABLE`/`OLED_ENABLE`/`RGB_MATRIX_ENABLE`
   for the features your board has).
3. `keymap.c`: include `ai_console.h`, call `ai_console_init()` from
   `keyboard_post_init_user()`, `ai_console_process_record()` from
   `process_record_user()`, and the optional OLED/encoder/RGB hooks.

Features the board lacks are negotiated at runtime — no RGB or OLED on your
board? The host simply stops sending those payloads (see `docs/PROTOCOL.md`).
