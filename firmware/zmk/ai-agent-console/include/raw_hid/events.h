/*
 * Raw HID ZMK events (transport -> listeners).
 */

#pragma once

#include <zmk/event_manager.h>

struct ai_console_raw_hid_received_event {
    uint8_t *data;
    uint8_t length;
};

ZMK_EVENT_DECLARE(ai_console_raw_hid_received_event);

struct ai_console_raw_hid_sent_event {
    uint8_t *data;
    uint8_t length;
};

ZMK_EVENT_DECLARE(ai_console_raw_hid_sent_event);
