// Push-to-talk voice assistant on the xiaozhi WebSocket protocol, written from the RS-2 notes (no xiaozhi-esp32 code).
// Pins follow bread-compact-wifi; flow and decisions are in docs/DECISIONS.md (F-09b-1). BOOT while speaking = abort.
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_http_client.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "nvs_flash.h"
#include "cJSON.h"
#include "opus.h"
#include "ssd1306_mini.h"

#define PIN_MIC_WS 4
#define PIN_MIC_SCK 5
#define PIN_MIC_DIN 6
#define PIN_SPK_DOUT 7
#define PIN_SPK_BCLK 15
#define PIN_SPK_LRCK 16
#define PIN_SDA 41
#define PIN_SCL 42
#define PIN_BOOT 0
#define PIN_LED 48
#define RATE 16000
#define FRAME 960 // 60 ms
#define HELLO_TIMEOUT_MS 10000

#define BIT_IP BIT0
#define BIT_WS BIT1
#define BIT_HELLO BIT2

enum { UI_STT, UI_TTS_START, UI_SENTENCE, UI_TTS_STOP, UI_WS_DOWN };
typedef struct {
    int kind;
    char text[96];
} ui_msg_t;
typedef struct {
    int len;
    uint8_t data[];
} pkt_t;

static EventGroupHandle_t eg;
static QueueHandle_t ui_q, down_q;
static esp_websocket_client_handle_t ws;
static i2s_chan_handle_t spk, mic;
// Shared with the audio task; single writer each, so plain volatile flags are enough
static volatile int s_listening, s_speaking, s_drop, s_tts_stopped, s_done;
static volatile int s_up_frames, s_up_bytes, s_down_frames, s_played, s_dropped;
static volatile int64_t s_enc_us;
static double s_sum2;
static long s_samples;
static char s_status[22] = "Wi-Fi...", s_stt[22], s_sub[96];

static void oled_draw(void)
{
    memset(fb, 0, sizeof fb);
    text(0, 0, s_status, 1);
    if (s_stt[0]) {
        char l[24];
        snprintf(l, sizeof l, "> %s", s_stt);
        text(0, 14, l, 1);
    }
    // Subtitle: 21 characters per line, up to 4 lines from y = 28
    int n = strlen(s_sub);
    for (int i = 0, y = 28; i < n && y <= 54; i += 21, y += 9) {
        char l[22];
        snprintf(l, sizeof l, "%.21s", s_sub + i);
        text(0, y, l, 1);
    }
    flush();
}

static void status(const char *s)
{
    snprintf(s_status, sizeof s_status, "%s", s);
    oled_draw();
}

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        printf("Wi-Fi 断开，重连\n");
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        printf("拿到 IP " IPSTR "\n", IP2STR(&e->ip_info.ip));
        xEventGroupSetBits(eg, BIT_IP);
    }
}

static void post(int kind, const char *t)
{
    ui_msg_t m = {.kind = kind};
    snprintf(m.text, sizeof m.text, "%s", t ? t : "");
    xQueueSend(ui_q, &m, pdMS_TO_TICKS(100));
}

// Runs in the websocket task: parse and hand over, never send from here
static void on_text(const char *s, int n)
{
    cJSON *j = cJSON_ParseWithLength(s, n);
    if (!j) {
        printf("收到无法解析的文本 %d 字节\n", n);
        return;
    }
    const char *type = cJSON_GetStringValue(cJSON_GetObjectItem(j, "type"));
    const char *state = cJSON_GetStringValue(cJSON_GetObjectItem(j, "state"));
    const char *txt = cJSON_GetStringValue(cJSON_GetObjectItem(j, "text"));
    if (type && !strcmp(type, "hello")) {
        cJSON *ap = cJSON_GetObjectItem(j, "audio_params");
        printf("服务端 hello：session_id=%s 下行 %d Hz %d ms\n",
               cJSON_GetStringValue(cJSON_GetObjectItem(j, "session_id")),
               (int)cJSON_GetNumberValue(cJSON_GetObjectItem(ap, "sample_rate")),
               (int)cJSON_GetNumberValue(cJSON_GetObjectItem(ap, "frame_duration")));
        xEventGroupSetBits(eg, BIT_HELLO);
    } else if (type && !strcmp(type, "stt")) {
        post(UI_STT, txt);
    } else if (type && !strcmp(type, "llm")) {
        printf("表情：%s\n", cJSON_GetStringValue(cJSON_GetObjectItem(j, "emotion")));
    } else if (type && !strcmp(type, "tts") && state) {
        if (!strcmp(state, "start")) post(UI_TTS_START, NULL);
        else if (!strcmp(state, "sentence_start")) post(UI_SENTENCE, txt);
        else if (!strcmp(state, "stop")) post(UI_TTS_STOP, NULL);
    } else {
        printf("其它消息：%.*s\n", n, s);
    }
    cJSON_Delete(j);
}

static void on_ws(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    esp_websocket_event_data_t *d = data;
    if (id == WEBSOCKET_EVENT_CONNECTED) {
        printf("WebSocket 已连接\n");
        xEventGroupSetBits(eg, BIT_WS);
    } else if (id == WEBSOCKET_EVENT_DISCONNECTED || id == WEBSOCKET_EVENT_CLOSED) {
        post(UI_WS_DOWN, NULL);
    } else if (id == WEBSOCKET_EVENT_DATA) {
        if (d->op_code == 0x1) {
            on_text(d->data_ptr, d->data_len);
        } else if (d->op_code == 0x2 && d->payload_offset == 0 && d->data_len == d->payload_len) {
            pkt_t *p = malloc(sizeof(pkt_t) + d->data_len);
            if (!p) return;
            p->len = d->data_len;
            memcpy(p->data, d->data_ptr, d->data_len);
            s_down_frames++;
            if (xQueueSend(down_q, &p, 0) != pdTRUE) {
                free(p);
                s_dropped++;
            }
        }
    }
}

static int ota(char *url, int url_cap, char *token, int tok_cap)
{
    static char buf[1024];
    const char *body = "{\"application\":{\"name\":\"s3-xiaozhi-lite\",\"version\":\"0.1.0\"}}";
    esp_http_client_config_t c = {
        .url = "http://tryboard.local/xiaozhi/ota/",
        .method = HTTP_METHOD_POST,
        .timeout_ms = 5000,
    };
    esp_http_client_handle_t h = esp_http_client_init(&c);
    esp_http_client_set_header(h, "Device-Id", "02:54:42:00:00:53");
    esp_http_client_set_header(h, "Client-Id", "7f1d3c2a-0000-4000-8000-000000000053");
    esp_http_client_set_header(h, "Content-Type", "application/json");
    int ok = -1;
    if (esp_http_client_open(h, strlen(body)) == ESP_OK) {
        esp_http_client_write(h, body, strlen(body));
        esp_http_client_fetch_headers(h);
        int n = esp_http_client_read_response(h, buf, sizeof(buf) - 1);
        printf("OTA POST → %d，%d 字节\n", esp_http_client_get_status_code(h), n);
        if (n > 0) {
            buf[n] = 0;
            cJSON *j = cJSON_Parse(buf);
            cJSON *w = cJSON_GetObjectItem(j, "websocket");
            const char *u = cJSON_GetStringValue(cJSON_GetObjectItem(w, "url"));
            const char *t = cJSON_GetStringValue(cJSON_GetObjectItem(w, "token"));
            if (u && t) {
                snprintf(url, url_cap, "%s", u);
                snprintf(token, tok_cap, "%s", t);
                ok = 0;
            }
            cJSON_Delete(j);
        }
    } else {
        printf("OTA 打开失败\n");
    }
    esp_http_client_cleanup(h);
    return ok;
}

static void i2s_setup(void)
{
    i2s_chan_config_t c0 = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    // Send zeros once the queue runs dry instead of repeating the last DMA buffer
    c0.auto_clear = true;
    ESP_ERROR_CHECK(i2s_new_channel(&c0, &spk, NULL));
    i2s_std_config_t s0 = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = PIN_SPK_BCLK, .ws = PIN_SPK_LRCK, .dout = PIN_SPK_DOUT,
                     .din = I2S_GPIO_UNUSED},
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(spk, &s0));

    i2s_chan_config_t c1 = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    ESP_ERROR_CHECK(i2s_new_channel(&c1, NULL, &mic));
    i2s_std_config_t s1 = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = PIN_MIC_SCK, .ws = PIN_MIC_WS, .dout = I2S_GPIO_UNUSED,
                     .din = PIN_MIC_DIN},
    };
    // INMP441 with L/R grounded talks on the left slot only
    s1.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(mic, &s1));
    printf("麦克风 INMP441 WS=%d SCK=%d DIN=%d，喇叭 MAX98357A DOUT=%d BCLK=%d LRCK=%d，%d Hz\n", PIN_MIC_WS, PIN_MIC_SCK,
           PIN_MIC_DIN, PIN_SPK_DOUT, PIN_SPK_BCLK, PIN_SPK_LRCK, RATE);
}

// Encoder and decoder share this task: talking and listening never overlap, so one Opus pseudostack is enough
static void audio_task(void *arg)
{
    int err;
    OpusEncoder *enc = opus_encoder_create(RATE, 1, OPUS_APPLICATION_VOIP, &err);
    if (err != OPUS_OK) printf("Opus 编码器创建失败 %d\n", err);
    opus_encoder_ctl(enc, OPUS_SET_COMPLEXITY(0));
    opus_encoder_ctl(enc, OPUS_SET_BITRATE(16000));
    opus_encoder_ctl(enc, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
    OpusDecoder *dec = opus_decoder_create(RATE, 1, &err);
    if (err != OPUS_OK) printf("Opus 解码器创建失败 %d\n", err);
    static int32_t raw[FRAME];
    static int16_t pcm[FRAME];
    static uint8_t out[400];
    int mic_on = 0, spk_on = 0, stack_shown = 0;
    for (;;) {
        if (s_listening) {
            if (!mic_on) {
                i2s_channel_enable(mic);
                mic_on = 1;
            }
            size_t got = 0;
            i2s_channel_read(mic, raw, sizeof raw, &got, portMAX_DELAY);
            for (int i = 0; i < FRAME; i++) pcm[i] = raw[i] >> 16;
            int64_t t0 = esp_timer_get_time();
            int n = opus_encode(enc, pcm, FRAME, out, sizeof out);
            s_enc_us += esp_timer_get_time() - t0;
            if (n > 0 && esp_websocket_client_send_bin(ws, (const char *)out, n, pdMS_TO_TICKS(1000)) == n) {
                s_up_frames++;
                s_up_bytes += n;
            }
            if (!stack_shown) {
                stack_shown = 1;
                printf("首帧编码 %d 字节，TOC 配置 %d，音频任务栈余量 %u 字节\n", n, out[0] >> 3,
                       (unsigned)uxTaskGetStackHighWaterMark(NULL));
            }
            continue;
        }
        if (mic_on) {
            i2s_channel_disable(mic);
            mic_on = 0;
        }
        pkt_t *p;
        if (xQueueReceive(down_q, &p, pdMS_TO_TICKS(20)) == pdTRUE) {
            if (!s_drop) {
                int n = opus_decode(dec, p->data, p->len, pcm, FRAME, 0);
                if (n > 0) {
                    if (!spk_on) {
                        i2s_channel_enable(spk);
                        spk_on = 1;
                    }
                    for (int i = 0; i < n; i++) s_sum2 += (double)pcm[i] * pcm[i];
                    s_samples += n;
                    size_t w;
                    i2s_channel_write(spk, pcm, n * sizeof(int16_t), &w, portMAX_DELAY);
                    s_played++;
                } else {
                    printf("Opus 解码失败 %d\n", n);
                }
            }
            free(p);
        } else if (s_tts_stopped && !s_done) {
            // Queue empty after tts stop: let the DMA ring (6 x 240 frames = 90 ms) drain, then go quiet
            if (spk_on) {
                vTaskDelay(pdMS_TO_TICKS(100));
                i2s_channel_disable(spk);
                spk_on = 0;
            }
            s_done = 1;
        }
    }
}

static void ws_send_json(const char *s)
{
    esp_websocket_client_send_text(ws, s, strlen(s), portMAX_DELAY);
}

static void connect_ws(const char *url, const char *token)
{
    static char headers[256];
    snprintf(headers, sizeof headers,
             "Authorization: Bearer %s\r\nProtocol-Version: 1\r\nDevice-Id: 02:54:42:00:00:53\r\n"
             "Client-Id: 7f1d3c2a-0000-4000-8000-000000000053\r\n",
             token);
    const char *hello = "{\"type\":\"hello\",\"version\":1,\"features\":{\"mcp\":true},\"transport\":\"websocket\","
                        "\"audio_params\":{\"format\":\"opus\",\"sample_rate\":16000,\"channels\":1,\"frame_duration\":60}}";
    for (int attempt = 1;; attempt++) {
        xEventGroupClearBits(eg, BIT_WS | BIT_HELLO);
        xEventGroupClearBits(eg, BIT_WS | BIT_HELLO);
        esp_websocket_client_config_t wc = {
            .uri = url,
            .headers = headers,
            .network_timeout_ms = 5000,
            .disable_auto_reconnect = true,
            .task_stack = 6144,
        };
        ws = esp_websocket_client_init(&wc);
        esp_websocket_register_events(ws, WEBSOCKET_EVENT_ANY, on_ws, NULL);
        esp_websocket_client_start(ws);
        if (xEventGroupWaitBits(eg, BIT_WS, false, true, pdMS_TO_TICKS(5000)) & BIT_WS) {
            ws_send_json(hello);
            status("Hello...");
            if (xEventGroupWaitBits(eg, BIT_HELLO, false, true, pdMS_TO_TICKS(HELLO_TIMEOUT_MS)) & BIT_HELLO) {
                if (attempt > 1) printf("第 %d 次连接成功\n", attempt);
                return;
            }
            printf("服务端 10 秒没回 hello（第 %d 次），2 秒后重连\n", attempt);
            status("Hello timeout");
        } else {
            printf("WebSocket 连接超时（第 %d 次）\n", attempt);
        }
        // Detach first so the old client's close event doesn't show up as a drop on the new link
        esp_websocket_unregister_events(ws, WEBSOCKET_EVENT_ANY, on_ws);
        esp_websocket_client_close(ws, pdMS_TO_TICKS(2000));
        esp_websocket_client_destroy(ws);
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}

void app_main(void)
{
    eg = xEventGroupCreate();
    ui_q = xQueueCreate(16, sizeof(ui_msg_t));
    down_q = xQueueCreate(64, sizeof(pkt_t *));
    gpio_config_t io = {.pin_bit_mask = 1ULL << PIN_BOOT, .mode = GPIO_MODE_INPUT, .pull_up_en = 1};
    gpio_config(&io);
    gpio_reset_pin(PIN_LED);
    gpio_set_direction(PIN_LED, GPIO_MODE_OUTPUT);
    gpio_set_level(PIN_LED, 0);

    i2c_master_bus_config_t bc = {
        .i2c_port = 0,
        .sda_io_num = PIN_SDA,
        .scl_io_num = PIN_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t bus;
    ESP_ERROR_CHECK(i2c_new_master_bus(&bc, &bus));
    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = 0x3c, .scl_speed_hz = 400000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &oled));
    int has_oled = ssd1306_init() == ESP_OK;
    printf("语音助手（兼容 xiaozhi 协议）启动，OLED %s\n", has_oled ? "在线" : "未接");
    if (has_oled) oled_draw();

    i2s_setup();
    xTaskCreatePinnedToCore(audio_task, "audio", 24 * 1024, NULL, 6, NULL, 1);

    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi, NULL);
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    wifi_config_t wc = {0};
    strcpy((char *)wc.sta.ssid, "TryBoard-WiFi");
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());
    xEventGroupWaitBits(eg, BIT_IP, false, true, portMAX_DELAY);

    static char url[128], token[96];
    status("OTA...");
    if (ota(url, sizeof url, token, sizeof token) != 0) {
        printf("OTA 回复里没有 websocket 地址\n");
        status("OTA failed");
        return;
    }
    printf("WebSocket 地址 %s\n", url);
    connect_ws(url, token);
    status("Hold BOOT to talk");
    printf("就绪：按住 BOOT 说话\n");

    int was_down = 0, turns = 0, aborted = 0;
    for (;;) {
        int down = gpio_get_level(PIN_BOOT) == 0;
        if (down && !was_down) {
            if (s_speaking) {
                ws_send_json("{\"type\":\"abort\",\"reason\":\"user_interrupted\"}");
                s_drop = 1;
                aborted = 1;
                printf("按键打断，发送 abort（已播 %d 帧）\n", s_played);
            } else {
                ws_send_json("{\"type\":\"listen\",\"state\":\"start\",\"mode\":\"manual\"}");
                s_up_frames = s_up_bytes = 0;
                s_enc_us = 0;
                s_listening = 1;
                gpio_set_level(PIN_LED, 1);
                printf("按下 BOOT：listen start\n");
                s_stt[0] = s_sub[0] = 0;
                status("Listening...");
            }
        } else if (!down && was_down && s_listening) {
            s_listening = 0;
            gpio_set_level(PIN_LED, 0);
            // Let the audio task finish the frame in flight before the stop goes out
            vTaskDelay(pdMS_TO_TICKS(80));
            // Reset playback counters before the answer can arrive (frames may beat the tts start through ui_q)
            s_played = s_down_frames = s_dropped = 0;
            s_sum2 = 0;
            s_samples = 0;
            s_tts_stopped = s_done = s_drop = 0;
            ws_send_json("{\"type\":\"listen\",\"state\":\"stop\"}");
            int n = s_up_frames;
            printf("松开 BOOT：listen stop，上行 %d 帧 %d 字节，编码平均 %d us/帧\n", n, s_up_bytes,
                   n ? (int)(s_enc_us / n) : 0);
            status("Thinking...");
        }
        was_down = down;

        ui_msg_t m;
        while (xQueueReceive(ui_q, &m, 0) == pdTRUE) {
            if (m.kind == UI_STT) {
                printf("识别结果：%s\n", m.text);
                snprintf(s_stt, sizeof s_stt, "%.21s", m.text);
                oled_draw();
            } else if (m.kind == UI_TTS_START) {
                printf("tts start\n");
                s_speaking = 1;
                status("Speaking");
            } else if (m.kind == UI_SENTENCE) {
                printf("播报句子：%s\n", m.text);
                snprintf(s_sub, sizeof s_sub, "%s", m.text);
                oled_draw();
                printf("字幕已显示：%s\n", s_sub);
            } else if (m.kind == UI_TTS_STOP) {
                printf("tts stop\n");
                s_tts_stopped = 1;
            } else if (m.kind == UI_WS_DOWN) {
                printf("WebSocket 断开\n");
            }
        }
        if (s_speaking && s_done) {
            s_speaking = 0;
            double rms = s_samples ? sqrt(s_sum2 / s_samples) / 32768.0 : 0;
            printf("播放结束：收到 %d 帧，播放 %d 帧（%.2f 秒），丢弃 %d 帧，PCM RMS %.4f\n", s_down_frames, s_played,
                   s_samples / (double)RATE, s_dropped, rms);
            turns++;
            if (aborted) {
                printf("已打断，回到待机\n");
                printf("TRYBOARD_OK s3-xiaozhi-lite abort\n");
                aborted = 0;
            } else if (s_played > 0) {
                printf("TRYBOARD_OK s3-xiaozhi-lite turn %d\n", turns);
            }
            s_drop = 0;
            status("Hold BOOT to talk");
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
