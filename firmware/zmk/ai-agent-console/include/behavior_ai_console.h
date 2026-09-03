/*
 * AI Console behavior — header.
 */

#pragma once

#include <stdint.h>

/* action ids passed as the binding parameter (see
 * include/dt-bindings/behavior/ai_console.h) */
enum {
    AI_ACTION_SELECT_AGENT = 1,
    AI_ACTION_APPROVE,
    AI_ACTION_REJECT,
    AI_ACTION_NEW_TASK,
    AI_ACTION_SEND,
    AI_ACTION_DICTATE,
    AI_ACTION_FAST_MODE,
    AI_ACTION_REASONING_UP,
    AI_ACTION_REASONING_DOWN,
    AI_ACTION_CANCEL,
    AI_ACTION_PAUSE,
    AI_ACTION_RESUME,
    AI_ACTION_CUSTOM_0,
    AI_ACTION_CUSTOM_1,
    AI_ACTION_CUSTOM_2,
    AI_ACTION_CUSTOM_3,
};

const char *ai_console_action_name(uint8_t id);
