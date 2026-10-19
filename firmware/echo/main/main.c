// Example: UART0 line echo. Type a line, the board echoes it; ping answers pong.
#include <stdio.h>
#include <string.h>
#include "driver/uart.h"

void app_main(void)
{
    uart_driver_install(UART_NUM_0, 1024, 0, 0, NULL, 0);
    printf("串口回显：输入一行文字后回车\n");
    char line[128];
    int n = 0;
    for (;;) {
        uint8_t c;
        if (uart_read_bytes(UART_NUM_0, &c, 1, portMAX_DELAY) != 1) continue;
        if (c == '\r') continue;
        if (c == '\n' || n == sizeof(line) - 1) {
            line[n] = 0;
            printf("ECHO: %s (%d 字节)\n", line, n);
            if (strcmp(line, "ping") == 0) printf("pong\nTRYBOARD_OK echo\n");
            n = 0;
        } else {
            line[n++] = c;
        }
    }
}
