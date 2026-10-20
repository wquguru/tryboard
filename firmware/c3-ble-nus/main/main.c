// Acceptance (E-06): NimBLE peripheral "Claude-TB" speaking the Claude Desktop Buddy protocol over Nordic UART Service.
// RX 6e400002 (write / write without response) collects lines up to '\n'; TX 6e400003 notifies acks split at MTU-3.
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
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#define MSG_MAX 4096
static const char *DEVICE_NAME = "Claude-TB";

// 6e40000x-b5a3-f393-e0a9-e50e24dcca9e, little-endian as NimBLE wants
#define NUS_UUID(x) BLE_UUID128_INIT(0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0, 0x93, 0xf3, 0xa3, 0xb5, x, 0x00, 0x40, 0x6e)
static const ble_uuid128_t nus_svc = NUS_UUID(0x01);
static const ble_uuid128_t nus_rx = NUS_UUID(0x02);
static const ble_uuid128_t nus_tx = NUS_UUID(0x03);

typedef struct {
    char *text;
    int len;
    int frags;
} line_t;

static uint16_t tx_handle;
static uint16_t conn = BLE_HS_CONN_HANDLE_NONE;
static volatile bool tx_notify;
static uint8_t own_addr_type;
static QueueHandle_t lines;

// Receive buffer: owned by the NimBLE host task only
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

static int chr_access(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;
    uint8_t buf[512];
    uint16_t n = 0;
    if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &n) != 0) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    rx_bytes(buf, n);
    return 0;
}

static const struct ble_gatt_svc_def services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &nus_svc.u,
        .characteristics = (struct ble_gatt_chr_def[]){
            {.uuid = &nus_rx.u, .access_cb = chr_access, .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP},
            {.uuid = &nus_tx.u, .access_cb = chr_access, .val_handle = &tx_handle, .flags = BLE_GATT_CHR_F_NOTIFY},
            {0},
        },
    },
    {0},
};

// Send one line on TX, split at MTU-3; returns the number of notifications
static int send_line(const char *s)
{
    if (conn == BLE_HS_CONN_HANDLE_NONE || !tx_notify) return 0;
    int len = strlen(s);
    int chunk = ble_att_mtu(conn) - 3;
    if (chunk < 20) chunk = 20;
    int k = 0;
    for (int off = 0; off <= len; off += chunk) {
        int n = len + 1 - off < chunk ? len + 1 - off : chunk;
        char tmp[260];
        if (n > (int)sizeof(tmp)) n = sizeof(tmp);
        memcpy(tmp, s + off, n);
        if (off + n == len + 1) tmp[n - 1] = '\n';
        struct os_mbuf *om = ble_hs_mbuf_from_flat(tmp, n);
        if (ble_gatts_notify_custom(conn, tx_handle, om) != 0) break;
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
            struct timeval now;
            gettimeofday(&now, NULL);
            char s[400];
            // Padded past one 244-byte notification so the desk side has to reassemble
            snprintf(s, sizeof(s),
                     "{\"ack\":\"status\",\"ok\":true,\"data\":{\"name\":\"%s\",\"sec\":false,"
                     "\"bat\":{\"pct\":87,\"mV\":4012,\"mA\":-120,\"usb\":true},"
                     "\"sys\":{\"up\":%lld,\"heap\":%lu,\"clock\":%lld},"
                     "\"stats\":{\"appr\":0,\"deny\":0,\"vel\":0,\"nap\":0,\"lvl\":1,\"hb\":%d,\"polls\":%d},"
                     "\"fw\":\"TryBoard c3-ble-nus 1.0 (ESP32-C3, NimBLE)\"}}",
                     DEVICE_NAME, (long long)(esp_timer_get_time() / 1000000), (unsigned long)esp_get_free_heap_size(),
                     (long long)now.tv_sec, n_hb, n_status);
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
        cJSON *wait = cJSON_GetObjectItem(j, "waiting");
        cJSON *tot = cJSON_GetObjectItem(j, "total");
        cJSON *ent = cJSON_GetObjectItem(j, "entries");
        cJSON *msg = cJSON_GetObjectItem(j, "msg");
        printf("心跳 #%d tokens=%.0f running=%d waiting=%d total=%d entries=%d\n", n_hb,
               cJSON_IsNumber(tok) ? tok->valuedouble : -1, cJSON_IsNumber(run) ? run->valueint : -1,
               cJSON_IsNumber(wait) ? wait->valueint : -1, tot->valueint, cJSON_IsArray(ent) ? cJSON_GetArraySize(ent) : 0);
        if (cJSON_IsString(msg)) printf("  msg: %.60s\n", msg->valuestring);
    } else {
        printf("未识别的消息\n");
    }
    cJSON_Delete(j);
    if (!ok_printed && n_hb >= 2 && n_status >= 5 && n_time && n_owner) {
        ok_printed = true;
        printf("TRYBOARD_OK c3-ble-nus\n");
    }
}

static void advertise(void);

static int gap_event(struct ble_gap_event *ev, void *arg)
{
    switch (ev->type) {
    case BLE_GAP_EVENT_CONNECT:
        printf("连接 %s status=%d\n", ev->connect.status == 0 ? "成功" : "失败", ev->connect.status);
        if (ev->connect.status == 0) {
            conn = ev->connect.conn_handle;
        } else {
            advertise();
        }
        break;
    case BLE_GAP_EVENT_DISCONNECT:
        printf("断开 reason=0x%x\n", ev->disconnect.reason);
        conn = BLE_HS_CONN_HANDLE_NONE;
        tx_notify = false;
        advertise();
        break;
    case BLE_GAP_EVENT_SUBSCRIBE:
        if (ev->subscribe.attr_handle == tx_handle) {
            tx_notify = ev->subscribe.cur_notify;
            printf("TX 订阅 notify=%d\n", tx_notify);
        }
        break;
    case BLE_GAP_EVENT_MTU:
        printf("MTU %d\n", ev->mtu.value);
        break;
    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
        break;
    }
    return 0;
}

static void advertise(void)
{
    struct ble_hs_adv_fields f = {0};
    f.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    f.name = (uint8_t *)DEVICE_NAME;
    f.name_len = strlen(DEVICE_NAME);
    f.name_is_complete = 1;
    int rc = ble_gap_adv_set_fields(&f);
    if (rc != 0) {
        printf("广播数据设置失败 rc=%d\n", rc);
        return;
    }
    struct ble_hs_adv_fields r = {0};
    r.uuids128 = (ble_uuid128_t *)&nus_svc;
    r.num_uuids128 = 1;
    r.uuids128_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&r);
    if (rc != 0) {
        printf("扫描响应设置失败 rc=%d\n", rc);
        return;
    }
    struct ble_gap_adv_params p = {0};
    p.conn_mode = BLE_GAP_CONN_MODE_UND;
    p.disc_mode = BLE_GAP_DISC_MODE_GEN;
    rc = ble_gap_adv_start(own_addr_type, NULL, BLE_HS_FOREVER, &p, gap_event, NULL);
    if (rc != 0) {
        printf("广播启动失败 rc=%d\n", rc);
        return;
    }
    printf("BLE 广播 %s\n", DEVICE_NAME);
}

static void on_sync(void)
{
    ble_hs_id_infer_auto(0, &own_addr_type);
    advertise();
}

static void on_reset(int reason)
{
    printf("BLE 主机复位 reason=%d\n", reason);
}

static void host_task(void *param)
{
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);
    lines = xQueueCreate(8, sizeof(line_t));

    ret = nimble_port_init();
    if (ret != ESP_OK) {
        printf("nimble_port_init 失败 %d\n", ret);
        return;
    }
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_gatts_count_cfg(services);
    ble_gatts_add_svcs(services);
    ble_svc_gap_device_name_set(DEVICE_NAME);
    nimble_port_freertos_init(host_task);

    line_t l;
    for (;;) {
        if (xQueueReceive(lines, &l, portMAX_DELAY) == pdTRUE) {
            handle_line(&l);
            free(l.text);
        }
    }
}
