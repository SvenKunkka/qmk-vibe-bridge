/* Copyright 2026 Keychron
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * K10 Max ANSI RGB — Codex and DeepSeek task row.
 *
 * Physical F1..F12 emit F13..F24 so a host bridge can focus twelve AI
 * tasks. Holding Fn restores the keyboard's normal multimedia actions.
 * The RGB indicator pass blacks out the whole matrix, then renders only the
 * F1..F12 LEDs from Keychron's RAM-backed per-key HSV array. The desktop
 * controller updates those twelve HSV entries without EEPROM saves.
 */

#include QMK_KEYBOARD_H
#include "keychron_common.h"
#include "color.h"
#include "raw_hid.h"

enum layers {
    MAC_BASE,
    MAC_FN,
    WIN_BASE,
    WIN_FN,
};

#define FN_MAC MO(MAC_FN)
#define FN_WIN MO(WIN_FN)

// clang-format off
const uint16_t PROGMEM keymaps[][MATRIX_ROWS][MATRIX_COLS] = {
    [MAC_BASE] = LAYOUT_ansi_108(
        KC_ESC,             KC_F13,   KC_F14,   KC_F15,   KC_F16,   KC_F17,   KC_F18,   KC_F19,   KC_F20,   KC_F21,   KC_F22,   KC_F23,   KC_F24,   KC_SNAP,  KC_SIRI,  UG_NEXT,  KC_F13,   KC_F14,   KC_F15,   KC_F16,
        KC_GRV,   KC_1,     KC_2,     KC_3,     KC_4,     KC_5,     KC_6,     KC_7,     KC_8,     KC_9,     KC_0,     KC_MINS,  KC_EQL,   KC_BSPC,  KC_INS,   KC_HOME,  KC_PGUP,  KC_NUM,   KC_PSLS,  KC_PAST,  KC_PMNS,
        KC_TAB,   KC_Q,     KC_W,     KC_E,     KC_R,     KC_T,     KC_Y,     KC_U,     KC_I,     KC_O,     KC_P,     KC_LBRC,  KC_RBRC,  KC_BSLS,  KC_DEL,   KC_END,   KC_PGDN,  KC_P7,    KC_P8,    KC_P9,
        KC_CAPS,  KC_A,     KC_S,     KC_D,     KC_F,     KC_G,     KC_H,     KC_J,     KC_K,     KC_L,     KC_SCLN,  KC_QUOT,            KC_ENT,                                 KC_P4,    KC_P5,    KC_P6,    KC_PPLS,
        KC_LSFT,            KC_Z,     KC_X,     KC_C,     KC_V,     KC_B,     KC_N,     KC_M,     KC_COMM,  KC_DOT,   KC_SLSH,            KC_RSFT,            KC_UP,              KC_P1,    KC_P2,    KC_P3,
        KC_LCTL,  KC_LOPTN, KC_LCMMD,                               KC_SPC,                                 KC_RCMMD, KC_ROPTN, FN_MAC,   KC_RCTL,  KC_LEFT,  KC_DOWN,  KC_RGHT,  KC_P0,              KC_PDOT,  KC_PENT),

    [MAC_FN] = LAYOUT_ansi_108(
        _______,            KC_BRID,  KC_BRIU,  KC_MCTRL, KC_LNPAD, UG_VALD,  UG_VALU,  KC_MPRV,  KC_MPLY,  KC_MNXT,  KC_MUTE,  KC_VOLD,  KC_VOLU,  _______,  _______,  UG_TOGG,  _______,  _______,  _______,  _______,
        _______,  BT_HST1,  BT_HST2,  BT_HST3,  P2P4G,    _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,
        UG_TOGG,  UG_NEXT,  UG_VALU,  UG_HUEU,  UG_SATU,  UG_SPDU,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,
        _______,  UG_PREV,  UG_VALD,  UG_HUED,  UG_SATD,  UG_SPDD,  _______,  _______,  _______,  _______,  _______,  _______,            _______,                                _______,  _______,  _______,  _______,
        _______,            _______,  _______,  _______,  _______,  BAT_LVL,  _______,  _______,  _______,  _______,  _______,            _______,            _______,            _______,  _______,  _______,
        _______,  _______,  _______,                                _______,                                _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,            _______,  _______),

    [WIN_BASE] = LAYOUT_ansi_108(
        KC_ESC,             KC_F13,   KC_F14,   KC_F15,   KC_F16,   KC_F17,   KC_F18,   KC_F19,   KC_F20,   KC_F21,   KC_F22,   KC_F23,   KC_F24,   KC_PSCR,  KC_CTANA, UG_NEXT,  _______,  _______,  _______,  _______,
        KC_GRV,   KC_1,     KC_2,     KC_3,     KC_4,     KC_5,     KC_6,     KC_7,     KC_8,     KC_9,     KC_0,     KC_MINS,  KC_EQL,   KC_BSPC,  KC_INS,   KC_HOME,  KC_PGUP,  KC_NUM,   KC_PSLS,  KC_PAST,  KC_PMNS,
        KC_TAB,   KC_Q,     KC_W,     KC_E,     KC_R,     KC_T,     KC_Y,     KC_U,     KC_I,     KC_O,     KC_P,     KC_LBRC,  KC_RBRC,  KC_BSLS,  KC_DEL,   KC_END,   KC_PGDN,  KC_P7,    KC_P8,    KC_P9,
        KC_CAPS,  KC_A,     KC_S,     KC_D,     KC_F,     KC_G,     KC_H,     KC_J,     KC_K,     KC_L,     KC_SCLN,  KC_QUOT,            KC_ENT,                                 KC_P4,    KC_P5,    KC_P6,    KC_PPLS,
        KC_LSFT,            KC_Z,     KC_X,     KC_C,     KC_V,     KC_B,     KC_N,     KC_M,     KC_COMM,  KC_DOT,   KC_SLSH,            KC_RSFT,            KC_UP,              KC_P1,    KC_P2,    KC_P3,
        KC_LCTL,  KC_LWIN,  KC_LALT,                                KC_SPC,                                 KC_RALT,  KC_RWIN,  FN_WIN,   KC_RCTL,  KC_LEFT,  KC_DOWN,  KC_RGHT,  KC_P0,              KC_PDOT,  KC_PENT),

    [WIN_FN] = LAYOUT_ansi_108(
        _______,            KC_BRID,  KC_BRIU,  KC_TASK,  KC_FILE,  UG_VALD,  UG_VALU,  KC_MPRV,  KC_MPLY,  KC_MNXT,  KC_MUTE,  KC_VOLD,  KC_VOLU,  _______,  _______,  UG_TOGG,  _______,  _______,  _______,  _______,
        _______,  BT_HST1,  BT_HST2,  BT_HST3,  P2P4G,    _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,
        UG_TOGG,  UG_NEXT,  UG_VALU,  UG_HUEU,  UG_SATU,  UG_SPDU,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,
        _______,  UG_PREV,  UG_VALD,  UG_HUED,  UG_SATD,  UG_SPDD,  _______,  _______,  _______,  _______,  _______,  _______,            _______,                                _______,  _______,  _______,  _______,
        _______,            _______,  _______,  _______,  _______,  BAT_LVL,  _______,  _______,  _______,  _______,  _______,            _______,            _______,            _______,  _______,  _______,
        _______,  _______,  _______,                                _______,                                _______,  _______,  _______,  _______,  _______,  _______,  _______,  _______,            _______,  _______)
};
// clang-format on

#ifdef RGB_MATRIX_ENABLE
extern HSV per_key_led[RGB_MATRIX_LED_COUNT];

static const uint8_t codex_slot_leds[12] = {
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
};

void keyboard_post_init_user(void) {
    for (uint8_t slot = 0; slot < ARRAY_SIZE(codex_slot_leds); slot++) {
        per_key_led[codex_slot_leds[slot]] = (HSV){0, 0, 0};
    }
    rgb_matrix_enable_noeeprom();
    rgb_matrix_mode_noeeprom(RGB_MATRIX_SOLID_COLOR);
}

bool rgb_matrix_indicators_user(void) {
    for (uint8_t led = 0; led < RGB_MATRIX_LED_COUNT; led++) {
        rgb_matrix_set_color(led, 0, 0, 0);
    }

    for (uint8_t slot = 0; slot < ARRAY_SIZE(codex_slot_leds); slot++) {
        const uint8_t led = codex_slot_leds[slot];
        const RGB rgb = hsv_to_rgb(per_key_led[led]);
        rgb_matrix_set_color(led, rgb.r, rgb.g, rgb.b);
    }

    // Suppress Keychron's later OS/wireless indicator pass. The requested
    // contract is strict: every non-F1..F12 RGB position stays black.
    return false;
}
#endif

#ifdef RAW_ENABLE
/* Keyboard -> host only. 0xAD is outside Keychron's current 0xA0..0xAB
 * command range and does not alter VIA or Keychron RGB receive handling.
 * [0]=0xAD [1]=0x01 (focus-slot) [2]=slot 1..12. */
#    define CODEX_RAW_REPORT_SIZE 32
static void codex_send_slot(uint8_t slot) {
    uint8_t report[CODEX_RAW_REPORT_SIZE] = {0};
    report[0] = 0xAD;
    report[1] = 0x01;
    report[2] = slot;
    raw_hid_send(report, CODEX_RAW_REPORT_SIZE);
}

bool process_record_user(uint16_t keycode, keyrecord_t *record) {
    const keypos_t key = record->event.key;
    if (key.row == 0 && key.col >= 2 && key.col <= 13 && keycode >= KC_F13 && keycode <= KC_F24) {
        if (record->event.pressed) codex_send_slot((uint8_t)(key.col - 1));
        // Consume both edges: the physical row is a controller surface, not
        // an OS-level F13-F24 shortcut. Fn exposes the media keys instead.
        return false;
    }
    return true;
}
#endif
