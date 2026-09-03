/*
 * Raw HID transport for ZMK — public API.
 *
 * The transport pattern follows the proven approach of the community
 * `zmk-raw-hid` module (zzeneg), reimplemented here so this module is
 * self-contained. USB + BLE(HOG) transports deliver host reports to
 * listeners and expose `ai_console_raw_hid_send()`.
 */

#pragma once

#include <stdint.h>
#include <stdbool.h>

/* Raw HID interface constants (match QMK's raw_hid defaults so one
 * desktop driver serves both firmwares). */
#ifndef CONFIG_AI_CONSOLE_RAW_HID_USAGE_PAGE
#define CONFIG_AI_CONSOLE_RAW_HID_USAGE_PAGE 0xFF60
#endif
#ifndef CONFIG_AI_CONSOLE_RAW_HID_USAGE
#define CONFIG_AI_CONSOLE_RAW_HID_USAGE 0x61
#endif
#ifndef CONFIG_AI_CONSOLE_RAW_HID_REPORT_SIZE
#define CONFIG_AI_CONSOLE_RAW_HID_REPORT_SIZE 32
#endif

/* Transports write a received report into `buf` (CONFIG_AI_CONSOLE_RAW_HID_REPORT_SIZE
 * bytes) and set `length`. Return 0 on success. */
typedef int (*ai_console_raw_hid_rx_cb_t)(uint8_t *buf, uint8_t length);

/* A transport sender: transmit one report to the host. */
typedef int (*ai_console_raw_hid_sender_t)(const uint8_t *data, uint8_t length);

/* Register the module's report consumer (called once at init). */
void ai_console_raw_hid_set_rx_cb(ai_console_raw_hid_rx_cb_t cb);
void ai_console_raw_hid_set_usb_sender(ai_console_raw_hid_sender_t fn);
void ai_console_raw_hid_set_hog_sender(ai_console_raw_hid_sender_t fn);

/* Send a report to the host (USB or BLE depending on the active endpoint).
 * Returns 0 on success. Data is copied. */
int ai_console_raw_hid_send(const uint8_t *data, uint8_t length);

/* True once a transport has been probed/started. */
bool ai_console_raw_hid_available(void);
