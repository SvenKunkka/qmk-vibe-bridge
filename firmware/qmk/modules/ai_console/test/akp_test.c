/*
 * AKP codec unit test — pure C, no QMK. Build & run:
 *   cc -std=c99 -Wall -Wextra -I. akp_test.c akp.c -o akp_test && ./akp_test
 * Expected: all vectors pass (values cross-checked against the TypeScript
 * implementation in packages/protocol).
 */

#include <stdio.h>
#include <string.h>
#include "akp.h"

static int failures = 0;
#define CHECK(cond, name)                                                       \
    do {                                                                        \
        if (cond) {                                                             \
            printf("  ok   %s\n", name);                                        \
        } else {                                                                \
            printf("  FAIL %s\n", name);                                        \
            failures++;                                                         \
        }                                                                       \
    } while (0)

static int hex2byte(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static size_t hex2bin(const char *hex, uint8_t *out, size_t max) {
    size_t n = strlen(hex) / 2;
    if (n > max) n = max;
    for (size_t i = 0; i < n; i++) {
        out[i] = (uint8_t)((hex2byte(hex[i * 2]) << 4) | hex2byte(hex[i * 2 + 1]));
    }
    return n;
}

int main(void) {
    printf("AKP v1 codec tests (cross-checked with TS implementation)\n");

    /* --- CRC vectors --- */
    const char *s = "123456789";
    CHECK(akp_crc8((const uint8_t *)s, 9) == 0xF4u, "crc8('123456789') == 0xF4");
    CHECK(akp_crc16((const uint8_t *)s, 9) == 0x29B1u, "crc16('123456789') == 0x29B1");

    /* --- message encode vector ---
     * STATE {state:thinking, agent:codex}, seq 7 from TS:
     * 4b010500070024007b227374617465223a227468696e6b696e67222c226167656e74223a22636f646578227dcd1c
     */
    uint8_t msg[AKP_MSG_MAX_SIZE];
    const char *payload = "{\"state\":\"thinking\",\"agent\":\"codex\"}";
    uint16_t msg_len = akp_encode_message(AKP_MSG_STATE, (const uint8_t *)payload, strlen(payload), 7, 0, msg);
    const char *msg_expected =
        "4b010500070024007b227374617465223a227468696e6b696e67222c226167656e74223a22636f646578227dcd1c";
    uint8_t exp[AKP_MSG_MAX_SIZE];
    size_t exp_len = hex2bin(msg_expected, exp, sizeof(exp));
    CHECK(msg_len == exp_len && memcmp(msg, exp, exp_len) == 0, "message encode matches TS vector");

    /* --- frame fragmentation vector (MTU 32) --- */
    uint8_t frames[16][AKP_MTU];
    uint8_t n = akp_frame_message(msg, msg_len, frames, 16);
    CHECK(n == 2, "message splits into 2 frames at MTU 32");
    const char *f0 = "a5801c4b010500070024007b227374617465223a227468696e6b696e67222c88";
    const char *f1 = "a50112226167656e74223a22636f646578227dcd1c58";
    uint8_t e0[AKP_MTU], e1[AKP_MTU];
    size_t e0l = hex2bin(f0, e0, AKP_MTU), e1l = hex2bin(f1, e1, AKP_MTU);
    CHECK(e0l == AKP_MTU && memcmp(frames[0], e0, AKP_MTU) == 0, "frame 0 matches TS vector");
    /* C pads frames to the fixed HID report size (AKP_MTU); TS emits only the
     * used bytes. The meaningful prefix must match and the tail must be zero. */
    CHECK(memcmp(frames[1], e1, e1l) == 0, "frame 1 prefix matches TS vector");
    {
        bool tail_zero = true;
        for (size_t i = e1l; i < AKP_MTU; i++) {
            if (frames[1][i] != 0) tail_zero = false;
        }
        CHECK(tail_zero, "frame 1 zero-padded to report size");
    }

    /* --- reassembly --- */
    akp_reset_reassembly();
    uint8_t out[AKP_MSG_MAX_SIZE];
    uint16_t out_len = 0;
    CHECK(akp_decode_report(frames[0], AKP_MTU, out, &out_len) == false, "frame 0: partial");
    bool complete = akp_decode_report(frames[1], AKP_MTU, out, &out_len);
    CHECK(complete, "frame 1: message complete");
    CHECK(out_len == msg_len && memcmp(out, msg, msg_len) == 0, "reassembled message matches original");

    /* --- leading report-id tolerance --- */
    akp_reset_reassembly();
    uint8_t with_id[AKP_MTU + 1];
    with_id[0] = 0x00;
    memcpy(&with_id[1], frames[0], AKP_MTU);
    uint8_t with_id2[AKP_MTU + 1];
    with_id2[0] = 0x00;
    memcpy(&with_id2[1], frames[1], AKP_MTU);
    CHECK(akp_decode_report(with_id, AKP_MTU + 1, out, &out_len) == false, "report-id frame 0: partial");
    complete = akp_decode_report(with_id2, AKP_MTU + 1, out, &out_len);
    CHECK(complete && out_len == msg_len && memcmp(out, msg, msg_len) == 0,
          "report-id reassembly works");

    /* --- garbage reports are ignored --- */
    akp_reset_reassembly();
    uint8_t garbage[8] = {0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
    CHECK(akp_decode_report(garbage, 8, out, &out_len) == false, "non-AKP report ignored");

    /* --- CRC corruption detected --- */
    akp_reset_reassembly();
    uint8_t bad[AKP_MTU];
    memcpy(bad, frames[0], AKP_MTU);
    bad[AKP_MTU - 1] ^= 0xFF;
    CHECK(akp_decode_report(bad, AKP_MTU, out, &out_len) == false, "corrupt frame rejected");

    /* --- JSON accessor --- */
    const char *state_json = "{\"state\":\"tool\",\"agent\":\"dsh\",\"color\":{\"r\":150,\"g\":60,\"b\":220}}";
    char tmp[32];
    CHECK(akp_json_find(state_json, strlen(state_json), "state", tmp, sizeof(tmp)) == 1 &&
              strcmp(tmp, "tool") == 0,
          "json state string extracted");
    /* find the color object: locate "color" key then the nested "r" */
    /* akp_json_find_at starts scanning at a byte offset */
    CHECK(akp_json_find_at(state_json, strlen(state_json), 0, "color", tmp, sizeof(tmp)) == 0,
          "color is an object (not string/number)");
    /* find "r" after the color key: scan from where "color" appeared */
    const char *r_key = strstr(state_json, "\"color\"");
    uint16_t r_off = (uint16_t)(r_key - state_json);
    CHECK(akp_json_find_at(state_json, strlen(state_json), r_off, "r", tmp, sizeof(tmp)) == 2 &&
              strcmp(tmp, "150") == 0,
          "nested color.r extracted");
    const char *screen_json = "{\"lines\":[\"AI Console\",\"thinking...\"],\"title\":\"codex\"}";
    CHECK(akp_json_find(screen_json, strlen(screen_json), "title", tmp, sizeof(tmp)) == 1 &&
              strcmp(tmp, "codex") == 0,
          "screen title extracted");

    /* --- heartbeat JSON --- */
    const char *hb_json = "{\"t\":1700000000,\"state\":\"idle\"}";
    CHECK(akp_json_find(hb_json, strlen(hb_json), "state", tmp, sizeof(tmp)) == 1 &&
              strcmp(tmp, "idle") == 0,
          "heartbeat state extracted");

    printf("\n%s (%d failures)\n", failures == 0 ? "ALL TESTS PASSED" : "TESTS FAILED", failures);
    return failures == 0 ? 0 : 1;
}
