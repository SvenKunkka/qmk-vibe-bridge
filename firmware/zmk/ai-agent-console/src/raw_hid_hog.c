/*
 * Raw HID transport — BLE (HID over GATT) implementation.
 * Host reports arrive through the HOG report characteristic.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#include <zephyr/bluetooth/gatt.h>

#include <raw_hid/raw_hid.h>
#include <raw_hid/events.h>

enum { HIDS_REMOTE_WAKE = BIT(0), HIDS_NORMALLY_CONNECTABLE = BIT(1) };

struct hids_info {
    uint16_t version;
    uint8_t code;
    uint8_t flags;
} __packed;

struct hids_report {
    uint8_t id;
    uint8_t type;
} __packed;

static struct hids_info ai_info = {
    .version = 0x0000,
    .code = 0x00,
    .flags = HIDS_NORMALLY_CONNECTABLE | HIDS_REMOTE_WAKE,
};

enum {
    HIDS_INPUT = 0x01,
    HIDS_OUTPUT = 0x02,
    HIDS_FEATURE = 0x03,
};

static struct hids_report ai_raw_report_output = {.id = 0x00, .type = HIDS_OUTPUT};
static struct hids_report ai_raw_report_input = {.id = 0x00, .type = HIDS_INPUT};

/* Minimal raw report descriptor (same layout as the USB one). */
static const uint8_t ai_console_report_desc[] = {
    0x06, 0x60, 0xFF, /* usage page 0xFF60 */
    0x09, 0x61,       /* usage 0x61 */
    0xA1, 0x01,       /* collection application */
    0x15, 0x00,       /* logical min 0 */
    0x26, 0xFF, 0x00, /* logical max 255 */
    0x75, 0x08,       /* report size 8 */
    0x95, 32,         /* report count 32 */
    0x09, 0x01,       /* usage 1 */
    0x81, 0x02,       /* input data,var,abs */
    0x09, 0x02,       /* usage 2 */
    0x91, 0x06,       /* output data,var,abs,nv */
    0xC0,
};

static ssize_t ai_read_info(struct bt_conn *conn, const struct bt_gatt_attr *attr, void *buf,
                            uint16_t len, uint16_t offset) {
    return bt_gatt_attr_read(conn, attr, buf, len, offset, attr->user_data, sizeof(struct hids_info));
}

static ssize_t ai_read_report_ref(struct bt_conn *conn, const struct bt_gatt_attr *attr, void *buf,
                                  uint16_t len, uint16_t offset) {
    return bt_gatt_attr_read(conn, attr, buf, len, offset, attr->user_data, sizeof(struct hids_report));
}

static ssize_t ai_read_report_map(struct bt_conn *conn, const struct bt_gatt_attr *attr, void *buf,
                                  uint16_t len, uint16_t offset) {
    return bt_gatt_attr_read(conn, attr, buf, len, offset, ai_console_report_desc,
                             sizeof(ai_console_report_desc));
}

extern void ai_console_raw_hid_rx(const uint8_t *data, uint8_t length);

static ssize_t ai_write_report(struct bt_conn *conn, const struct bt_gatt_attr *attr,
                               const void *buf, uint16_t len, uint16_t offset) {
    ai_console_raw_hid_rx((const uint8_t *)buf, (uint8_t)len);
    return len;
}

static int ai_console_hog_send(const uint8_t *data, uint8_t length) {
    struct bt_conn *conn = NULL;
    int err = -ENODEV;
    while ((conn = bt_conn_get_default())) {
        struct bt_gatt_attr *attr = NULL;
        /* find the report characteristic we registered */
        attr = bt_gatt_find_by_uuid(bt_gatt_get_db(conn), 0, BT_UUID_HIDS_REPORT);
        if (attr == NULL) {
            bt_conn_unref(conn);
            break;
        }
        err = bt_gatt_notify(conn, attr, data, length);
        bt_conn_unref(conn);
        break;
    }
    return err;
}

static const struct bt_gatt_attr ai_hids_attrs[] = {
    BT_GATT_PRIMARY_SERVICE(BT_UUID_HIDS),
    BT_GATT_CHARACTERISTIC(BT_UUID_HIDS_INFO, BT_GATT_CHRC_READ, BT_GATT_PERM_READ,
                           ai_read_info, NULL, &ai_info),
    BT_GATT_CHARACTERISTIC(BT_UUID_HIDS_REPORT_MAP, BT_GATT_CHRC_READ, BT_GATT_PERM_READ,
                           ai_read_report_map, NULL, ai_console_report_desc),
    BT_GATT_CHARACTERISTIC(BT_UUID_HIDS_REPORT, BT_GATT_CHRC_READ | BT_GATT_CHRC_WRITE,
                           BT_GATT_PERM_READ | BT_GATT_PERM_WRITE, ai_read_report_ref,
                           ai_write_report, &ai_raw_report_output),
    BT_GATT_CCCD,
};

static struct bt_gatt_service ai_hids_svc = BT_GATT_SERVICE(ai_hids_attrs);

static int ai_console_hog_init(void) {
    int err = bt_gatt_service_register(&ai_hids_svc);
    if (err) {
        LOG_ERR("Failed to register HOG raw HID service: %d", err);
        return err;
    }
    ai_console_raw_hid_set_hog_sender(ai_console_hog_send);
    LOG_INF("AI Console Raw HID over BLE (HOG) ready");
    return 0;
}

SYS_INIT(ai_console_hog_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);
