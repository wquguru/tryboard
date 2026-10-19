// "USB macro pad" (usbkey) reference: S3 HID keyboard; keys on GPIO4-7 to GND (pull-up): K1-K3 send a / b / c, K4 types "Hello TryBoard\n".
// One firmware for checkpoints usbkey-1/2/3 (enumerate, keys, macro); on real boards use the USB / OTG Type-C port.
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "tinyusb.h"
#include "class/hid/hid_device.h"

#define MACRO_TEXT "Hello TryBoard\n"

static const int KEY_GPIO[4] = {4, 5, 6, 7};
static const char KEY_CHAR[3] = {'a', 'b', 'c'};

static const uint8_t report_desc[] = {
    TUD_HID_REPORT_DESC_KEYBOARD(),
};

static const char *strings[] = {
    (char[]){0x09, 0x04}, // English
    "TryBoard",           // manufacturer
    "TryBoard Macro Pad", // product
    "000002",             // serial number
    "HID keyboard",
};

#define CONFIG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_HID_DESC_LEN)
static const uint8_t config_desc[] = {
    TUD_CONFIG_DESCRIPTOR(1, 1, 0, CONFIG_TOTAL_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    TUD_HID_DESCRIPTOR(0, 4, HID_ITF_PROTOCOL_KEYBOARD, sizeof(report_desc), 0x81, 16, 10),
};

uint8_t const *tud_hid_descriptor_report_cb(uint8_t instance) { return report_desc; }
uint16_t tud_hid_get_report_cb(uint8_t i, uint8_t id, hid_report_type_t t, uint8_t *b, uint16_t n) { return 0; }
void tud_hid_set_report_cb(uint8_t i, uint8_t id, hid_report_type_t t, uint8_t const *b, uint16_t n) {}

static const uint8_t ascii_map[128][2] = {HID_ASCII_TO_KEYCODE};

static void wait_ready(void)
{
    for (int i = 0; i < 100 && !tud_hid_ready(); i++) vTaskDelay(pdMS_TO_TICKS(2));
}

// One character = press report + release report (12 ms apart; host polls every 10 ms)
static void type_char(char ch)
{
    uint8_t c = (uint8_t)ch & 0x7f;
    uint8_t keys[6] = {ascii_map[c][1]};
    wait_ready();
    tud_hid_keyboard_report(0, ascii_map[c][0] ? KEYBOARD_MODIFIER_LEFTSHIFT : 0, keys);
    vTaskDelay(pdMS_TO_TICKS(12));
    wait_ready();
    tud_hid_keyboard_report(0, 0, NULL);
    vTaskDelay(pdMS_TO_TICKS(12));
}

void app_main(void)
{
    gpio_config_t io = {.mode = GPIO_MODE_INPUT, .pull_up_en = 1};
    for (int i = 0; i < 4; i++) io.pin_bit_mask |= 1ULL << KEY_GPIO[i];
    gpio_config(&io);

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
    printf("USB 已连接：电脑把我当成了键盘\n");
    printf("TRYBOARD_OK usbkey\n");

    // Debounce: level must agree on 2 consecutive samples (20 ms); fires once on press
    int stable[4] = {1, 1, 1, 1}, last[4] = {1, 1, 1, 1};
    for (;;) {
        for (int k = 0; k < 4; k++) {
            int lv = gpio_get_level(KEY_GPIO[k]);
            if (lv == last[k] && lv != stable[k]) {
                stable[k] = lv;
                if (lv == 0 && tud_mounted()) {
                    if (k < 3) {
                        printf("KEY %d %c\n", k + 1, KEY_CHAR[k]);
                        type_char(KEY_CHAR[k]);
                    } else {
                        printf("MACRO %s", MACRO_TEXT);
                        for (const char *s = MACRO_TEXT; *s; s++) type_char(*s);
                    }
                }
            }
            last[k] = lv;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
