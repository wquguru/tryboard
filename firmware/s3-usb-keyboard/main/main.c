// Example: S3 native USB as keyboard + mouse; 1 s after plug-in it types a line and draws a square, again on each BOOT (GPIO0).
// Works on real boards: use the Type-C port marked USB / OTG.
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "tinyusb.h"
#include "class/hid/hid_device.h"

#define BOOT_GPIO 0
#define TEXT "Hello from TryBoard!\n"

enum { RID_KEYBOARD = 1, RID_MOUSE };

static const uint8_t report_desc[] = {
    TUD_HID_REPORT_DESC_KEYBOARD(HID_REPORT_ID(RID_KEYBOARD)),
    TUD_HID_REPORT_DESC_MOUSE(HID_REPORT_ID(RID_MOUSE)),
};

static const char *strings[] = {
    (char[]){0x09, 0x04}, // English
    "TryBoard",           // manufacturer
    "TryBoard Keyboard",  // product
    "000001",             // serial number
    "HID keyboard + mouse",
};

#define CONFIG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_HID_DESC_LEN)
static const uint8_t config_desc[] = {
    TUD_CONFIG_DESCRIPTOR(1, 1, 0, CONFIG_TOTAL_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    TUD_HID_DESCRIPTOR(0, 4, HID_ITF_PROTOCOL_NONE, sizeof(report_desc), 0x81, 16, 10),
};

uint8_t const *tud_hid_descriptor_report_cb(uint8_t instance) { return report_desc; }
uint16_t tud_hid_get_report_cb(uint8_t i, uint8_t id, hid_report_type_t t, uint8_t *b, uint16_t n) { return 0; }
void tud_hid_set_report_cb(uint8_t i, uint8_t id, hid_report_type_t t, uint8_t const *b, uint16_t n) {}

static const uint8_t ascii_map[128][2] = {HID_ASCII_TO_KEYCODE};

static void wait_ready(void)
{
    for (int i = 0; i < 100 && !tud_hid_ready(); i++) vTaskDelay(pdMS_TO_TICKS(2));
}

static void type_text(const char *s)
{
    for (; *s; s++) {
        uint8_t c = (uint8_t)*s & 0x7f;
        uint8_t keys[6] = {ascii_map[c][1]};
        wait_ready();
        tud_hid_keyboard_report(RID_KEYBOARD, ascii_map[c][0] ? KEYBOARD_MODIFIER_LEFTSHIFT : 0, keys);
        vTaskDelay(pdMS_TO_TICKS(12));
        wait_ready();
        tud_hid_keyboard_report(RID_KEYBOARD, 0, NULL);
        vTaskDelay(pdMS_TO_TICKS(12));
    }
}

static void mouse_square(void)
{
    const int8_t dx[4] = {5, 0, -5, 0}, dy[4] = {0, 5, 0, -5};
    for (int side = 0; side < 4; side++) {
        for (int i = 0; i < 20; i++) {
            wait_ready();
            tud_hid_mouse_report(RID_MOUSE, 0, dx[side], dy[side], 0, 0);
            vTaskDelay(pdMS_TO_TICKS(15));
        }
    }
}

static void demo(int n)
{
    printf("[%d] 打字：%s", n, TEXT);
    type_text(TEXT);
    printf("[%d] 鼠标画正方形\n", n);
    mouse_square();
}

void app_main(void)
{
    gpio_config_t btn = {.pin_bit_mask = 1ULL << BOOT_GPIO, .mode = GPIO_MODE_INPUT, .pull_up_en = 1};
    gpio_config(&btn);

    const tinyusb_config_t cfg = {
        .device_descriptor = NULL,
        .string_descriptor = strings,
        .string_descriptor_count = sizeof(strings) / sizeof(strings[0]),
        .external_phy = false,
        .configuration_descriptor = config_desc,
    };
    ESP_ERROR_CHECK(tinyusb_driver_install(&cfg));
    printf("USB 已初始化，等电脑枚举…\n");

    while (!tud_mounted()) vTaskDelay(pdMS_TO_TICKS(10));
    printf("USB 已连接：电脑把我当成了键盘 + 鼠标\n");
    vTaskDelay(pdMS_TO_TICKS(1000));
    demo(1);
    printf("TRYBOARD_OK usb-keyboard\n");

    int n = 1, last = 1;
    for (;;) {
        int lv = gpio_get_level(BOOT_GPIO);
        if (last && !lv && tud_mounted()) demo(++n);
        last = lv;
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
