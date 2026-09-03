/*
 * AI Console — QMK integration for the Agent Keyboard Protocol (AKP v1).
 *
 * Public API used from your keymap:
 *
 *   - keycodes  AI_APPROVE, AI_REJECT, ... (F13-F24 equivalents)
 *   - bool ai_console_process_record(uint16_t keycode, keyrecord_t *record)
 *     → call from process_record_user()
 *   - void ai_console_oled_render(void)   → call from oled_task_user()
 *   - bool ai_console_encoder_update(bool clockwise)
 *     → call from encoder_update_user()
 *   - void ai_console_rgb_matrix_indicators(void)
 *     → call from rgb_matrix_indicators_user() (per-key RGB mode)
 *   - void ai_console_init(void)          → call from keyboard_post_init_user()
 */

#pragma once

#include "quantum.h"

/* Custom keycodes (also usable as "custom keys" in your keymap). */
enum ai_console_keycodes {
    AI_SELECT_AGENT = SAFE_RANGE,
    AI_APPROVE,
    AI_REJECT,
    AI_NEW_TASK,
    AI_SEND,
    AI_DICTATE,
    AI_FAST_MODE,
    AI_REASONING_UP,
    AI_REASONING_DOWN,
    AI_CANCEL,
    AI_PAUSE,
    AI_RESUME,
    AI_CUSTOM_0,
    AI_CUSTOM_1,
    AI_CUSTOM_2,
    AI_CUSTOM_3,
    AI_SAFE_RANGE_END,
};

void ai_console_init(void);
bool ai_console_process_record(uint16_t keycode, keyrecord_t *record);
void ai_console_oled_render(void);
bool ai_console_encoder_update(bool clockwise);
void ai_console_rgb_matrix_indicators(void);

/* Periodically call from matrix_scan_user() (or rely on the built-in hook). */
void ai_console_task(void);
