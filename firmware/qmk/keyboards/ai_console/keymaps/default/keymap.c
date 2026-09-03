/* Copyright 2026 AI Console contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * AI Console 75 — default keymap.
 *
 * Top row = F13..F24 (control console keys):
 *   F13 select agent  F14 approve  F15 reject  F16 new task
 *   F17 send          F18 dictate  F19 fast mode
 *   F20 reasoning up  F21 reasoning down  F22 cancel
 *   F23 pause         F24 resume
 *
 * Knob: CW = reasoning up, CCW = reasoning down, press = send.
 *
 * Compatibility note: the AI_* keycodes send AKP commands to the host over
 * Raw HID. On keyboards WITHOUT this firmware you can place plain KC_F13..
 * KC_F24 in the same spots — the desktop app maps F13-F24 globally, giving
 * one-way control with zero firmware changes.
 */

#include QMK_KEYBOARD_H
#include "ai_console.h"

enum layers {
    BASE = 0,
    FN,
};

const uint16_t PROGMEM keymaps[][MATRIX_ROWS][MATRIX_COLS] = {
    [BASE] = LAYOUT_75(
        AI_SELECT_AGENT, AI_APPROVE,    AI_REJECT,     AI_NEW_TASK, AI_SEND, AI_DICTATE,
        AI_FAST_MODE,    AI_REASONING_UP, AI_REASONING_DOWN, AI_CANCEL, AI_PAUSE, AI_RESUME,
        KC_ESC,   KC_1,    KC_2,    KC_3,    KC_4,    KC_5,    KC_6,    KC_7,    KC_8,    KC_9,    KC_0,    KC_MINS, KC_EQL,  KC_BSPC, KC_DEL,
        KC_TAB,   KC_Q,    KC_W,    KC_E,    KC_R,    KC_T,    KC_Y,    KC_U,    KC_I,    KC_O,    KC_P,    KC_LBRC, KC_RBRC, KC_BSLS, KC_PGUP,
        KC_CAPS,  KC_A,    KC_S,    KC_D,    KC_F,    KC_G,    KC_H,    KC_J,    KC_K,    KC_L,    KC_SCLN, KC_QUOT,          KC_ENT,  KC_PGDN,
        KC_LSFT,  KC_Z,    KC_X,    KC_C,    KC_V,    KC_B,    KC_N,    KC_M,    KC_COMM, KC_DOT,  KC_SLSH, KC_RSFT,          KC_UP,   MO(FN),
        KC_LCTL,  KC_LGUI, KC_LALT,                            KC_SPC,                    KC_RALT, KC_RCTL,          KC_LEFT, KC_DOWN, KC_RGHT
    ),
    [FN] = LAYOUT_75(
        _______, _______, _______, _______, _______, _______,
        _______, _______, _______, _______, _______, _______,
        KC_GRV,  _______, _______, _______, _______, _______, _______, _______, _______, _______, _______, _______, _______, _______, KC_MUTE,
        _______, _______, _______, _______, _______, _______, _______, _______, _______, _______, _______, _______, _______, _______, KC_VOLU,
        _______, _______, _______, _______, _______, _______, _______, _______, _______, _______, _______, _______,          _______, KC_VOLD,
        _______, _______, _______, _______, _______, _______, _______, _______, _______, _______, _______, _______,          _______, _______,
        _______, _______, _______,                            _______,                   _______, _______,          KC_MPRV, KC_MPLY, KC_MNXT
    ),
};

bool process_record_user(uint16_t keycode, keyrecord_t *record) {
    if (!ai_console_process_record(keycode, record)) {
        return false; /* AI_* keys are consumed by the module */
    }
    return true;
}

void keyboard_post_init_user(void) {
    ai_console_init();
}

#if defined(OLED_ENABLE)
bool oled_task_user(void) {
    ai_console_oled_render();
    return false;
}
#endif

#if defined(ENCODER_ENABLE)
bool encoder_update_user(uint8_t index, bool clockwise) {
    return ai_console_encoder_update(clockwise);
}
#endif

#if defined(RGB_MATRIX_ENABLE)
bool rgb_matrix_indicators_user(void) {
    ai_console_rgb_matrix_indicators();
    return false;
}
#endif
