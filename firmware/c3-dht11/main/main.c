// D-03 acceptance: DHT11 temperature / humidity on GPIO5 with a hand-written driver.
// Pulse widths are measured by counting esp_rom_delay_us(1) loops, the classic busy-wait way.
#include <stdio.h>
#include "driver/gpio.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define DHT_GPIO 5
#define READS 100
#define TIMEOUT 200

static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

// Loop count while the line stays at `level` (about 1 us per loop); -1 on timeout
static int wait_while(int level)
{
    int n = 0;
    while (gpio_get_level(DHT_GPIO) == level) {
        if (++n > TIMEOUT) {
            return -1;
        }
        esp_rom_delay_us(1);
    }
    return n;
}

// One frame into d[5]; 0 = ok, negative = which step timed out
static int dht11_read(uint8_t d[5])
{
    int lows[40], highs[40];
    gpio_set_level(DHT_GPIO, 0);
    esp_rom_delay_us(20000);
    int err = 0;
    portENTER_CRITICAL(&mux);
    gpio_set_level(DHT_GPIO, 1);
    if (wait_while(1) < 0) {
        err = -1;
    } else if (wait_while(0) < 0) {
        err = -2;
    } else if (wait_while(1) < 0) {
        err = -3;
    } else {
        for (int i = 0; i < 40; i++) {
            lows[i] = wait_while(0);
            highs[i] = wait_while(1);
            if (lows[i] < 0 || highs[i] < 0) {
                err = -4;
                break;
            }
        }
    }
    portEXIT_CRITICAL(&mux);
    if (err) {
        return err;
    }
    for (int i = 0; i < 5; i++) {
        d[i] = 0;
    }
    // A high longer than the 50 us low before it is a 1 (70 us), shorter is a 0 (26-28 us): no absolute threshold
    for (int i = 0; i < 40; i++) {
        d[i / 8] = (d[i / 8] << 1) | (highs[i] > lows[i]);
    }
    return 0;
}

void app_main(void)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << DHT_GPIO,
        .mode = GPIO_MODE_INPUT_OUTPUT_OD,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&io);
    gpio_set_level(DHT_GPIO, 1);
    printf("DHT11 启动，数据脚 GPIO%d\n", DHT_GPIO);
    // Datasheet: wait 1 s after power-up, then at least 1 s between reads
    vTaskDelay(pdMS_TO_TICKS(1000));
    int ok = 0, t10 = 0, h = 0;
    for (int i = 1; i <= READS; i++) {
        uint8_t d[5];
        int r = dht11_read(d);
        if (r) {
            printf("第 %d 次 读取失败 %d\n", i, r);
        } else if (((d[0] + d[1] + d[2] + d[3]) & 0xff) != d[4]) {
            printf("第 %d 次 校验失败 %02x %02x %02x %02x %02x\n", i, d[0], d[1], d[2], d[3], d[4]);
        } else {
            ok++;
            h = d[0];
            t10 = d[2] * 10 + (d[3] & 0x0f);
            if (d[3] & 0x80) {
                t10 = -t10;
            }
            if (i == 1 || i % 20 == 0) {
                printf("第 %d 次 温度 %d.%d 湿度 %d\n", i, t10 / 10, (t10 < 0 ? -t10 : t10) % 10, h);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
    printf("温度 %d.%d 湿度 %d 校验通过 %d/%d\n", t10 / 10, (t10 < 0 ? -t10 : t10) % 10, h, ok, READS);
    if (ok == READS) {
        printf("TRYBOARD_OK dht11\n");
    }
}
