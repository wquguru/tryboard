// Example: S3 native USB CDC-ACM virtual serial port (COM port / /dev/ttyACM0); echoes each line in upper case.
// Unlike the UART console, this path has no USB-to-serial chip.
#include <stdio.h>
#include <ctype.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "tinyusb.h"
#include "tusb_cdc_acm.h"

static uint8_t buf[CONFIG_TINYUSB_CDC_RX_BUFSIZE + 1];
static char line[128];
static int len;

static void on_rx(int itf, cdcacm_event_t *event)
{
    size_t n = 0;
    if (tinyusb_cdcacm_read(itf, buf, CONFIG_TINYUSB_CDC_RX_BUFSIZE, &n) != ESP_OK) return;
    for (size_t i = 0; i < n; i++) {
        char c = buf[i];
        if (c == '\r') continue;
        if (c == '\n' || len == sizeof(line) - 1) {
            line[len] = 0;
            printf("CDC 收到：%s\n", line);
            char out[160];
            int k = snprintf(out, sizeof(out), "ECHO: ");
            for (int j = 0; j < len && k < (int)sizeof(out) - 3; j++) out[k++] = toupper((unsigned char)line[j]);
            out[k++] = '\r';
            out[k++] = '\n';
            tinyusb_cdcacm_write_queue(itf, (uint8_t *)out, k);
            tinyusb_cdcacm_write_flush(itf, 0);
            if (len == 4 && line[0] == 'p' && line[1] == 'i' && line[2] == 'n' && line[3] == 'g') printf("TRYBOARD_OK usb-cdc\n");
            len = 0;
        } else {
            line[len++] = c;
        }
    }
}

static const char *strings[] = {
    (char[]){0x09, 0x04}, // English
    "TryBoard",           // manufacturer
    "TryBoard Serial",    // product
    "000002",             // serial number
    "CDC-ACM",
};

void app_main(void)
{
    const tinyusb_config_t cfg = {
        .string_descriptor = strings,
        .string_descriptor_count = sizeof(strings) / sizeof(strings[0]),
    };
    ESP_ERROR_CHECK(tinyusb_driver_install(&cfg));
    tinyusb_config_cdcacm_t acm = {
        .usb_dev = TINYUSB_USBDEV_0,
        .cdc_port = TINYUSB_CDC_ACM_0,
        .rx_unread_buf_sz = 64,
        .callback_rx = &on_rx,
    };
    ESP_ERROR_CHECK(tusb_cdc_acm_init(&acm));
    printf("USB CDC 虚拟串口已初始化\n");
    while (!tud_mounted()) vTaskDelay(pdMS_TO_TICKS(10));
    printf("USB 已连接：电脑上多了一个串口\n");
    const char *hi = "Hi from TryBoard CDC\r\n";
    tinyusb_cdcacm_write_queue(TINYUSB_CDC_ACM_0, (const uint8_t *)hi, 22);
    tinyusb_cdcacm_write_flush(TINYUSB_CDC_ACM_0, 0);
    for (;;) vTaskDelay(pdMS_TO_TICKS(1000));
}
