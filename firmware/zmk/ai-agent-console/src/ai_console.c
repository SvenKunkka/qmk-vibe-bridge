/*
 * AI Console — ZMK console state machine.
 *
 * Owns the AKP device role: sends HELLO after boot, listens for CAPS /
 * STATE / RGB / SCREEN / HEARTBEAT, renders agent status to the RGB
 * underglow and the OLED display, and exposes send helpers used by the
 * ai-console-key behavior (commands, encoder).
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#include <akp/akp.h>
#include <raw_hid/raw_hid.h>

#if IS_ENABLED(CONFIG_AI_CONSOLE_UNDERGLOW)
#include <zmk/rgb_underglow.h>
#endif

#if IS_ENABLED(CONFIG_AI_CONSOLE_OLED)
#include <zmk/display.h>
#include <lvgl.h>
#endif

#define AI_OLED_LINES 4
#define AI_OLED_LINE_LEN 21

#if IS_ENABLED(CONFIG_AI_CONSOLE_OLED)
void ai_console_display_update(void);
#endif

/* ---- agent state colors (docs/PROTOCOL.md §5) ---- */
static const struct { uint16_t h; uint8_t s; uint8_t b; } ai_state_hsb[] = {
    /* idle */    {0, 0, 100},     /* white */
    /* thinking */{210, 100, 90},  /* blue 0x0078FF */
    /* tool */    {268, 70, 85},   /* purple 0x963CDC */
    /* waiting */ {33, 100, 95},   /* orange 0xFF8C00 */
    /* done */    {142, 100, 85},  /* green 0x00DC50 */
    /* error */   {0, 100, 95},    /* red 0xFF2828 */
    /* disconnected */ {0, 0, 0},  /* off */
    /* dictating */{180, 100, 90},
};

enum { AI_STATE_IDLE = 0, AI_STATE_THINKING, AI_STATE_TOOL, AI_STATE_WAITING,
       AI_STATE_DONE, AI_STATE_ERROR, AI_STATE_DISCONNECTED, AI_STATE_DICTATING };

static uint8_t ai_state = AI_STATE_IDLE;
static uint8_t ai_color[3];
static char ai_lines[AI_OLED_LINES][AI_OLED_LINE_LEN];
static uint16_t ai_seq = 0;
static int64_t ai_last_heartbeat_ms;
static bool ai_host_connected;

static uint16_t ai_next_seq(void) { return ++ai_seq; }

static int ai_state_from_name(const char *name) {
    if (strcmp(name, "thinking") == 0) return AI_STATE_THINKING;
    if (strcmp(name, "tool") == 0) return AI_STATE_TOOL;
    if (strcmp(name, "waiting") == 0) return AI_STATE_WAITING;
    if (strcmp(name, "done") == 0) return AI_STATE_DONE;
    if (strcmp(name, "error") == 0) return AI_STATE_ERROR;
    if (strcmp(name, "disconnected") == 0) return AI_STATE_DISCONNECTED;
    if (strcmp(name, "dictating") == 0) return AI_STATE_DICTATING;
    return AI_STATE_IDLE;
}

static const char *ai_state_name(uint8_t s) {
    static const char *names[] = {"idle", "thinking", "tool", "waiting",
                                  "done", "error", "disconnected", "dictating"};
    return s < 8 ? names[s] : "unknown";
}

static void ai_set_line(uint8_t idx, const char *text) {
    if (idx >= AI_OLED_LINES) return;
    uint8_t n = 0;
    while (text[n] && n < AI_OLED_LINE_LEN - 1) {
        ai_lines[idx][n] = text[n];
        n++;
    }
    ai_lines[idx][n] = '\0';
}

static struct zmk_led_hsb ai_rgb_to_hsb(uint8_t r, uint8_t g, uint8_t b) {
    uint8_t max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    uint8_t min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    uint16_t h = 0;
    uint8_t s = 0;
    uint8_t v = max;
    if (max != 0) {
        s = (uint8_t)((uint16_t)(max - min) * 100u / max);
    }
    if (max != min) {
        uint16_t d = (uint16_t)(max - min);
        int16_t hh;
        if (max == r) hh = (int16_t)(60 * ((int16_t)g - b) / d);
        else if (max == g) hh = (int16_t)(60 * (2 + ((int16_t)b - r) / d));
        else hh = (int16_t)(60 * (4 + ((int16_t)r - g) / d));
        if (hh < 0) hh += 360;
        h = (uint16_t)(hh % 360);
    }
    return (struct zmk_led_hsb){.h = h, .s = s, .b = (uint8_t)((uint16_t)v * 100u / 255u)};
}

static void ai_apply_underglow(void) {
#if IS_ENABLED(CONFIG_AI_CONSOLE_UNDERGLOW)
    if (ai_state >= 8) return;
    struct zmk_led_hsb hsb = {.h = ai_state_hsb[ai_state].h, .s = ai_state_hsb[ai_state].s,
                              .b = ai_state_hsb[ai_state].b};
    zmk_rgb_underglow_set_hsb(hsb);
#else
    (void)0;
#endif
}

/* ---- sending (keyboard -> host) ---- */

static bool ai_send_bytes(const uint8_t *msg, uint16_t msg_len) {
    uint8_t frames[16][AKP_MTU];
    uint8_t n = akp_frame_message(msg, msg_len, frames, 16);
    if (n == 0) return false;
    for (uint8_t i = 0; i < n; i++) {
        int err = ai_console_raw_hid_send(frames[i], AKP_MTU);
        if (err) {
            LOG_WRN("raw hid send failed: %d", err);
            return false;
        }
    }
    return true;
}

static bool ai_send_json(uint8_t type, const char *json) {
    uint8_t msg[AKP_MSG_MAX_SIZE];
    uint16_t len = akp_encode_message(type, (const uint8_t *)json, strlen(json), ai_next_seq(), 0,
                                      msg);
    if (len == 0) return false;
    return ai_send_bytes(msg, len);
}

/* Public: send a CMD from a key. */
int ai_console_send_cmd(const char *action, const char *source) {
    char json[160];
    snprintf(json, sizeof(json), "{\"action\":\"%s\",\"source\":\"%s\",\"ts\":%lld}", action,
             source, (long long)(k_uptime_get() / 1000));
    return ai_send_json(AKP_MSG_CMD, json) ? 0 : -EIO;
}

int ai_console_send_encoder(int8_t dir) {
    char json[96];
    snprintf(json, sizeof(json), "{\"dir\":%d,\"ts\":%lld}", dir,
             (long long)(k_uptime_get() / 1000));
    return ai_send_json(AKP_MSG_ENCODER, json) ? 0 : -EIO;
}

static void ai_send_hello(void) {
    char json[256];
    char features[160];
    uint16_t f = 0;
    f += (uint16_t)snprintf(features + f, sizeof(features) - f, "\"raw_hid\",\"f13_f24\"");
#if IS_ENABLED(CONFIG_AI_CONSOLE_UNDERGLOW)
    f += (uint16_t)snprintf(features + f, sizeof(features) - f, ",\"rgb_light\"");
#endif
#if IS_ENABLED(CONFIG_AI_CONSOLE_OLED)
    f += (uint16_t)snprintf(features + f, sizeof(features) - f, ",\"oled\"");
#endif
    snprintf(json, sizeof(json), "{\"proto\":1,\"fw\":\"zmk\",\"fw_version\":\"0.9.0\","
                                 "\"features\":[%s],\"oled_lines\":%d}",
             features, AI_OLED_LINES);
    ai_send_json(AKP_MSG_HELLO, json);
}

/* ---- receiving (host -> keyboard) ---- */

static void ai_handle_state(const uint8_t *payload, uint16_t len) {
    char tmp[40];
    if (akp_json_find((const char *)payload, len, "state", tmp, sizeof(tmp)) == 1) {
        ai_state = (uint8_t)ai_state_from_name(tmp);
    }
    const char *color_key = strstr((const char *)payload, "\"color\"");
    if (color_key != NULL) {
        uint16_t off = (uint16_t)(color_key - (const char *)payload);
        uint8_t r = 0, g = 0, b = 0;
        if (akp_json_find_at((const char *)payload, len, off, "r", tmp, sizeof(tmp)) == 2)
            r = (uint8_t)atoi(tmp);
        if (akp_json_find_at((const char *)payload, len, off, "g", tmp, sizeof(tmp)) == 2)
            g = (uint8_t)atoi(tmp);
        if (akp_json_find_at((const char *)payload, len, off, "b", tmp, sizeof(tmp)) == 2)
            b = (uint8_t)atoi(tmp);
        ai_color[0] = r;
        ai_color[1] = g;
        ai_color[2] = b;
    }
    if (akp_json_find((const char *)payload, len, "text", tmp, sizeof(tmp)) == 1) {
        ai_set_line(2, tmp);
    }
    if (akp_json_find((const char *)payload, len, "agent", tmp, sizeof(tmp)) == 1) {
        ai_set_line(1, tmp);
    }
    ai_apply_underglow();
    ai_console_display_update();
}

static void ai_handle_rgb(const uint8_t *payload, uint16_t len) {
#if IS_ENABLED(CONFIG_AI_CONSOLE_UNDERGLOW)
    char tmp[24];
    /* strict per-key flag check (0x01/0x03) — JSON starts with '{' (0x7B)
     * whose bit0 is also set, so & 0x01 alone would misclassify JSON RGB */
    if (len > 0 && (payload[0] == 0x01 || payload[0] == 0x03)) {
        return; /* per-key binary: unsupported on underglow-only boards */
    }
    uint8_t mode = akp_json_find((const char *)payload, len, "mode", tmp, sizeof(tmp));
    if (mode == 1 && strcmp(tmp, "off") == 0) {
        struct zmk_led_hsb hsb = {.h = 0, .s = 0, .b = 0};
        zmk_rgb_underglow_set_hsb(hsb);
        return;
    }
    if (mode == 1 && strcmp(tmp, "solid") == 0) {
        const char *color_key = strstr((const char *)payload, "\"color\"");
        if (color_key != NULL) {
            uint16_t off = (uint16_t)(color_key - (const char *)payload);
            uint8_t r = 0, g = 0, b = 0;
            if (akp_json_find_at((const char *)payload, len, off, "r", tmp, sizeof(tmp)) == 2)
                r = (uint8_t)atoi(tmp);
            if (akp_json_find_at((const char *)payload, len, off, "g", tmp, sizeof(tmp)) == 2)
                g = (uint8_t)atoi(tmp);
            if (akp_json_find_at((const char *)payload, len, off, "b", tmp, sizeof(tmp)) == 2)
                b = (uint8_t)atoi(tmp);
            ai_color[0] = r;
            ai_color[1] = g;
            ai_color[2] = b;
            struct zmk_led_hsb hsb = ai_rgb_to_hsb(r, g, b);
            zmk_rgb_underglow_set_hsb(hsb);
        }
    }
#else
    (void)payload;
    (void)len;
#endif
}

/* collect string values (OLED lines) in order */
static uint8_t ai_collect_strings(const char *json, uint16_t len, char out[][AI_OLED_LINE_LEN],
                                  uint8_t max) {
    uint8_t n = 0;
    uint16_t i = 0;
    while (i < len && n < max) {
        if (json[i] == '"') {
            uint16_t j = i + 1;
            while (j < len && json[j] != '"') j++;
            uint16_t k = j + 1;
            while (k < len && json[k] == ' ') k++;
            if (k < len && json[k] == ':') {
                i = k + 1;
                continue;
            }
            uint16_t v = i + 1, o = 0;
            while (v < len && json[v] != '"' && o < AI_OLED_LINE_LEN - 1) out[n][o++] = json[v++];
            out[n][o] = '\0';
            n++;
            i = v + 1;
        } else {
            i++;
        }
    }
    return n;
}

static void ai_handle_screen(const uint8_t *payload, uint16_t len) {
    char lines[AI_OLED_LINES][AI_OLED_LINE_LEN];
    memset(lines, 0, sizeof(lines));
    uint8_t n = ai_collect_strings((const char *)payload, len, lines, AI_OLED_LINES);
    for (uint8_t i = 0; i < n; i++) {
        ai_set_line(i, lines[i]);
    }
    ai_console_display_update();
}

static int ai_console_raw_hid_rx_cb(uint8_t *buf, uint8_t length) {
    uint8_t msg[AKP_MSG_MAX_SIZE];
    uint16_t msg_len = 0;
    if (!akp_decode_report(buf, length, msg, &msg_len)) return 0;
    if (msg_len < AKP_MSG_HEADER) return 0;
    uint8_t type = msg[2];
    uint16_t payload_len = (uint16_t)(msg[6] | (msg[7] << 8));
    if ((uint16_t)(AKP_MSG_HEADER + payload_len) + 2u > msg_len) return 0;
    const uint8_t *payload = &msg[AKP_MSG_HEADER];

    switch (type) {
    case AKP_MSG_CAPS:
        ai_host_connected = true;
        break;
    case AKP_MSG_HEARTBEAT: {
        ai_host_connected = true;
        ai_last_heartbeat_ms = k_uptime_get();
        char json[64];
        snprintf(json, sizeof(json), "{\"t\":%lld,\"state\":\"%s\"}",
                 (long long)(k_uptime_get() / 1000), ai_state_name(ai_state));
        ai_send_json(AKP_MSG_HEARTBEAT, json);
        break;
    }
    case AKP_MSG_STATE:
        ai_handle_state(payload, payload_len);
        break;
    case AKP_MSG_RGB:
        ai_handle_rgb(payload, payload_len);
        break;
    case AKP_MSG_SCREEN:
        ai_handle_screen(payload, payload_len);
        break;
    default:
        break;
    }
    return 0;
}

/* ---- display widget (LVGL, updated on the display work queue) ---- */

#if IS_ENABLED(CONFIG_AI_CONSOLE_OLED)

static lv_obj_t *ai_label[AI_OLED_LINES];

static void ai_display_refresh_work(struct k_work *work);
K_WORK_DEFINE(ai_display_refresh_work, ai_display_refresh_work);

void ai_console_display_update(void) {
    if (zmk_display_is_initialized()) {
        k_work_submit_to_queue(zmk_display_work_q(), &ai_display_refresh_work);
    }
}

static void ai_display_refresh_work(struct k_work *work) {
    for (int i = 0; i < AI_OLED_LINES; i++) {
        if (ai_label[i]) lv_label_set_text(ai_label[i], ai_lines[i]);
    }
}

static int ai_console_display_init(const struct device *dev) {
    lv_obj_t *screen = lv_scr_act();
    for (int i = 0; i < AI_OLED_LINES; i++) {
        ai_label[i] = lv_label_create(screen);
        lv_label_set_text(ai_label[i], ai_lines[i]);
        lv_obj_set_pos(ai_label[i], 0, i * 10);
        lv_obj_set_style_text_color(ai_label[i], lv_palette_main(LV_PALETTE_BLUE), 0);
    }
    ai_console_display_update();
    return 0;
}

SYS_INIT(ai_console_display_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY + 2);

#else

void ai_console_display_update(void) {}

#endif /* CONFIG_AI_CONSOLE_OLED */

/* ---- init + watchdog ---- */

static void ai_watchdog_work(struct k_work *work);
K_WORK_DELAYABLE_DEFINE(ai_watchdog_work, ai_watchdog_work);

static void ai_watchdog_work(struct k_work *work) {
    /* host watchdog: lights off + OLED update when host goes silent */
    if (ai_host_connected &&
        (k_uptime_get() - ai_last_heartbeat_ms) > CONFIG_AI_CONSOLE_HOST_TIMEOUT_MS) {
        ai_host_connected = false;
        ai_state = AI_STATE_DISCONNECTED;
        ai_set_line(1, "host disconnected");
        ai_apply_underglow();
        ai_console_display_update();
    }
    k_work_schedule(&ai_watchdog_work, K_MSEC(1000));
}

static void ai_hello_work(struct k_work *work);
K_WORK_DELAYABLE_DEFINE(ai_hello_work, ai_hello_work);

static void ai_hello_work(struct k_work *work) {
    if (ai_console_raw_hid_available()) {
        ai_send_hello();
        ai_last_heartbeat_ms = k_uptime_get();
        ai_host_connected = false; /* wait for CAPS/heartbeat */
    } else {
        k_work_schedule(&ai_hello_work, K_MSEC(2000));
    }
}

static int ai_console_module_init(void) {
    memset(ai_lines, 0, sizeof(ai_lines));
    ai_set_line(0, "AI Console");
    ai_set_line(1, "waiting for host...");
    ai_console_raw_hid_set_rx_cb(ai_console_raw_hid_rx_cb);
    k_work_schedule(&ai_watchdog_work, K_MSEC(1000));
    k_work_schedule(&ai_hello_work, K_MSEC(1500));
    return 0;
}

SYS_INIT(ai_console_module_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY + 1);
