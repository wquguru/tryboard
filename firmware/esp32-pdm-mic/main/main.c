// Example: PDM microphone on classic ESP32 I2S0 (M5-12), like the SPM1423 on M5StickC Plus2 / Core2 (CLK=GPIO0, DATA=GPIO34).
// The hardware PDM-to-PCM filter yields 16 kHz 16-bit mono; every 1024 samples prints RMS (full scale = 1) and zero-crossing frequency.
#include <math.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2s_pdm.h"

#define PIN_CLK 0
#define PIN_DATA 34
#define RATE 16000
#define N 1024

static int16_t raw[N];

void app_main(void)
{
    i2s_chan_handle_t rx;
    i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    ESP_ERROR_CHECK(i2s_new_channel(&chan, NULL, &rx));
    i2s_pdm_rx_config_t pdm = {
        .clk_cfg = I2S_PDM_RX_CLK_DEFAULT_CONFIG(RATE),
        .slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .clk = PIN_CLK,
            .din = PIN_DATA,
        },
    };
    ESP_ERROR_CHECK(i2s_channel_init_pdm_rx_mode(rx, &pdm));
    ESP_ERROR_CHECK(i2s_channel_enable(rx));
    printf("MIC SPM1423 PDM on I2S0 @ %d Hz, 16 bit, CLK=GPIO%d DATA=GPIO%d\n", RATE, PIN_CLK, PIN_DATA);

    for (int blk = 0;; blk++) {
        size_t got = 0;
        ESP_ERROR_CHECK(i2s_channel_read(rx, raw, sizeof(raw), &got, portMAX_DELAY));
        int n = got / sizeof(int16_t);
        // Classic ESP32 PDM RX leaves rx_msb_right = 0, so the FIFO hands over each sample pair swapped (M5Unified
        // fixes it the same way); put them back in time order
        for (int i = 0; i + 1 < n; i += 2) {
            int16_t t = raw[i];
            raw[i] = raw[i + 1];
            raw[i + 1] = t;
        }
        double sum = 0, mean = 0;
        for (int i = 0; i < n; i++) mean += raw[i];
        mean /= n;
        float first = -1, last = -1, prev = 0;
        int ups = 0;
        for (int i = 0; i < n; i++) {
            float x = (float)((raw[i] - mean) / 32768.0);
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
        // The first block holds blank samples from before DMA started, so print from the second
        if (blk >= 1 && blk % 4 == 1) printf("MIC rms=%.4f freq=%.1f Hz\n", rms, freq);
        if (blk == 9) printf("TRYBOARD_OK esp32-pdm-mic\n");
    }
}
