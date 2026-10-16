// 示例：I2S 录音。ESP32-S3 的 I2S1（I2S0 留给喇叭）以标准 Philips 格式（16 kHz、32 位槽、单声道左声道）读 INMP441 数字麦克风
// （SCK=GPIO39、WS=GPIO40、SD=GPIO41，L/R 接地 = 左声道），每 1024 个样本算一次 RMS（满量程 = 1）与
// 过零频率（相邻上升过零点线性插值，比数过零次数精确），打印出来。
// 只用 ESP-IDF 自带的 esp_driver_i2s（Apache-2.0）。
#include <math.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2s_std.h"

#define PIN_SCK 39
#define PIN_WS 40
#define PIN_SD 41
#define RATE 16000
#define N 1024

static int32_t raw[N];

void app_main(void)
{
    i2s_chan_handle_t rx;
    i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    ESP_ERROR_CHECK(i2s_new_channel(&chan, NULL, &rx));
    i2s_std_config_t std = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = PIN_SCK,
            .ws = PIN_WS,
            .dout = I2S_GPIO_UNUSED,
            .din = PIN_SD,
        },
    };
    // INMP441 的 L/R 脚接地时只在左声道输出
    std.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(rx, &std));
    ESP_ERROR_CHECK(i2s_channel_enable(rx));
    printf("MIC INMP441 on I2S1 @ %d Hz, 32 bit slot, SCK=GPIO%d WS=GPIO%d SD=GPIO%d\n", RATE, PIN_SCK, PIN_WS, PIN_SD);

    for (int blk = 0;; blk++) {
        size_t got = 0;
        ESP_ERROR_CHECK(i2s_channel_read(rx, raw, sizeof(raw), &got, portMAX_DELAY));
        int n = got / sizeof(int32_t);
        // 24 位有效数据在高位
        double sum = 0, mean = 0;
        for (int i = 0; i < n; i++) mean += (raw[i] >> 8);
        mean /= n;
        float first = -1, last = -1;
        int ups = 0;
        float prev = 0;
        for (int i = 0; i < n; i++) {
            float x = (float)(((raw[i] >> 8) - mean) / 8388608.0);
            sum += (double)x * x;
            if (i > 0 && prev < 0 && x >= 0) {
                float t = (i - 1) + prev / (prev - x);
                if (first < 0) first = t;
                last = t;
                ups++;
            }
            prev = x;
        }
        float rms = sqrtf((float)(sum / n));
        float freq = (ups >= 2 && last > first) ? (ups - 1) * RATE / (last - first) : 0;
        // 第一块里有 DMA 启动前的空白，从第二块开始打印
        if (blk >= 1 && blk % 4 == 1) {
            printf("MIC rms=%.4f freq=%.1f Hz\n", rms, freq);
        }
        if (blk == 9) printf("TRYBOARD_OK s3-i2s-mic\n");
    }
}
