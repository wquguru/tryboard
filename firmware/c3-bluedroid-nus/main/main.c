// Acceptance (E-05): Bluedroid peripheral "Claude-BD" speaking the Claude Desktop Buddy protocol over Nordic UART Service.
// Same wire behaviour as c3-ble-nus (NimBLE) but through the Bluedroid host that Arduino-ESP32's BLE library uses.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "cJSON.h"
#include "esp_bt.h"
#include "esp_bt_main.h"
#include "esp_gap_ble_api.h"
#include "esp_gatts_api.h"
#include "esp_gatt_common_api.h"

#define MSG_MAX 4096
#define DEVICE_NAME "Claude-BD"
#if CONFIG_IDF_TARGET_ESP32S3
#define CHIP_NAME "ESP32-S3"
#define FW_ID "s3-bluedroid-nus"
#else
#define CHIP_NAME "ESP32-C3"
#define FW_ID "c3-bluedroid-nus"
#endif

// 6e40000x-b5a3-f393-e0a9-e50e24dcca9e, little-endian
#define NUS_UUID(x) {0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0, 0x93, 0xf3, 0xa3, 0xb5, x, 0x00, 0x40, 0x6e}
static const uint8_t nus_svc[16] = NUS_UUID(0x01);
static const uint8_t nus_rx[16] = NUS_UUID(0x02);
static const uint8_t nus_tx[16] = NUS_UUID(0x03);

static const uint16_t primary_uuid = ESP_GATT_UUID_PRI_SERVICE;
static const uint16_t char_decl_uuid = ESP_GATT_UUID_CHAR_DECLARE;
static const uint16_t cccd_uuid = ESP_GATT_UUID_CHAR_CLIENT_CONFIG;
static const uint8_t prop_rx = ESP_GATT_CHAR_PROP_BIT_WRITE | ESP_GATT_CHAR_PROP_BIT_WRITE_NR;
static const uint8_t prop_tx = ESP_GATT_CHAR_PROP_BIT_NOTIFY;
static uint8_t cccd_val[2];
static uint8_t tx_val[1];

enum { IDX_SVC, IDX_RX_DECL, IDX_RX_VAL, IDX_TX_DECL, IDX_TX_VAL, IDX_TX_CCCD, IDX_NB };

static const esp_gatts_attr_db_t db[IDX_NB] = {
    [IDX_SVC] = {{ESP_GATT_AUTO_RSP},
                 {ESP_UUID_LEN_16, (uint8_t *)&primary_uuid, ESP_GATT_PERM_READ, 16, 16, (uint8_t *)nus_svc}},
    [IDX_RX_DECL] = {{ESP_GATT_AUTO_RSP},
                     {ESP_UUID_LEN_16, (uint8_t *)&char_decl_uuid, ESP_GATT_PERM_READ, 1, 1, (uint8_t *)&prop_rx}},
    [IDX_RX_VAL] = {{ESP_GATT_AUTO_RSP}, {ESP_UUID_LEN_128, (uint8_t *)nus_rx, ESP_GATT_PERM_WRITE, 512, 0, NULL}},
    [IDX_TX_DECL] = {{ESP_GATT_AUTO_RSP},
                     {ESP_UUID_LEN_16, (uint8_t *)&char_decl_uuid, ESP_GATT_PERM_READ, 1, 1, (uint8_t *)&prop_tx}},
    [IDX_TX_VAL] = {{ESP_GATT_AUTO_RSP}, {ESP_UUID_LEN_128, (uint8_t *)nus_tx, ESP_GATT_PERM_READ, 1, 1, tx_val}},
    [IDX_TX_CCCD] = {{ESP_GATT_AUTO_RSP},
                     {ESP_UUID_LEN_16, (uint8_t *)&cccd_uuid, ESP_GATT_PERM_READ | ESP_GATT_PERM_WRITE, 2, 2, cccd_val}},
};

typedef struct {
    char *text;
    int len;
    int frags;
} line_t;

static uint16_t handles[IDX_NB];
static esp_gatt_if_t gatts_if_saved = ESP_GATT_IF_NONE;
static volatile int conn_id = -1;
static volatile bool tx_notify;
static volatile int mtu = 23;
static QueueHandle_t lines;
static volatile bool hello_due;

// Name in the advertisement, 128-bit service UUID in the scan response (both do not fit in 31 bytes)
static uint8_t adv_raw[] = {0x02, 0x01, 0x06, 0x0a, 0x09, 'C', 'l', 'a', 'u', 'd', 'e', '-', 'B', 'D'};
static uint8_t rsp_raw[] = {0x11, 0x07, 0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0,
                            0x93, 0xf3, 0xa3, 0xb5, 0x01, 0x00, 0x40, 0x6e};
static esp_ble_adv_params_t adv_params = {
    .adv_int_min = 0x40,
    .adv_int_max = 0x40,
    .adv_type = ADV_TYPE_IND,
    .own_addr_type = BLE_ADDR_TYPE_PUBLIC,
    .channel_map = ADV_CHNL_ALL,
    .adv_filter_policy = ADV_FILTER_ALLOW_SCAN_ANY_CON_ANY,
};
static int adv_pending = 2;

// Receive buffer: owned by the Bluedroid BTC task only
static char rx_buf[MSG_MAX + 1];
static int rx_len, rx_frags;
static bool rx_drop;

static void rx_bytes(const uint8_t *d, int n)
{
    rx_frags++;
    for (int i = 0; i < n; i++) {
        char c = (char)d[i];
        if (c == '\n') {
            if (rx_drop) {
                printf("丢弃超长消息 (> %d 字节)\n", MSG_MAX);
            } else if (rx_len > 0) {
                line_t l = {.text = malloc(rx_len + 1), .len = rx_len, .frags = rx_frags};
                if (l.text) {
                    memcpy(l.text, rx_buf, rx_len);
                    l.text[rx_len] = 0;
                    if (xQueueSend(lines, &l, 0) != pdTRUE) free(l.text);
                }
            }
            rx_len = 0;
            rx_frags = 0;
            rx_drop = false;
        } else if (rx_len < MSG_MAX) {
            rx_buf[rx_len++] = c;
        } else {
            rx_drop = true;
        }
    }
}

static int send_line(const char *s)
{
    if (conn_id < 0 || !tx_notify) return 0;
    int len = strlen(s);
    int chunk = mtu - 3;
    if (chunk < 20) chunk = 20;
    int k = 0;
    for (int off = 0; off <= len; off += chunk) {
        int n = len + 1 - off < chunk ? len + 1 - off : chunk;
        uint8_t tmp[260];
        if (n > (int)sizeof(tmp)) n = sizeof(tmp);
        memcpy(tmp, s + off, n);
        if (off + n == len + 1) tmp[n - 1] = '\n';
        if (esp_ble_gatts_send_indicate(gatts_if_saved, conn_id, handles[IDX_TX_VAL], n, tmp, false) != ESP_OK) break;
        k++;
        if (off + n >= len + 1) break;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    return k;
}

static int n_hb, n_status, n_time, n_owner;
static bool ok_printed;

static void ack(const char *cmd, bool ok)
{
    char s[96];
    snprintf(s, sizeof(s), "{\"ack\":\"%s\",\"ok\":%s}", cmd, ok ? "true" : "false");
    send_line(s);
}

static void handle_line(line_t *l)
{
    printf("收到: %.60s (%d 字节 %d 片)\n", l->text, l->len, l->frags);
    cJSON *j = cJSON_Parse(l->text);
    if (!j) {
        printf("JSON 解析失败\n");
        return;
    }
    cJSON *t = cJSON_GetObjectItem(j, "time");
    cJSON *cmd = cJSON_GetObjectItem(j, "cmd");
    if (cJSON_IsArray(t) && cJSON_GetArraySize(t) == 2) {
        time_t epoch = (time_t)cJSON_GetArrayItem(t, 0)->valuedouble;
        int tz = (int)cJSON_GetArrayItem(t, 1)->valuedouble;
        struct timeval tv = {.tv_sec = epoch};
        settimeofday(&tv, NULL);
        time_t local = epoch + tz;
        struct tm tm;
        gmtime_r(&local, &tm);
        n_time++;
        printf("时间 已设置 %04d-%02d-%02d %02d:%02d:%02d (UTC%+d)\n", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
               tm.tm_hour, tm.tm_min, tm.tm_sec, tz / 3600);
    } else if (cJSON_IsString(cmd)) {
        const char *c = cmd->valuestring;
        if (!strcmp(c, "owner")) {
            cJSON *n = cJSON_GetObjectItem(j, "name");
            n_owner++;
            printf("主人 %s\n", cJSON_IsString(n) ? n->valuestring : "?");
            ack("owner", true);
        } else if (!strcmp(c, "status")) {
            n_status++;
            char s[400];
            // Padded past one 244-byte notification so back-to-back Bluedroid notifications get exercised
            snprintf(s, sizeof(s),
                     "{\"ack\":\"status\",\"ok\":true,\"data\":{\"name\":\"%s\",\"sec\":false,"
                     "\"bat\":{\"pct\":87,\"mV\":4012,\"mA\":-120,\"usb\":true},"
                     "\"sys\":{\"up\":%lld,\"heap\":%lu},\"stats\":{\"hb\":%d,\"polls\":%d},"
                     "\"link\":{\"host\":\"Bluedroid\",\"mtu\":%d},\"fw\":\"TryBoard " FW_ID " 1.0 (%s, Bluedroid)\"}}",
                     DEVICE_NAME, (long long)(esp_timer_get_time() / 1000000), (unsigned long)esp_get_free_heap_size(),
                     n_hb, n_status, mtu, CHIP_NAME);
            int k = send_line(s);
            printf("status #%d → ack %d 字节 %d 片\n", n_status, (int)strlen(s), k);
        } else {
            printf("未知命令 %s\n", c);
            ack(c, false);
        }
    } else if (cJSON_GetObjectItem(j, "total")) {
        n_hb++;
        cJSON *tok = cJSON_GetObjectItem(j, "tokens");
        cJSON *run = cJSON_GetObjectItem(j, "running");
        printf("心跳 #%d tokens=%.0f running=%d\n", n_hb, cJSON_IsNumber(tok) ? tok->valuedouble : -1,
               cJSON_IsNumber(run) ? run->valueint : -1);
    } else {
        printf("未识别的消息\n");
    }
    cJSON_Delete(j);
    if (!ok_printed && n_hb >= 1 && n_status >= 3 && n_time && n_owner) {
        ok_printed = true;
        printf("TRYBOARD_OK " FW_ID "\n");
    }
}

static void gap_cb(esp_gap_ble_cb_event_t ev, esp_ble_gap_cb_param_t *p)
{
    switch (ev) {
    case ESP_GAP_BLE_ADV_DATA_RAW_SET_COMPLETE_EVT:
    case ESP_GAP_BLE_SCAN_RSP_DATA_RAW_SET_COMPLETE_EVT:
        if (--adv_pending == 0) esp_ble_gap_start_advertising(&adv_params);
        break;
    case ESP_GAP_BLE_ADV_START_COMPLETE_EVT:
        if (p->adv_start_cmpl.status == ESP_BT_STATUS_SUCCESS) {
            printf("BLE 广播 %s\n", DEVICE_NAME);
        } else {
            printf("广播启动失败 status=%d\n", p->adv_start_cmpl.status);
        }
        break;
    default:
        break;
    }
}

static void gatts_cb(esp_gatts_cb_event_t ev, esp_gatt_if_t gif, esp_ble_gatts_cb_param_t *p)
{
    switch (ev) {
    case ESP_GATTS_REG_EVT:
        gatts_if_saved = gif;
        esp_ble_gap_set_device_name(DEVICE_NAME);
        esp_ble_gap_config_adv_data_raw(adv_raw, sizeof(adv_raw));
        esp_ble_gap_config_scan_rsp_data_raw(rsp_raw, sizeof(rsp_raw));
        esp_ble_gatts_create_attr_tab(db, gif, IDX_NB, 0);
        break;
    case ESP_GATTS_CREAT_ATTR_TAB_EVT:
        if (p->add_attr_tab.status != ESP_GATT_OK || p->add_attr_tab.num_handle != IDX_NB) {
            printf("属性表创建失败 status=%d\n", p->add_attr_tab.status);
            break;
        }
        memcpy(handles, p->add_attr_tab.handles, sizeof(handles));
        esp_ble_gatts_start_service(handles[IDX_SVC]);
        printf("NUS 服务 句柄 0x%04x RX 0x%04x TX 0x%04x\n", handles[IDX_SVC], handles[IDX_RX_VAL], handles[IDX_TX_VAL]);
        break;
    case ESP_GATTS_CONNECT_EVT:
        conn_id = p->connect.conn_id;
        printf("连接 成功 conn_id=%d\n", conn_id);
        break;
    case ESP_GATTS_DISCONNECT_EVT:
        printf("断开 reason=0x%x\n", p->disconnect.reason);
        conn_id = -1;
        tx_notify = false;
        mtu = 23;
        esp_ble_gap_start_advertising(&adv_params);
        break;
    case ESP_GATTS_MTU_EVT:
        mtu = p->mtu.mtu;
        printf("MTU %d\n", mtu);
        break;
    case ESP_GATTS_WRITE_EVT:
        if (p->write.handle == handles[IDX_TX_CCCD] && p->write.len == 2) {
            tx_notify = (p->write.value[0] & 1) != 0;
            printf("TX 订阅 notify=%d\n", tx_notify);
            hello_due = tx_notify;
        } else if (p->write.handle == handles[IDX_RX_VAL]) {
            rx_bytes(p->write.value, p->write.len);
        }
        break;
    default:
        break;
    }
}

static void line_task(void *arg)
{
    line_t l;
    for (;;) {
        if (xQueueReceive(lines, &l, pdMS_TO_TICKS(100)) == pdTRUE) {
            handle_line(&l);
            free(l.text);
        }
        // Greeting one tick after subscribing, so a plain phone sees a notification without sending anything
        if (hello_due) {
            hello_due = false;
            int k = send_line("{\"hello\":\"" DEVICE_NAME "\",\"chip\":\"" CHIP_NAME "\"}");
            printf("问候 通知 %d 片\n", k);
        }
    }
}

void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }
    lines = xQueueCreate(8, sizeof(line_t));
    xTaskCreate(line_task, "lines", 6144, NULL, 5, NULL);
    esp_bt_controller_config_t cfg = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
    if ((ret = esp_bt_controller_init(&cfg)) != ESP_OK || (ret = esp_bt_controller_enable(ESP_BT_MODE_BLE)) != ESP_OK) {
        printf("控制器启动失败 %s\n", esp_err_to_name(ret));
        return;
    }
    if ((ret = esp_bluedroid_init()) != ESP_OK || (ret = esp_bluedroid_enable()) != ESP_OK) {
        printf("Bluedroid 启动失败 %s\n", esp_err_to_name(ret));
        return;
    }
    printf("Bluedroid 已启动\n");
    esp_ble_gap_register_callback(gap_cb);
    esp_ble_gatts_register_callback(gatts_cb);
    esp_ble_gatt_set_local_mtu(247);
    esp_ble_gatts_app_register(0);
}
