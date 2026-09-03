/*
 * AI Console — QMK glue (module main file).
 *
 * Requirements (enable in your keyboard's rules.mk):
 *   RAW_ENABLE = yes            (mandatory)
 *   ENCODER_ENABLE = yes        (optional, knob support)
 *   OLED_ENABLE = yes           (optional, screen feedback)
 *   RGB_MATRIX_ENABLE = yes     (optional, per-key RGB)
 *   RGBLIGHT_ENABLE = yes       (optional, simple RGB)
 *   AUDIO_ENABLE = yes          (optional)
 *
 * Capability negotiation: the keyboard sends HELLO on boot; the host replies
 * CAPS enabling only the features the board actually has (no RGB -> host
 * stops sending RGB payloads; no OLED -> host stops sending SCREEN).
 */

#include "ai_console.h"
#include "akp.h"

#include <string.h>
#include <stdio.h>

#if defined(RAW_ENABLE)
#include "raw_hid.h"
#endif
#if defined(OLED_ENABLE)
#include "oled_driver.h"
#endif
#if defined(RGB_MATRIX_ENABLE)
#include "rgb_matrix.h"
#endif
#if defined(RGBLIGHT_ENABLE)
#include "rgblight.h"
#endif

/* ------------------------------------------------------------------ */
/* configuration (override in your keyboard's config.h)               */
/* ------------------------------------------------------------------ */

#ifndef AI_CONSOLE_HOST_TIMEOUT_MS
#define AI_CONSOLE_HOST_TIMEOUT_MS 6000
#endif

#ifndef AI_CONSOLE_OLED_LINES
#define AI_CONSOLE_OLED_LINES 4
#endif

#ifndef AI_CONSOLE_OLED_LINE_LEN
#define AI_CONSOLE_OLED_LINE_LEN 21
#endif

/* status LED (optional): define AI_CONSOLE_STATUS_LED_PIN in config.h */
#ifdef AI_CONSOLE_STATUS_LED_PIN
#ifndef AI_CONSOLE_STATUS_LED_ON_LEVEL
#define AI_CONSOLE_STATUS_LED_ON_LEVEL 1
#endif
#endif

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

typedef struct {
    uint8_t state; /* AgentState string index, see below */
    uint8_t rgb[3];
    uint8_t brightness;
    bool host_connected;
    uint32_t last_heartbeat;
    uint32_t last_send; /* throttle for CMD */
    bool oled_enabled;
    bool rgb_per_key;
    uint16_t led_count;
} ai_console_state_t;

static ai_console_state_t g_state;
static char g_oled_lines[AI_CONSOLE_OLED_LINES][AI_CONSOLE_OLED_LINE_LEN];
static uint16_t g_seq = 0;

/* AgentState enum mirrored from the protocol (docs/PROTOCOL.md §5). */
enum {
    AGENT_IDLE = 0,
    AGENT_THINKING,
    AGENT_TOOL,
    AGENT_WAITING,
    AGENT_DONE,
    AGENT_ERROR,
    AGENT_DISCONNECTED,
    AGENT_DICTATING,
};

static uint16_t next_seq(void) { return ++g_seq; }

static void set_oled_line(uint8_t idx, const char *text) {
    if (idx >= AI_CONSOLE_OLED_LINES) return;
    uint8_t n = 0;
    while (text[n] && n < AI_CONSOLE_OLED_LINE_LEN - 1) {
        g_oled_lines[idx][n] = text[n];
        n++;
    }
    g_oled_lines[idx][n] = '\0';
}

static const char *state_name(uint8_t s) {
    switch (s) {
        case AGENT_IDLE: return "idle";
        case AGENT_THINKING: return "thinking";
        case AGENT_TOOL: return "tool";
        case AGENT_WAITING: return "waiting";
        case AGENT_DONE: return "done";
        case AGENT_ERROR: return "error";
        case AGENT_DISCONNECTED: return "disconnected";
        case AGENT_DICTATING: return "dictating";
        default: return "unknown";
    }
}

static uint8_t state_from_name(const char *name) {
    if (strcmp(name, "thinking") == 0) return AGENT_THINKING;
    if (strcmp(name, "tool") == 0) return AGENT_TOOL;
    if (strcmp(name, "waiting") == 0) return AGENT_WAITING;
    if (strcmp(name, "done") == 0) return AGENT_DONE;
    if (strcmp(name, "error") == 0) return AGENT_ERROR;
    if (strcmp(name, "disconnected") == 0) return AGENT_DISCONNECTED;
    if (strcmp(name, "dictating") == 0) return AGENT_DICTATING;
    return AGENT_IDLE;
}

/* ------------------------------------------------------------------ */
/* sending (keyboard -> host)                                          */
/* ------------------------------------------------------------------ */

static bool akp_send_bytes(const uint8_t *msg, uint16_t msg_len) {
#if defined(RAW_ENABLE)
    uint8_t frames[16][AKP_MTU];
    uint8_t n = akp_frame_message(msg, msg_len, frames, 16);
    if (n == 0) return false;
    for (uint8_t i = 0; i < n; i++) {
        raw_hid_send(frames[i], AKP_MTU);
    }
    return true;
#else
    (void)msg;
    (void)msg_len;
    return false;
#endif
}

static bool akp_send_json(uint8_t type, const char *json, bool ack_req) {
    uint8_t msg[AKP_MSG_MAX_SIZE];
    uint16_t len = akp_encode_message(type, (const uint8_t *)json, strlen(json), next_seq(),
                                      ack_req ? AKP_MSG_FLAG_ACK_REQ : 0u, msg);
    if (len == 0) return false;
    return akp_send_bytes(msg, len);
}

/* Sends CMD {action, source, ts}. */
bool ai_console_send_cmd(const char *action, const char *source) {
    char json[160];
    snprintf(json, sizeof(json), "{\"action\":\"%s\",\"source\":\"%s\",\"ts\":%lu}",
             action, source, (unsigned long)(timer_read32() / 1000));
    return akp_send_json(AKP_MSG_CMD, json, true);
}

bool ai_console_send_encoder(int8_t dir) {
    char json[96];
    snprintf(json, sizeof(json), "{\"dir\":%d,\"ts\":%lu}", dir, (unsigned long)(timer_read32() / 1000));
    return akp_send_json(AKP_MSG_ENCODER, json, false);
}

/* Sends HELLO with this keyboard's capabilities. */
void ai_console_send_hello(void) {
    char json[256];
    char features[160];
    uint16_t f = 0;
    f += (uint16_t)snprintf(features + f, sizeof(features) - f, "\"raw_hid\",\"f13_f24\"");
#if defined(ENCODER_ENABLE)
    f += (uint16_t)snprintf(features + f, sizeof(features) - f, ",\"encoder\"");
#endif
#if defined(RGB_MATRIX_ENABLE)
    f += (uint16_t)snprintf(features + f, sizeof(features) - f, ",\"rgb_matrix\"");
#endif
#if defined(RGBLIGHT_ENABLE)
    f += (uint16_t)snprintf(features + f, sizeof(features) - f, ",\"rgb_light\"");
#endif
#if defined(OLED_ENABLE)
    f += (uint16_t)snprintf(features + f, sizeof(features) - f, ",\"oled\"");
#endif
#ifdef AI_CONSOLE_STATUS_LED_PIN
    f += (uint16_t)snprintf(features + f, sizeof(features) - f, ",\"status_led\"");
#endif
#if defined(RGB_MATRIX_ENABLE) && defined(RGB_MATRIX_LED_COUNT)
    snprintf(json, sizeof(json),
             "{\"proto\":1,\"fw\":\"qmk\",\"fw_version\":\"0.9.0\",\"features\":[%s],\"led_count\":%d}",
             features, RGB_MATRIX_LED_COUNT);
#else
    snprintf(json, sizeof(json), "{\"proto\":1,\"fw\":\"qmk\",\"fw_version\":\"0.9.0\",\"features\":[%s]}", features);
#endif
    akp_send_json(AKP_MSG_HELLO, json, false);
}

/* ------------------------------------------------------------------ */
/* receiving (host -> keyboard)                                        */
/* ------------------------------------------------------------------ */

#if defined(RGB_MATRIX_ENABLE) || defined(RGBLIGHT_ENABLE)
/* RGB -> HSV (QMK rgb_matrix/rgblight are HSV-based). */
static void rgb_to_hsv(uint8_t r, uint8_t g, uint8_t b, uint16_t *h, uint8_t *s, uint8_t *v) {
    uint8_t max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    uint8_t min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    *v = max;
    if (max == 0) {
        *h = 0;
        *s = 0;
        return;
    }
    *s = (uint8_t)(((uint16_t)(max - min)) * 255u / max);
    if (max == min) {
        *h = 0;
        return;
    }
    int16_t hh;
    uint16_t d = (uint16_t)(max - min);
    if (max == r) hh = (int16_t)(60 * ((int16_t)g - b) / d);
    else if (max == g) hh = (int16_t)(60 * (2 + ((int16_t)b - r) / d));
    else hh = (int16_t)(60 * (4 + ((int16_t)r - g) / d));
    if (hh < 0) hh += 360;
    *h = (uint16_t)(hh % 360);
}
#endif /* RGB_MATRIX_ENABLE || RGBLIGHT_ENABLE */

static void apply_rgb(uint8_t r, uint8_t g, uint8_t b, uint8_t brightness) {
#if defined(RGB_MATRIX_ENABLE)
    uint16_t h;
    uint8_t s, v;
    rgb_to_hsv(r, g, b, &h, &s, &v);
    /* brightness 0-100 -> val 0-255 */
    rgb_matrix_sethsv_noeeprom(h, s, brightness > 100 ? 255 : (uint8_t)((uint16_t)brightness * 255u / 100u));
#elif defined(RGBLIGHT_ENABLE)
    uint16_t h;
    uint8_t s, v;
    rgb_to_hsv(r, g, b, &h, &s, &v);
    rgblight_sethsv((uint8_t)h, s, brightness > 100 ? 255 : (uint8_t)((uint16_t)brightness * 255u / 100u));
#else
    (void)r; (void)g; (void)b; (void)brightness;
#endif
}

static void set_status_led(uint8_t state) {
#ifdef AI_CONSOLE_STATUS_LED_PIN
    /* solid on = connected, fast blink = waiting approval, off = disconnected */
    static uint32_t last_toggle = 0;
    bool on;
    switch (state) {
        case AGENT_DISCONNECTED:
            on = false;
            break;
        case AGENT_WAITING: {
            uint32_t now = timer_read32();
            on = ((now - last_toggle) < 120);
            if (now - last_toggle >= 240) last_toggle = now;
            break;
        }
        default:
            on = true;
            break;
    }
    writePin(AI_CONSOLE_STATUS_LED_PIN, on ? AI_CONSOLE_STATUS_LED_ON_LEVEL : !AI_CONSOLE_STATUS_LED_ON_LEVEL);
#endif
}

static void handle_state_json(const char *json, uint16_t len) {
    char tmp[40];
    if (akp_json_find(json, len, "state", tmp, sizeof(tmp)) == 1) {
        g_state.state = state_from_name(tmp);
    }
    /* color: {r,g,b} — find "color" offset then nested fields */
    const char *color_key = strstr(json, "\"color\"");
    if (color_key != NULL) {
        uint16_t off = (uint16_t)(color_key - json);
        uint8_t r = 0, g = 0, b = 0;
        if (akp_json_find_at(json, len, off, "r", tmp, sizeof(tmp)) == 2) r = (uint8_t)atoi(tmp);
        if (akp_json_find_at(json, len, off, "g", tmp, sizeof(tmp)) == 2) g = (uint8_t)atoi(tmp);
        if (akp_json_find_at(json, len, off, "b", tmp, sizeof(tmp)) == 2) b = (uint8_t)atoi(tmp);
        g_state.rgb[0] = r;
        g_state.rgb[1] = g;
        g_state.rgb[2] = b;
        apply_rgb(r, g, b, g_state.brightness);
    }
    /* text -> OLED line 3 (title) */
    if (akp_json_find(json, len, "text", tmp, sizeof(tmp)) == 1) {
        set_oled_line(2, tmp);
    }
    if (akp_json_find(json, len, "agent", tmp, sizeof(tmp)) == 1) {
        set_oled_line(1, tmp);
    }
    set_status_led(g_state.state);
}

static void handle_rgb_json(const char *json, uint16_t len) {
    char tmp[24];
    uint8_t mode = akp_json_find(json, len, "mode", tmp, sizeof(tmp));
    if (mode == 1 && strcmp(tmp, "off") == 0) {
        g_state.brightness = 0;
        apply_rgb(0, 0, 0, 0);
        return;
    }
    if (mode == 1 && strcmp(tmp, "solid") == 0) {
        const char *color_key = strstr(json, "\"color\"");
        if (color_key != NULL) {
            uint16_t off = (uint16_t)(color_key - json);
            uint8_t r = 0, gg = 0, b = 0;
            if (akp_json_find_at(json, len, off, "r", tmp, sizeof(tmp)) == 2) r = (uint8_t)atoi(tmp);
            if (akp_json_find_at(json, len, off, "g", tmp, sizeof(tmp)) == 2) gg = (uint8_t)atoi(tmp);
            if (akp_json_find_at(json, len, off, "b", tmp, sizeof(tmp)) == 2) b = (uint8_t)atoi(tmp);
            g_state.rgb[0] = r;
            g_state.rgb[1] = gg;
            g_state.rgb[2] = b;
        }
        if (akp_json_find(json, len, "brightness", tmp, sizeof(tmp)) == 2) {
            g_state.brightness = (uint8_t)atoi(tmp);
        }
        apply_rgb(g_state.rgb[0], g_state.rgb[1], g_state.rgb[2], g_state.brightness);
    }
}

static void handle_rgb_binary(const uint8_t *payload, uint16_t len) {
#if defined(RGB_MATRIX_ENABLE)
    if (len < 3) return;
    uint8_t flags = payload[0];
    uint16_t count = (uint16_t)(payload[1] | (payload[2] << 8));
    bool rgbw = (flags & 0x02) != 0;
    uint16_t need = 3u + count * (rgbw ? 4u : 3u);
    if (len < need || count > RGB_MATRIX_LED_COUNT) return;
    for (uint16_t i = 0; i < count; i++) {
        uint16_t p = 3u + i * (rgbw ? 4u : 3u);
        rgb_matrix_set_color(i, payload[p], payload[p + 1], payload[p + 2]);
    }
    g_state.rgb_per_key = true;
#else
    (void)payload;
    (void)len;
#endif
}

/* extract up to n string values (OLED lines) in order from the payload */
static uint8_t collect_strings(const char *json, uint16_t len, char out[][AI_CONSOLE_OLED_LINE_LEN], uint8_t max) {
    uint8_t n = 0;
    uint16_t i = 0;
    while (i < len && n < max) {
        if (json[i] == '"') {
            /* skip the key if followed by ':' — collect only values */
            uint16_t j = i + 1;
            while (j < len && json[j] != '"') j++;
            /* look ahead for ':' */
            uint16_t k = j + 1;
            while (k < len && json[k] == ' ') k++;
            if (k < len && json[k] == ':') {
                i = k + 1; /* it was a key; continue scanning for a value */
                continue;
            }
            /* value string */
            uint16_t v = i + 1;
            uint16_t o = 0;
            while (v < len && json[v] != '"' && o < AI_CONSOLE_OLED_LINE_LEN - 1) {
                out[n][o++] = json[v++];
            }
            out[n][o] = '\0';
            n++;
            i = v + 1;
        } else {
            i++;
        }
    }
    return n;
}

static void handle_screen_json(const char *json, uint16_t len) {
    char lines[AI_CONSOLE_OLED_LINES][AI_CONSOLE_OLED_LINE_LEN];
    memset(lines, 0, sizeof(lines));
    uint8_t n = collect_strings(json, len, lines, AI_CONSOLE_OLED_LINES);
    for (uint8_t i = 0; i < n; i++) {
        set_oled_line(i, lines[i]);
    }
}

static void handle_caps_json(const char *json, uint16_t len) {
    char tmp[16];
    /* rgb.per_key — nested; just track led_count at top level (not present);
       host decides what to send based on HELLO features; we just log. */
    (void)json;
    (void)len;
    if (akp_json_find(json, len, "features", tmp, sizeof(tmp)) == 0) {
        /* features is an array; ignore */
    }
    g_state.host_connected = true;
}

void ai_console_raw_hid_receive(uint8_t *data, uint8_t length) {
    uint8_t msg[AKP_MSG_MAX_SIZE];
    uint16_t msg_len = 0;
    if (!akp_decode_report(data, length, msg, &msg_len)) return;
    if (msg_len < AKP_MSG_HEADER) return;
    uint8_t type = msg[2];
    uint16_t payload_len = (uint16_t)(msg[6] | (msg[7] << 8));
    uint16_t total = (uint16_t)(AKP_MSG_HEADER + payload_len);
    if (total + 2u > msg_len) return;
    const uint8_t *payload = &msg[AKP_MSG_HEADER];

    switch (type) {
        case AKP_MSG_CAPS:
            g_state.host_connected = true;
            handle_caps_json((const char *)payload, payload_len);
            break;
        case AKP_MSG_HEARTBEAT:
            g_state.last_heartbeat = timer_read32();
            g_state.host_connected = true;
            set_status_led(g_state.state);
            /* echo heartbeat so the host knows we are alive */
            {
                char json[64];
                snprintf(json, sizeof(json), "{\"t\":%lu,\"state\":\"%s\"}",
                         (unsigned long)(timer_read32() / 1000), state_name(g_state.state));
                akp_send_json(AKP_MSG_HEARTBEAT, json, false);
            }
            break;
        case AKP_MSG_STATE:
            handle_state_json((const char *)payload, payload_len);
            break;
        case AKP_MSG_RGB:
            /* strict per-key flag check: 0x01 per-key / 0x03 per-key+rgbw.
             * JSON payloads start with '{' (0x7B) which also has bit0 set —
             * a naive & 0x01 misclassifies JSON RGB as binary. */
            if (payload_len > 0 && (payload[0] == 0x01 || payload[0] == 0x03)) {
                handle_rgb_binary(payload, payload_len);
            } else {
                handle_rgb_json((const char *)payload, payload_len);
            }
            break;
        case AKP_MSG_SCREEN:
            handle_screen_json((const char *)payload, payload_len);
            break;
        case AKP_MSG_ACK:
            /* previous CMD acknowledged by host */
            break;
        case AKP_MSG_ERR:
            break;
        default:
            break;
    }
}

#if defined(RAW_ENABLE)
void raw_hid_receive_kb(uint8_t *data, uint8_t length) {
    ai_console_raw_hid_receive(data, length);
}
#endif

/* ------------------------------------------------------------------ */
/* keymap-facing API                                                   */
/* ------------------------------------------------------------------ */

bool ai_console_process_record(uint16_t keycode, keyrecord_t *record) {
    if (keycode < AI_SELECT_AGENT || keycode > AI_CUSTOM_3) return true;
    if (record->event.pressed) {
        const char *action = NULL;
        const char *source = NULL;
        switch (keycode) {
            case AI_SELECT_AGENT: action = "select_agent"; source = "F13"; break;
            case AI_APPROVE: action = "approve"; source = "F14"; break;
            case AI_REJECT: action = "reject"; source = "F15"; break;
            case AI_NEW_TASK: action = "new_task"; source = "F16"; break;
            case AI_SEND: action = "send"; source = "F17"; break;
            case AI_DICTATE: action = "dictate"; source = "F18"; break;
            case AI_FAST_MODE: action = "fast_mode"; source = "F19"; break;
            case AI_REASONING_UP: action = "reasoning_up"; source = "F20"; break;
            case AI_REASONING_DOWN: action = "reasoning_down"; source = "F21"; break;
            case AI_CANCEL: action = "cancel"; source = "F22"; break;
            case AI_PAUSE: action = "pause"; source = "F23"; break;
            case AI_RESUME: action = "resume"; source = "F24"; break;
            default: action = "custom"; source = "CUSTOM"; break;
        }
        ai_console_send_cmd(action, source);
    }
    return false; /* consume the key */
}

bool ai_console_encoder_update(bool clockwise) {
    ai_console_send_encoder(clockwise ? 1 : -1);
    return false;
}

void ai_console_init(void) {
    g_state.state = AGENT_IDLE;
    g_state.brightness = 60;
    g_state.host_connected = false;
    memset(g_oled_lines, 0, sizeof(g_oled_lines));
    set_oled_line(0, "AI Console");
    set_oled_line(1, "waiting for host...");
#if defined(RAW_ENABLE)
    ai_console_send_hello();
#endif
}

void ai_console_task(void) {
    /* host timeout -> disconnected state (lights off) */
    if (g_state.host_connected && timer_elapsed32(g_state.last_heartbeat) > AI_CONSOLE_HOST_TIMEOUT_MS) {
        g_state.host_connected = false;
        apply_rgb(0, 0, 0, 0);
        set_oled_line(1, "host disconnected");
        set_status_led(AGENT_DISCONNECTED);
    }
}

#if defined(OLED_ENABLE)
void ai_console_oled_render(void) {
    for (uint8_t i = 0; i < AI_CONSOLE_OLED_LINES; i++) {
        oled_write_ln_P(g_oled_lines[i], false);
    }
    oled_render();
}
#endif

#if defined(RGB_MATRIX_ENABLE)
void ai_console_rgb_matrix_indicators(void) {
    /* per-key colors were stored by handle_rgb_binary */
}
#endif

/* automatic hooks (weak — override by defining your own in the keymap) */
__attribute__((weak)) void matrix_scan_user(void) {
    ai_console_task();
}
#if defined(OLED_ENABLE)
__attribute__((weak)) bool oled_task_user(void) {
    ai_console_oled_render();
    return false;
}
#endif
#if defined(RGB_MATRIX_ENABLE)
__attribute__((weak)) bool rgb_matrix_indicators_user(void) {
    ai_console_rgb_matrix_indicators();
    return false;
}
#endif
