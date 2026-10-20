// Example: ESP32-S3 console on USB-Serial-JTAG (CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG). Line echo; ping answers pong.
#include <stdio.h>
#include <string.h>
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"

void app_main(void)
{
    usb_serial_jtag_driver_config_t cfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    usb_serial_jtag_driver_install(&cfg);
    usb_serial_jtag_vfs_use_driver();
    printf("USB 串口回显：输入一行文字后回车\n");
    char line[128];
    int n = 0;
    for (;;) {
        uint8_t c;
        if (usb_serial_jtag_read_bytes(&c, 1, portMAX_DELAY) != 1) continue;
        if (c == '\r') continue;
        if (c == '\n' || n == sizeof(line) - 1) {
            line[n] = 0;
            printf("ECHO: %s (%d 字节)\n", line, n);
            if (strcmp(line, "ping") == 0) printf("pong\nTRYBOARD_OK s3-usj-echo\n");
            n = 0;
        } else {
            line[n++] = c;
        }
    }
}
