/*
 * Raw HID events + dispatch — the shared send path used by the transports.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#include <raw_hid/raw_hid.h>
#include <raw_hid/events.h>

ZMK_EVENT_IMPL(ai_console_raw_hid_received_event);
ZMK_EVENT_IMPL(ai_console_raw_hid_sent_event);

static ai_console_raw_hid_rx_cb_t ai_global_rx_cb;
static ai_console_raw_hid_sender_t ai_usb_sender;
static ai_console_raw_hid_sender_t ai_hog_sender;

void ai_console_raw_hid_set_rx_cb(ai_console_raw_hid_rx_cb_t cb) { ai_global_rx_cb = cb; }
void ai_console_raw_hid_set_usb_sender(ai_console_raw_hid_sender_t fn) { ai_usb_sender = fn; }
void ai_console_raw_hid_set_hog_sender(ai_console_raw_hid_sender_t fn) { ai_hog_sender = fn; }

bool ai_console_raw_hid_available(void) { return ai_global_rx_cb != NULL; }

/* Called by transports with an incoming host report. */
void ai_console_raw_hid_rx(const uint8_t *data, uint8_t length) {
    if (ai_global_rx_cb) {
        ai_global_rx_cb((uint8_t *)data, length);
    }
    raise_ai_console_raw_hid_received_event(
        (struct ai_console_raw_hid_received_event){.data = (uint8_t *)data, .length = length});
}

int ai_console_raw_hid_send(const uint8_t *data, uint8_t length) {
    int err = -ENODEV;
#if IS_ENABLED(CONFIG_AI_CONSOLE_RAW_HID_USB)
    if (ai_usb_sender) {
        extern bool zmk_usb_is_active(void);
        if (zmk_usb_is_active()) {
            err = ai_usb_sender(data, length);
        }
    }
#endif
#if IS_ENABLED(CONFIG_AI_CONSOLE_RAW_HID_HOG)
    if (err != 0 && ai_hog_sender) {
        err = ai_hog_sender(data, length);
    }
#endif
    if (err == 0) {
        raise_ai_console_raw_hid_sent_event(
            (struct ai_console_raw_hid_sent_event){.data = (uint8_t *)data, .length = length});
    }
    return err;
}
