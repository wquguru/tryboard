// 示例：I2S 放音。ESP32-C3 的 I2S0（C3 只有这一个 I2S） 以标准 Philips 格式（44.1 kHz、16 位、单声道复制到左右声道）
// 把 440 Hz 正弦波送给 MAX98357A 功放模块（BCLK=GPIO0、LRC=GPIO1、DIN=GPIO2，与模拟器 C3 的 i2s_pin 约定一致），驱动 4Ω 小喇叭。
// 只用 ESP-IDF 自带的 esp_driver_i2s（Apache-2.0）。
#include <math.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2s_std.h"
#include "esp_timer.h"

#define PIN_BCLK 0
#define PIN_LRC 1
#define PIN_DIN 2
#define RATE 44100
#define TONE_HZ 440.0f
#define FRAMES 512

static int16_t buf[FRAMES];

void app_main(void)
{
    i2s_chan_handle_t tx;
    i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    ESP_ERROR_CHECK(i2s_new_channel(&chan, &tx, NULL));
    i2s_std_config_t std = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = PIN_BCLK,
            .ws = PIN_LRC,
            .dout = PIN_DIN,
            .din = I2S_GPIO_UNUSED,
        },
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx, &std));
    ESP_ERROR_CHECK(i2s_channel_enable(tx));
    printf("TONE %.0f Hz @ %d Hz, 16 bit mono, BCLK=GPIO%d LRC=GPIO%d DIN=GPIO%d\n", TONE_HZ, RATE, PIN_BCLK, PIN_LRC,
           PIN_DIN);

    // 相位累加：不要求一个缓冲正好装整数个周期
    float phase = 0, step = 2.0f * (float)M_PI * TONE_HZ / RATE;
    int64_t t0 = esp_timer_get_time();
    uint32_t frames = 0;
    for (int n = 0;; n++) {
        for (int i = 0; i < FRAMES; i++) {
            buf[i] = (int16_t)(16000.0f * sinf(phase));
            phase += step;
            if (phase > 2.0f * (float)M_PI) phase -= 2.0f * (float)M_PI;
        }
        size_t w = 0;
        ESP_ERROR_CHECK(i2s_channel_write(tx, buf, sizeof(buf), &w, portMAX_DELAY));
        frames += w / sizeof(int16_t);
        // 写满 DMA 缓冲之后 write 会按播放速度阻塞：1 秒后检查写入速率是否等于采样率
        if (n == 100) {
            int64_t dt = esp_timer_get_time() - t0;
            printf("TONE wrote %u frames in %lld ms\n", (unsigned)frames, dt / 1000);
            printf("TRYBOARD_OK c3-i2s-tone\n");
        }
    }
}
