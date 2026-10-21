// Acceptance (F-09a-2): one xiaozhi-style voice turn against the virtual server.
// OTA POST -> ws url / token -> hello -> listen, 8 uplink frames, stop -> stt / tts / 60 ms Opus frames.
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_http_client.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "nvs_flash.h"
#include "cJSON.h"

#define BIT_IP BIT0
#define BIT_WS BIT1
#define BIT_HELLO BIT2
#define BIT_STOP BIT3

static EventGroupHandle_t eg;
static int s_frames;
static int64_t s_first_us, s_last_us;
static int s_bad_toc;

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        printf("断开，重连\n");
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        printf("拿到 IP " IPSTR "\n", IP2STR(&e->ip_info.ip));
        xEventGroupSetBits(eg, BIT_IP);
    }
}

// Text message from the server: print the parts a xiaozhi firmware reacts to
static void on_text(const char *s, int n)
{
    cJSON *j = cJSON_ParseWithLength(s, n);
    if (!j) {
        printf("收到无法解析的文本 %d 字节\n", n);
        return;
    }
    const char *type = cJSON_GetStringValue(cJSON_GetObjectItem(j, "type"));
    const char *state = cJSON_GetStringValue(cJSON_GetObjectItem(j, "state"));
    const char *text = cJSON_GetStringValue(cJSON_GetObjectItem(j, "text"));
    if (type && !strcmp(type, "hello")) {
        cJSON *ap = cJSON_GetObjectItem(j, "audio_params");
        printf("服务端 hello：session_id=%s 下行 %d Hz %d ms\n",
               cJSON_GetStringValue(cJSON_GetObjectItem(j, "session_id")),
               (int)cJSON_GetNumberValue(cJSON_GetObjectItem(ap, "sample_rate")),
               (int)cJSON_GetNumberValue(cJSON_GetObjectItem(ap, "frame_duration")));
        xEventGroupSetBits(eg, BIT_HELLO);
    } else if (type && !strcmp(type, "stt")) {
        printf("识别结果：%s\n", text ? text : "");
    } else if (type && !strcmp(type, "llm")) {
        printf("表情：%s\n", cJSON_GetStringValue(cJSON_GetObjectItem(j, "emotion")));
    } else if (type && !strcmp(type, "tts") && state) {
        if (!strcmp(state, "sentence_start")) {
            printf("播报句子：%s\n", text ? text : "");
        } else {
            printf("tts %s\n", state);
            if (!strcmp(state, "stop")) xEventGroupSetBits(eg, BIT_STOP);
        }
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
    } else if (id == WEBSOCKET_EVENT_DISCONNECTED) {
        printf("WebSocket 断开\n");
    } else if (id == WEBSOCKET_EVENT_DATA) {
        if (d->op_code == 0x1) {
            on_text(d->data_ptr, d->data_len);
        } else if (d->op_code == 0x2 && d->payload_offset == 0) {
            int64_t now = esp_timer_get_time();
            if (s_frames == 0) s_first_us = now;
            s_last_us = now;
            s_frames++;
            // SILK wideband 60 ms, mono, one frame: config 11
            if (d->data_len < 1 || ((uint8_t)d->data_ptr[0] >> 3) != 11) s_bad_toc++;
        }
    }
}

// OTA check: POST device info, read websocket.url / token from the reply
static int ota(char *url, int url_cap, char *token, int tok_cap)
{
    static char buf[1024];
    const char *body = "{\"application\":{\"name\":\"c3-xz-ws\",\"version\":\"0.1.0\"}}";
    esp_http_client_config_t c = {
        .url = "http://tryboard.local/xiaozhi/ota/",
        .method = HTTP_METHOD_POST,
        .timeout_ms = 5000,
    };
    esp_http_client_handle_t h = esp_http_client_init(&c);
    esp_http_client_set_header(h, "Device-Id", "02:54:42:00:00:64");
    esp_http_client_set_header(h, "Client-Id", "7f1d3c2a-0000-4000-8000-000000000001");
    esp_http_client_set_header(h, "Content-Type", "application/json");
    int ok = -1;
    if (esp_http_client_open(h, strlen(body)) == ESP_OK) {
        esp_http_client_write(h, body, strlen(body));
        esp_http_client_fetch_headers(h);
        int n = esp_http_client_read_response(h, buf, sizeof(buf) - 1);
        int st = esp_http_client_get_status_code(h);
        printf("OTA POST → %d，%d 字节\n", st, n);
        if (n > 0) {
            buf[n] = 0;
            cJSON *j = cJSON_Parse(buf);
            cJSON *ws = cJSON_GetObjectItem(j, "websocket");
            const char *u = cJSON_GetStringValue(cJSON_GetObjectItem(ws, "url"));
            const char *t = cJSON_GetStringValue(cJSON_GetObjectItem(ws, "token"));
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

void app_main(void)
{
    eg = xEventGroupCreate();
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

    static char url[128], token[96], headers[256];
    if (ota(url, sizeof(url), token, sizeof(token)) != 0) {
        printf("OTA 回复里没有 websocket 地址\n");
        return;
    }
    printf("WebSocket 地址 %s\n", url);
    snprintf(headers, sizeof(headers),
             "Authorization: Bearer %s\r\nProtocol-Version: 1\r\nDevice-Id: 02:54:42:00:00:64\r\n"
             "Client-Id: 7f1d3c2a-0000-4000-8000-000000000001\r\n",
             token);
    esp_websocket_client_config_t wcfg = {
        .uri = url,
        .headers = headers,
        .network_timeout_ms = 5000,
        .disable_auto_reconnect = true,
    };
    esp_websocket_client_handle_t ws = esp_websocket_client_init(&wcfg);
    esp_websocket_register_events(ws, WEBSOCKET_EVENT_ANY, on_ws, NULL);
    esp_websocket_client_start(ws);
    if (!(xEventGroupWaitBits(eg, BIT_WS, false, true, pdMS_TO_TICKS(5000)) & BIT_WS)) {
        printf("WebSocket 连接超时\n");
        return;
    }
    const char *hello = "{\"type\":\"hello\",\"version\":1,\"features\":{\"mcp\":true},\"transport\":\"websocket\","
                        "\"audio_params\":{\"format\":\"opus\",\"sample_rate\":16000,\"channels\":1,\"frame_duration\":60}}";
    esp_websocket_client_send_text(ws, hello, strlen(hello), portMAX_DELAY);
    if (!(xEventGroupWaitBits(eg, BIT_HELLO, false, true, pdMS_TO_TICKS(10000)) & BIT_HELLO)) {
        printf("服务端 10 秒没回 hello\n");
        return;
    }
    const char *start = "{\"type\":\"listen\",\"state\":\"start\",\"mode\":\"manual\"}";
    esp_websocket_client_send_text(ws, start, strlen(start), portMAX_DELAY);
    // Uplink: 8 placeholder Opus packets (TOC only plus filler), one per 60 ms
    uint8_t frame[24] = {11 << 3};
    for (int i = 0; i < 8; i++) {
        frame[1] = i;
        esp_websocket_client_send_bin(ws, (const char *)frame, sizeof(frame), portMAX_DELAY);
        vTaskDelay(pdMS_TO_TICKS(60));
    }
    const char *stop = "{\"type\":\"listen\",\"state\":\"stop\"}";
    esp_websocket_client_send_text(ws, stop, strlen(stop), portMAX_DELAY);
    printf("上行 8 帧，等回答\n");
    if (!(xEventGroupWaitBits(eg, BIT_STOP, false, true, pdMS_TO_TICKS(10000)) & BIT_STOP)) {
        printf("10 秒内没等到 tts stop（下行 %d 帧）\n", s_frames);
        return;
    }
    int avg_ms = s_frames > 1 ? (int)((s_last_us - s_first_us) / (s_frames - 1) / 1000) : 0;
    printf("下行 %d 帧，TOC 不对 %d 帧，平均间隔 %d ms\n", s_frames, s_bad_toc, avg_ms);
    esp_websocket_client_close(ws, pdMS_TO_TICKS(2000));
    esp_websocket_client_destroy(ws);
    if (s_frames > 0 && s_bad_toc == 0 && avg_ms >= 55 && avg_ms <= 65) printf("TRYBOARD_OK c3-xz-ws\n");
}
