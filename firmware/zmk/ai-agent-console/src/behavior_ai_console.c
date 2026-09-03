/*
 * AI Console behavior — sends AKP commands over Raw HID.
 *
 * Keymap usage:
 *   &ai_console_key AI_APPROVE            // raw HID command only
 *   &ai_console_key AI_APPROVE            // with emit-f-key: also types F14
 *
 * Compat mode: stock ZMK keyboards simply bind &kp F13..F24 — the desktop app
 * maps F13-F24 globally, giving one-way control with no firmware change.
 */

#define DT_DRV_COMPAT zmk_behavior_ai_console

#include <zephyr/device.h>
#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#include <drivers/behavior.h>
#include <zmk/behavior.h>
#include <zmk/event_manager.h>

#include <dt-bindings/behavior/ai_console.h>
#include <behavior_ai_console.h>
#include <raw_hid/raw_hid.h>

/* F13..F24 are HID usage ids 0x68..0x73 */
#define HID_USAGE_F13 0x68u

extern int ai_console_send_cmd(const char *action, const char *source);

const char *ai_console_action_name(uint8_t id) {
    static const char *names[] = {
        "select_agent", "approve",       "reject",     "new_task",   "send",       "dictate",
        "fast_mode",    "reasoning_up",  "reasoning_down", "cancel", "pause",      "resume",
        "custom",       "custom",        "custom",     "custom"};
    if (id >= 1 && id <= 16) return names[id - 1];
    return "custom";
}

static uint8_t ai_action_fkey(uint8_t id) {
    static const uint8_t fkeys[] = {0, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 0, 0, 0};
    if (id >= 1 && id <= 16) return fkeys[id - 1];
    return 0;
}

struct ai_console_key_config {
    bool emit_fkey;
};

/* Emit a real F13-F24 keypress through the built-in kp behavior. */
static int ai_emit_fkey(uint8_t fkey, bool pressed) {
    const struct device *kp_dev = DEVICE_DT_GET(DT_NODELABEL(kp));
    if (!device_is_ready(kp_dev)) {
        return -ENODEV;
    }
    struct zmk_behavior_binding binding = {.behavior_dev = kp_dev,
                                           .param1 = (uint32_t)(HID_USAGE_F13 + fkey - 13)};
    struct zmk_behavior_binding_event ev = {.position = 0, .timestamp = k_uptime_get()};
    if (pressed) {
        return behavior_keymap_binding_pressed(&binding, ev);
    }
    return behavior_keymap_binding_released(&binding, ev);
}

static int ai_console_key_pressed(struct zmk_behavior_binding *binding,
                                  struct zmk_behavior_binding_event event) {
    const struct device *dev = device_get_binding(binding->behavior_dev);
    const struct ai_console_key_config *cfg =
        dev != NULL ? (const struct ai_console_key_config *)dev->config : NULL;

    uint8_t action = (uint8_t)(binding->param1 & 0xFFu);
    const char *name = ai_console_action_name(action);
    uint8_t fkey = ai_action_fkey(action);
    char source[16];
    snprintf(source, sizeof(source), fkey != 0 ? "F%u" : "CUSTOM", fkey);

    bool sent = false;
    if (ai_console_raw_hid_available()) {
        sent = ai_console_send_cmd(name, source) == 0;
    }
    LOG_DBG("ai-console-key %s -> %s (raw=%d)", source, name, sent);

    if (!sent && cfg != NULL && cfg->emit_fkey && fkey != 0) {
        ai_emit_fkey(fkey, true);
        ai_emit_fkey(fkey, false);
        LOG_DBG("ai-console-key fallback emitted F%u", fkey);
    }
    return ZMK_BEHAVIOR_OPAQUE;
}

static int ai_console_key_released(struct zmk_behavior_binding *binding,
                                   struct zmk_behavior_binding_event event) {
    return ZMK_BEHAVIOR_OPAQUE;
}

static const struct behavior_driver_api ai_console_key_driver_api = {
    .binding_pressed = ai_console_key_pressed,
    .binding_released = ai_console_key_released,
};

#define AI_CONSOLE_KEY_INST(n)                                                                     \
    static struct ai_console_key_config ai_console_key_config_##n = {                             \
        .emit_fkey = DT_INST_PROP(n, emit_f_key),                                                 \
    };                                                                                             \
    DEVICE_DT_INST_DEFINE(n, NULL, NULL, &ai_console_key_config_##n, NULL, APPLICATION,           \
                          CONFIG_KERNEL_INIT_PRIORITY_DEFAULT, &ai_console_key_driver_api);

DT_INST_FOREACH_STATUS_OKAY(AI_CONSOLE_KEY_INST)
