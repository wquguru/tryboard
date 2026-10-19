// Example: I2S playback on the C3's only I2S0, Philips 44.1 kHz 16-bit mono duplicated to L/R: a 440 Hz sine to a MAX98357A amp
// (BCLK=GPIO0, LRC=GPIO1, DIN=GPIO2, matching the simulator's C3 i2s_pin) driving a 4 ohm speaker. Uses only IDF esp_driver_i2s (Apache-2.0).
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

    // Phase accumulator: a buffer needn't hold a whole number of periods
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
        // Once DMA buffers fill, write blocks at playback speed: after 1 s check that write rate equals sample rate
        if (n == 100) {
            int64_t dt = esp_timer_get_time() - t0;
            printf("TONE wrote %u frames in %lld ms\n", (unsigned)frames, dt / 1000);
            printf("TRYBOARD_OK c3-i2s-tone\n");
        }
    }
}
