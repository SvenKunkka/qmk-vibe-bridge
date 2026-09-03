/*
 * AKP (Agent Keyboard Protocol) v1 — firmware-side codec.
 *
 * Pure C99, zero QMK dependencies, so it can be unit-tested standalone
 * (see test/akp_test.c) and dropped into any QMK/ZMK firmware.
 *
 * Wire format (little-endian) — see docs/PROTOCOL.md for the full spec:
 *
 *   HID frame (per report):
 *     [0] u8 magic 0xA5
 *     [1] u8 flags  (bit7 = more frames follow; bits3..0 = frame index)
 *     [2] u8 length (bytes of message data in this frame)
 *     [3 .. 3+length) message data
 *     [3+length] u8 crc8 (MSB-first, poly 0x07, init 0x00)
 *
 *   Logical message:
 *     [0] u8 magic 0x4B
 *     [1] u8 version = 1
 *     [2] u8 type
 *     [3] u8 flags (bit0 = ack requested)
 *     [4..5] u16 seq (LE)
 *     [6..7] u16 payload_len (LE)
 *     [8 .. 8+payload_len) payload
 *     [..+2] u16 crc16 (CCITT-FALSE, poly 0x1021, init 0xFFFF, LE)
 */

#pragma once

#include <stdint.h>
#include <stdbool.h>

#define AKP_FRAME_MAGIC 0xA5u
#define AKP_MSG_MAGIC 0x4Bu
#define AKP_PROTO_VERSION 1u
#define AKP_MTU 32u
#define AKP_FRAME_HEADER 4u
#define AKP_FRAME_DATA_MAX (AKP_MTU - AKP_FRAME_HEADER)
#define AKP_FRAME_FLAG_MORE 0x80u
#define AKP_FRAME_INDEX_MASK 0x0Fu
#define AKP_MSG_HEADER 8u
#define AKP_MSG_FLAG_ACK_REQ 0x01u
#define AKP_MSG_MAX_SIZE 512u
#define AKP_PAYLOAD_MAX (AKP_MSG_MAX_SIZE - AKP_MSG_HEADER - 2u)

typedef enum {
    AKP_MSG_HELLO = 0x01u,
    AKP_MSG_CAPS = 0x02u,
    AKP_MSG_HEARTBEAT = 0x03u,
    AKP_MSG_CMD = 0x04u,
    AKP_MSG_STATE = 0x05u,
    AKP_MSG_RGB = 0x06u,
    AKP_MSG_SCREEN = 0x07u,
    AKP_MSG_ACK = 0x08u,
    AKP_MSG_ERR = 0x09u,
    AKP_MSG_DICTATE = 0x0Au,
    AKP_MSG_ENCODER = 0x0Bu,
    AKP_MSG_KEYEVENT = 0x0Cu,
    AKP_MSG_LOG = 0x0Du
} akp_msg_type_t;

uint8_t akp_crc8(const uint8_t *data, uint16_t len);
uint16_t akp_crc16(const uint8_t *data, uint16_t len);

/* Encode a logical message into out (>= AKP_MSG_MAX_SIZE). Returns length. */
uint16_t akp_encode_message(uint8_t type, const uint8_t *payload, uint16_t payload_len,
                            uint16_t seq, uint8_t flags, uint8_t *out);

/* Split a message into HID frames. frames must hold AKP_MTU bytes each;
 * returns the number of frames written (0 on error). */
uint8_t akp_frame_message(const uint8_t *msg, uint16_t msg_len,
                          uint8_t (*frames)[AKP_MTU], uint8_t max_frames);

/*
 * Decode one HID report (report_len bytes) into a frame.
 * When the report completes a message, returns true and writes the message
 * into out_msg (AKP_MSG_MAX_SIZE bytes). Returns false otherwise; *out_len is
 * set to the number of bytes written so far (partial progress).
 */
bool akp_decode_report(const uint8_t *report, uint8_t report_len,
                       uint8_t *out_msg, uint16_t *out_len);

/* Reset the reassembly state (call on transport reconnect). */
void akp_reset_reassembly(void);

/* Tiny JSON accessor for our controlled payloads:
 *   akp_json_find(json, len, "state", out, outlen)
 * returns 1 (string), 2 (number) or 0 (not found / type mismatch).
 * akp_json_find_at searches starting at byte offset start (for nested fields
 * such as "color": {"r": ...}). */
uint8_t akp_json_find(const char *json, uint16_t len, const char *key,
                      char *out, uint16_t outlen);
uint8_t akp_json_find_at(const char *json, uint16_t len, uint16_t start,
                         const char *key, char *out, uint16_t outlen);
