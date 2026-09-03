/*
 * Raw HID transport — USB implementation.
 *
 * Registers an additional HID interface with a raw report descriptor
 * (usage page 0xFF60, usage 0x61, 32-byte reports). Host -> keyboard
 * reports arrive via the HID OUTPUT report (set_report_cb); keyboard ->
 * host via hid_int_ep_write (the report id byte is stripped/added to keep
 * the same 32-byte report layout as QMK Raw HID).
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#include <zephyr/usb/class/hid.h>
#include <zephyr/usb/class/usb_hid.h>

#include <raw_hid/raw_hid.h>
#include <raw_hid/events.h>

#define AI_HID_USAGE_PAGE16(page, page2)                                                           \
    HID_ITEM(HID_ITEM_TAG_USAGE_PAGE, HID_ITEM_TYPE_GLOBAL, 2), page, page2

static const uint8_t ai_console_report_desc[] = {
    AI_HID_USAGE_PAGE16(CONFIG_AI_CONSOLE_RAW_HID_USAGE_PAGE & 0xFF,
                        (CONFIG_AI_CONSOLE_RAW_HID_USAGE_PAGE >> 8) & 0xFF),
    HID_USAGE(CONFIG_AI_CONSOLE_RAW_HID_USAGE),

    HID_COLLECTION(0x01),

    HID_LOGICAL_MIN8(0x00),
    HID_LOGICAL_MAX16(0xFF, 0x00),
    HID_REPORT_SIZE(0x08),
    HID_REPORT_COUNT(CONFIG_AI_CONSOLE_RAW_HID_REPORT_SIZE),

    HID_USAGE(0x01),
    HID_INPUT(0x02 | 0x01), /* Data | Variable | Absolute */

    HID_USAGE(0x02),
    HID_OUTPUT(0x02 | 0x01 | 0x04), /* Data | Variable | Absolute | Non-volatile */

    HID_END_COLLECTION,
};

static const struct device *ai_raw_hid_dev;
static K_SEM_DEFINE(ai_hid_sem, 1, 1);
static void ai_in_ready_cb(const struct device *dev) { k_sem_give(&ai_hid_sem); }

static int ai_get_report_cb(const struct device *dev, struct usb_setup_packet *setup,
                            int32_t *len, uint8_t **data) {
    return 0;
}

extern void ai_console_raw_hid_rx(const uint8_t *data, uint8_t length);

static int ai_set_report_cb(const struct device *dev, struct usb_setup_packet *setup,
                            int32_t *len, uint8_t **data) {
    uint8_t *buf = *data;
    uint8_t len = (uint8_t)*len;
    if (len > 0 && buf[0] == 0x00) {
        /* strip a leading report-id byte so the codec sees the raw payload */
        buf++;
        len--;
    }
    ai_console_raw_hid_rx(buf, len);
    return 0;
}

static const struct hid_ops ai_hid_ops = {
    .int_in_ready = ai_in_ready_cb,
    .get_report = ai_get_report_cb,
    .set_report = ai_set_report_cb,
};

static int ai_console_usb_send(const uint8_t *data, uint8_t length) {
    if (ai_raw_hid_dev == NULL) {
        return -ENODEV;
    }
    k_sem_take(&ai_hid_sem, K_MSEC(50));
    static uint8_t report[CONFIG_AI_CONSOLE_RAW_HID_REPORT_SIZE + 1];
    memset(report, 0, sizeof(report));
    /* report id 0x00 + payload (matches QMK's raw report layout) */
    memcpy(&report[1], data, length);
    int err = hid_int_ep_write(ai_raw_hid_dev, report, sizeof(report), NULL);
    if (err) {
        k_sem_give(&ai_hid_sem);
    }
    return err;
}

static int ai_console_usb_init(void) {
    ai_raw_hid_dev = device_get_binding(CONFIG_AI_CONSOLE_RAW_HID_DEVICE);
    if (ai_raw_hid_dev == NULL) {
        LOG_WRN("Raw HID device %s not found", CONFIG_AI_CONSOLE_RAW_HID_DEVICE);
        return -ENODEV;
    }
    int err = usb_hid_register_device(ai_raw_hid_dev, ai_console_report_desc,
                                      sizeof(ai_console_report_desc), &ai_hid_ops);
    if (err) {
        LOG_ERR("usb_hid_register_device failed: %d", err);
        return err;
    }
    err = usb_hid_init(ai_raw_hid_dev);
    if (err) {
        LOG_ERR("usb_hid_init failed: %d", err);
        return err;
    }
    LOG_INF("AI Console Raw HID over USB ready");
    return 0;
}

SYS_INIT(ai_console_usb_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);
