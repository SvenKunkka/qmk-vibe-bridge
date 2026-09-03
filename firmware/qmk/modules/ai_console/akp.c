/*
 * AKP v1 — pure C implementation.
 * Mirrors packages/protocol/src/crc.ts, frame.ts and message.ts exactly.
 */

#include "akp.h"
#include <string.h>

uint8_t akp_crc8(const uint8_t *data, uint16_t len) {
    uint8_t crc = 0x00u;
    for (uint16_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (uint8_t k = 0; k < 8; k++) {
            crc = (crc & 0x80u) ? (uint8_t)((crc << 1) ^ 0x07u) : (uint8_t)(crc << 1);
        }
    }
    return crc;
}

uint16_t akp_crc16(const uint8_t *data, uint16_t len) {
    uint16_t crc = 0xFFFFu;
    for (uint16_t i = 0; i < len; i++) {
        crc ^= (uint16_t)(data[i] & 0xFFu) << 8u;
        for (uint8_t k = 0; k < 8; k++) {
            crc = (crc & 0x8000u) ? (uint16_t)((crc << 1) ^ 0x1021u) : (uint16_t)(crc << 1);
        }
    }
    return crc;
}

uint16_t akp_encode_message(uint8_t type, const uint8_t *payload, uint16_t payload_len,
                            uint16_t seq, uint8_t flags, uint8_t *out) {
    if (payload_len > AKP_PAYLOAD_MAX) return 0;
    uint16_t total = (uint16_t)(AKP_MSG_HEADER + payload_len + 2u);
    out[0] = AKP_MSG_MAGIC;
    out[1] = AKP_PROTO_VERSION;
    out[2] = type;
    out[3] = flags;
    out[4] = (uint8_t)(seq & 0xFFu);
    out[5] = (uint8_t)((seq >> 8) & 0xFFu);
    out[6] = (uint8_t)(payload_len & 0xFFu);
    out[7] = (uint8_t)((payload_len >> 8) & 0xFFu);
    if (payload_len > 0 && payload != NULL) {
        memcpy(&out[AKP_MSG_HEADER], payload, payload_len);
    }
    uint16_t crc = akp_crc16(out, (uint16_t)(AKP_MSG_HEADER + payload_len));
    out[total - 2] = (uint8_t)(crc & 0xFFu);
    out[total - 1] = (uint8_t)((crc >> 8) & 0xFFu);
    return total;
}

uint8_t akp_frame_message(const uint8_t *msg, uint16_t msg_len,
                          uint8_t (*frames)[AKP_MTU], uint8_t max_frames) {
    uint8_t count = 0;
    uint16_t offset = 0;
    uint8_t index = 0;
    do {
        if (count >= max_frames) return 0;
        uint16_t chunk = msg_len - offset;
        if (chunk > AKP_FRAME_DATA_MAX) chunk = AKP_FRAME_DATA_MAX;
        bool more = (offset + chunk) < msg_len;
        uint8_t *f = frames[count];
        memset(f, 0, AKP_MTU); /* fixed-size HID reports are zero-padded */
        f[0] = AKP_FRAME_MAGIC;
        f[1] = (more ? AKP_FRAME_FLAG_MORE : 0u) | (index & AKP_FRAME_INDEX_MASK);
        f[2] = (uint8_t)chunk;
        if (chunk > 0) memcpy(&f[3], &msg[offset], chunk);
        f[3 + chunk] = akp_crc8(f, 3 + chunk);
        count++;
        offset += chunk;
        index = (index + 1u) & AKP_FRAME_INDEX_MASK;
    } while (offset < msg_len);
    return count;
}

/* ---- reassembly state ---- */
static uint8_t reassembly[AKP_MSG_MAX_SIZE];
static uint16_t reassembly_len = 0;
static uint8_t reassembly_index = 0;
static bool reassembly_started = false;

void akp_reset_reassembly(void) {
    reassembly_len = 0;
    reassembly_started = false;
}

bool akp_decode_report(const uint8_t *report, uint8_t report_len,
                       uint8_t *out_msg, uint16_t *out_len) {
    uint8_t off = 0;
    if (report[0] != AKP_FRAME_MAGIC) {
        if (report_len > 1 && report[1] == AKP_FRAME_MAGIC &&
            (report[0] == 0x00u || report[0] == 0x01u)) {
            off = 1; /* leading HID report id */
        } else {
            return false;
        }
    }
    uint8_t flags = report[off + 1];
    uint8_t len = report[off + 2];
    if ((uint16_t)off + 3u + len > report_len) return false;
    uint8_t crc = akp_crc8(&report[off], 3u + len);
    if (report[off + 3u + len] != crc) return false;

    bool more = (flags & AKP_FRAME_FLAG_MORE) != 0;
    uint8_t index = flags & AKP_FRAME_INDEX_MASK;

    if (!reassembly_started) {
        reassembly_started = true;
        reassembly_index = index;
        reassembly_len = 0;
    }
    if (index != reassembly_index) {
        /* out-of-order / lost frame: drop the partial message */
        reassembly_started = false;
        reassembly_len = 0;
        *out_len = 0;
        return false;
    }
    if (reassembly_len + len > AKP_MSG_MAX_SIZE) {
        reassembly_started = false;
        reassembly_len = 0;
        *out_len = 0;
        return false;
    }
    memcpy(&reassembly[reassembly_len], &report[off + 3], len);
    reassembly_len += len;
    reassembly_index = (reassembly_index + 1u) & AKP_FRAME_INDEX_MASK;
    if (!more) {
        memcpy(out_msg, reassembly, reassembly_len);
        *out_len = reassembly_len;
        reassembly_started = false;
        reassembly_len = 0;
        return true;
    }
    *out_len = reassembly_len;
    return false;
}

/* ---- tiny JSON accessor (for our controlled payloads) ---- */

static uint8_t json_value_at(const char *json, uint16_t len, uint16_t *pos,
                             char *out, uint16_t outlen) {
    /* skip whitespace */
    while (*pos < len && (json[*pos] == ' ' || json[*pos] == '\t' || json[*pos] == '\n' || json[*pos] == '\r')) {
        (*pos)++;
    }
    if (*pos >= len) return 0;
    char c = json[*pos];
    if (c == '"') {
        (*pos)++;
        uint16_t o = 0;
        while (*pos < len && json[*pos] != '"') {
            if (json[*pos] == '\\' && *pos + 1 < len) {
                (*pos)++;
                if (o + 1 < outlen) out[o++] = json[*pos];
                (*pos)++;
            } else {
                if (o + 1 < outlen) out[o++] = json[*pos];
                (*pos)++;
            }
        }
        if (*pos < len) (*pos)++; /* closing quote */
        if (o < outlen) out[o] = '\0';
        return 1; /* string */
    }
    if (c == '-' || (c >= '0' && c <= '9')) {
        uint16_t o = 0;
        while (*pos < len && (json[*pos] == '-' || json[*pos] == '.' || (json[*pos] >= '0' && json[*pos] <= '9'))) {
            if (o + 1 < outlen) out[o++] = json[*pos];
            (*pos)++;
        }
        if (o < outlen) out[o] = '\0';
        return 2; /* number */
    }
    /* true/false/null or object/array — unsupported here */
    return 0;
}

uint8_t akp_json_find_at(const char *json, uint16_t len, uint16_t start,
                         const char *key, char *out, uint16_t outlen) {
    uint16_t keylen = 0;
    while (key[keylen]) keylen++;
    uint16_t i = start;
    while (i + keylen < len) {
        /* look for `"key":` */
        if (json[i] == '"') {
            bool match = true;
            for (uint16_t k = 0; k < keylen; k++) {
                if (i + 1u + k >= len || json[i + 1u + k] != key[k]) {
                    match = false;
                    break;
                }
            }
            if (match && i + 1u + keylen < len && json[i + 1u + keylen] == '"') {
                uint16_t p = i + 1u + keylen + 1u;
                while (p < len && json[p] == ' ' ) p++;
                if (p < len && json[p] == ':') {
                    p++;
                    return json_value_at(json, len, &p, out, outlen);
                }
            }
            /* skip to end of this string */
            i += 2;
            while (i < len && json[i] != '"') {
                if (json[i] == '\\') i++;
                i++;
            }
            i++;
        } else {
            i++;
        }
    }
    return 0;
}

uint8_t akp_json_find(const char *json, uint16_t len, const char *key,
                      char *out, uint16_t outlen) {
    return akp_json_find_at(json, len, 0, key, out, outlen);
}
