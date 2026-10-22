// G-05 work "cloud": AHT20 (I2C SDA=6 SCL=7) readings published as JSON over MQTT every N seconds.
// Subscribes tryboard/cloud/cmd: "interval=<1..60>" changes the period, each command is acknowledged on tryboard/cloud/ack.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "driver/i2c_master.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "mqtt_client.h"

#define PIN_SDA 6
#define PIN_SCL 7
#define BROKER "mqtt://192.168.4.1:1883"
#define CLIENT_ID "tryboard-cloud"
#define T_DATA "tryboard/cloud/data"
#define T_CMD "tryboard/cloud/cmd"
#define T_ACK "tryboard/cloud/ack"

#define BIT_IP 1
#define BIT_MQTT 2

static EventGroupHandle_t eg;
static i2c_master_dev_handle_t aht;
static esp_mqtt_client_handle_t mq;
static TaskHandle_t main_task;
static volatile int s_interval = 5;

// CRC-8, polynomial 0x31, init 0xFF (AHT20 datasheet)
static uint8_t crc8(const uint8_t *d, int n)
{
    uint8_t c = 0xff;
    for (int i = 0; i < n; i++) {
        c ^= d[i];
        for (int b = 0; b < 8; b++) c = c & 0x80 ? (c << 1) ^ 0x31 : c << 1;
    }
    return c;
}

static void aht_init(void)
{
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
    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = 0x38, .scl_speed_hz = 100000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &aht));
    uint8_t st = 0;
    if (i2c_master_receive(aht, &st, 1, 100) != ESP_OK) {
        printf("AHT20 无应答（检查 SDA=GPIO%d SCL=GPIO%d 和 3V3 供电）\n", PIN_SDA, PIN_SCL);
        return;
    }
    if ((st & 0x18) != 0x18) {
        uint8_t init[3] = {0xbe, 0x08, 0x00};
        i2c_master_transmit(aht, init, 3, 100);
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    printf("AHT20 就绪 状态 0x%02X\n", st);
}

// Temperature and humidity in tenths, rounded; returns 0 on a bus or CRC error
static int aht_read(int *t10, int *h10)
{
    uint8_t trig[3] = {0xac, 0x33, 0x00}, d[7];
    if (i2c_master_transmit(aht, trig, 3, 100) != ESP_OK) return 0;
    // vTaskDelay can wake up to one tick early, so poll the busy bit instead of trusting 80 ms
    vTaskDelay(pdMS_TO_TICKS(80));
    for (int i = 0;; i++) {
        if (i2c_master_receive(aht, d, 7, 100) != ESP_OK) return 0;
        if (!(d[0] & 0x80)) break;
        if (i == 5) return 0;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    if (crc8(d, 6) != d[6]) return 0;
    uint32_t hr = ((uint32_t)d[1] << 12) | (d[2] << 4) | (d[3] >> 4);
    uint32_t tr = ((uint32_t)(d[3] & 15) << 16) | (d[4] << 8) | d[5];
    int64_t h100 = ((int64_t)hr * 10000) >> 20;
    int64_t t100 = (((int64_t)tr * 20000) >> 20) - 5000;
    *h10 = (int)((h100 + 5) / 10);
    *t10 = (int)(t100 >= 0 ? (t100 + 5) / 10 : (t100 - 5) / 10);
    return 1;
}

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *d = data;
        printf("Wi-Fi 断开 reason=%d，重连\n", d->reason);
        xEventGroupClearBits(eg, BIT_IP);
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        printf("已连上 Wi-Fi，IP " IPSTR " 网关 " IPSTR "\n", IP2STR(&e->ip_info.ip), IP2STR(&e->ip_info.gw));
        xEventGroupSetBits(eg, BIT_IP);
    }
}

static void ack(const char *json)
{
    esp_mqtt_client_publish(mq, T_ACK, json, 0, 0, 0);
    printf("回执 → " T_ACK " %s\n", json);
}

// Payload is "interval=<seconds>"; anything else or out of 1..60 is refused and acknowledged as such
static void on_cmd(const char *p, int n)
{
    char buf[48], out[112];
    if (n >= (int)sizeof(buf)) n = sizeof(buf) - 1;
    memcpy(buf, p, n);
    buf[n] = 0;
    printf("收到命令 " T_CMD " \"%s\"\n", buf);
    char *end = NULL;
    long v = -1;
    if (strncmp(buf, "interval=", 9) == 0 && buf[9]) v = strtol(buf + 9, &end, 10);
    if (v < 1 || v > 60 || !end || *end) {
        printf("拒绝命令 \"%s\"：格式 interval=<秒>，间隔须在 1–60 秒，保持 %d 秒\n", buf, s_interval);
        snprintf(out, sizeof(out), "{\"ok\":false,\"cmd\":\"%s\",\"interval\":%d}", buf, s_interval);
        ack(out);
        return;
    }
    s_interval = (int)v;
    printf("间隔改为 %d 秒\n", s_interval);
    snprintf(out, sizeof(out), "{\"ok\":true,\"interval\":%d}", s_interval);
    ack(out);
    xTaskNotifyGive(main_task);
}

static void on_mqtt(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    esp_mqtt_event_handle_t e = data;
    switch ((esp_mqtt_event_id_t)id) {
    case MQTT_EVENT_CONNECTED:
        printf("MQTT 已连上 broker（CONNACK）client=" CLIENT_ID "\n");
        esp_mqtt_client_subscribe(mq, T_CMD, 0);
        xEventGroupSetBits(eg, BIT_MQTT);
        break;
    case MQTT_EVENT_SUBSCRIBED:
        printf("已订阅 " T_CMD "\n");
        break;
    case MQTT_EVENT_DISCONNECTED:
        printf("MQTT 断开，自动重连\n");
        xEventGroupClearBits(eg, BIT_MQTT);
        break;
    case MQTT_EVENT_DATA:
        // Topic and data are not NUL-terminated
        if (e->topic_len == (int)strlen(T_CMD) && memcmp(e->topic, T_CMD, e->topic_len) == 0) on_cmd(e->data, e->data_len);
        break;
    case MQTT_EVENT_ERROR:
        printf("MQTT 出错\n");
        break;
    default:
        break;
    }
}

static void wifi_start(void)
{
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
}

void app_main(void)
{
    eg = xEventGroupCreate();
    main_task = xTaskGetCurrentTaskHandle();
    printf("温湿度上云：AHT20 SDA=GPIO%d SCL=GPIO%d，broker " BROKER "\n", PIN_SDA, PIN_SCL);
    aht_init();
    wifi_start();
    xEventGroupWaitBits(eg, BIT_IP, false, true, portMAX_DELAY);

    esp_mqtt_client_config_t mc = {.broker.address.uri = BROKER, .credentials.client_id = CLIENT_ID};
    mq = esp_mqtt_client_init(&mc);
    esp_mqtt_client_register_event(mq, ESP_EVENT_ANY_ID, on_mqtt, NULL);
    esp_mqtt_client_start(mq);
    xEventGroupWaitBits(eg, BIT_MQTT, false, true, portMAX_DELAY);

    // fresh: no gap to report (first publish, or the one sent right after an interval change)
    int seq = 0, fresh = 1;
    int64_t last = 0;
    for (;;) {
        if (!fresh) {
            int64_t due = last + (int64_t)s_interval * 1000000;
            int64_t now = esp_timer_get_time();
            if (now < due) {
                TickType_t wait = pdMS_TO_TICKS((due - now + 999) / 1000);
                if (ulTaskNotifyTake(pdTRUE, wait ? wait : 1)) {
                    fresh = 1;
                } else if (esp_timer_get_time() < due) {
                    continue;
                }
            }
        }
        if (!(xEventGroupGetBits(eg) & BIT_MQTT)) {
            xEventGroupWaitBits(eg, BIT_MQTT, false, true, portMAX_DELAY);
            continue;
        }
        int64_t now = esp_timer_get_time();
        int t10, h10;
        if (!aht_read(&t10, &h10)) {
            printf("AHT20 读取失败，跳过本次\n");
            if (fresh) vTaskDelay(pdMS_TO_TICKS(1000));
            last = now;
            continue;
        }
        seq++;
        char js[64];
        int ta = t10 < 0 ? -t10 : t10;
        snprintf(js, sizeof(js), "{\"t\":%s%d.%d,\"h\":%d.%d,\"seq\":%d}", t10 < 0 ? "-" : "", ta / 10, ta % 10, h10 / 10, h10 % 10, seq);
        esp_mqtt_client_publish(mq, T_DATA, js, 0, 0, 0);
        if (seq == 1) {
            printf("发布 #%d → " T_DATA " %s\n", seq, js);
        } else if (fresh) {
            printf("发布 #%d → " T_DATA " %s 间隔刚改为 %d 秒，立即发一条\n", seq, js, s_interval);
        } else {
            int64_t gap = (now - last + 5000) / 10000;
            printf("发布 #%d → " T_DATA " %s 距上次 %d.%02d 秒（间隔 %d 秒）\n", seq, js, (int)(gap / 100), (int)(gap % 100), s_interval);
        }
        fresh = 0;
        last = now;
        if (seq == 3) printf("TRYBOARD_OK c3-cloud\n");
    }
}
