// 验收：NimBLE 外设（C-01）。广播 "TryBoard-HR"，提供
//   心率服务 0x180D：心率测量 0x2A37（notify，订阅后每秒一次）、传感器位置 0x2A38（read）
//   电池服务 0x180F：电量 0x2A19（read）
//   LED 服务 0xFFE0：开关 0xFFE1（read / write，写 01 点亮 GPIO5 的 LED，写 00 熄灭）
// 虚拟手机（tryboard run --ble-phone 或网页）扫描、连接、读、写、订阅，固件串口打印每一步。
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "nvs_flash.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#define LED_GPIO 5
static const char *DEVICE_NAME = "TryBoard-HR";

static uint16_t hr_handle, led_handle;
static uint16_t conn = BLE_HS_CONN_HANDLE_NONE;
static volatile bool hr_notify;
static uint8_t battery = 87;
static uint8_t led_on;
static uint8_t own_addr_type;

static int chr_access(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    uint16_t uuid = ble_uuid_u16(ctxt->chr->uuid);
    switch (uuid) {
    case 0x2A38: {
        uint8_t loc = 1; // 胸前
        return os_mbuf_append(ctxt->om, &loc, 1) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    case 0x2A19:
        printf("读电量 %d%%\n", battery);
        return os_mbuf_append(ctxt->om, &battery, 1) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    case 0xFFE1:
        if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
            return os_mbuf_append(ctxt->om, &led_on, 1) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
        }
        if (OS_MBUF_PKTLEN(ctxt->om) != 1) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        os_mbuf_copydata(ctxt->om, 0, 1, &led_on);
        gpio_set_level(LED_GPIO, led_on ? 1 : 0);
        printf("写 LED %02x → %s\n", led_on, led_on ? "亮" : "灭");
        if (led_on) printf("TRYBOARD_OK c3-ble-hr\n");
        return 0;
    default:
        return BLE_ATT_ERR_UNLIKELY;
    }
}

static const struct ble_gatt_svc_def services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = BLE_UUID16_DECLARE(0x180D),
        .characteristics = (struct ble_gatt_chr_def[]){
            {.uuid = BLE_UUID16_DECLARE(0x2A37), .access_cb = chr_access, .val_handle = &hr_handle, .flags = BLE_GATT_CHR_F_NOTIFY},
            {.uuid = BLE_UUID16_DECLARE(0x2A38), .access_cb = chr_access, .flags = BLE_GATT_CHR_F_READ},
            {0},
        },
    },
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = BLE_UUID16_DECLARE(0x180F),
        .characteristics = (struct ble_gatt_chr_def[]){
            {.uuid = BLE_UUID16_DECLARE(0x2A19), .access_cb = chr_access, .flags = BLE_GATT_CHR_F_READ},
            {0},
        },
    },
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = BLE_UUID16_DECLARE(0xFFE0),
        .characteristics = (struct ble_gatt_chr_def[]){
            {.uuid = BLE_UUID16_DECLARE(0xFFE1), .access_cb = chr_access, .val_handle = &led_handle,
             .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE},
            {0},
        },
    },
    {0},
};

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
        hr_notify = false;
        advertise();
        break;
    case BLE_GAP_EVENT_SUBSCRIBE:
        if (ev->subscribe.attr_handle == hr_handle) {
            hr_notify = ev->subscribe.cur_notify;
            printf("心率订阅 notify=%d\n", hr_notify);
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
    ble_uuid16_t uuids[] = {BLE_UUID16_INIT(0x180D), BLE_UUID16_INIT(0x180F)};
    f.uuids16 = uuids;
    f.num_uuids16 = 2;
    f.uuids16_is_complete = 0;
    int rc = ble_gap_adv_set_fields(&f);
    if (rc != 0) {
        printf("广播数据设置失败 rc=%d\n", rc);
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
    uint8_t a[6] = {0};
    ble_hs_id_copy_addr(own_addr_type, a, NULL);
    printf("BLE 地址 %02x:%02x:%02x:%02x:%02x:%02x\n", a[5], a[4], a[3], a[2], a[1], a[0]);
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
    gpio_reset_pin(LED_GPIO);
    gpio_set_direction(LED_GPIO, GPIO_MODE_OUTPUT);
    gpio_set_level(LED_GPIO, 0);

    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    ret = nimble_port_init();
    if (ret != ESP_OK) {
        printf("nimble_port_init 失败 %d\n", ret);
        return;
    }
    printf("nimble_port_init ok\n");
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_gatts_count_cfg(services);
    ble_gatts_add_svcs(services);
    ble_svc_gap_device_name_set(DEVICE_NAME);
    nimble_port_freertos_init(host_task);

    uint8_t bpm = 72;
    for (int n = 0;; n++) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (hr_notify && conn != BLE_HS_CONN_HANDLE_NONE) {
            uint8_t hrm[2] = {0x06, bpm};
            struct os_mbuf *om = ble_hs_mbuf_from_flat(hrm, sizeof(hrm));
            int rc = ble_gatts_notify_custom(conn, hr_handle, om);
            printf("通知 心率 %d bpm rc=%d\n", bpm, rc);
            bpm = bpm >= 90 ? 72 : bpm + 3;
        }
    }
}
