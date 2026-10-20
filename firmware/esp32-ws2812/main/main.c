// Acceptance (M5-11): classic ESP32 RMT TX driving 5 WS2812 on GPIO27 (M5 Atom Lite / Matrix data pin).
// 5 x 24 bits + reset = 121 symbols > one 64-word block, so the driver ping-pongs via TX_THR + global wrap.
// Own callback encoder (no managed led_strip component): byte -> 8 symbols, then a 50us low reset.
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/rmt_tx.h"
#include "driver/rmt_encoder.h"

#define LED_GPIO 27
#define N 5
#define RES_HZ (10 * 1000 * 1000)

static const rmt_symbol_word_t bit0 = {.level0 = 1, .duration0 = 3, .level1 = 0, .duration1 = 9};
static const rmt_symbol_word_t bit1 = {.level0 = 1, .duration0 = 9, .level1 = 0, .duration1 = 3};
static const rmt_symbol_word_t reset = {.level0 = 0, .duration0 = 250, .level1 = 0, .duration1 = 250};

static size_t encode(const void *data, size_t size, size_t written, size_t free,
                     rmt_symbol_word_t *sym, bool *done, void *arg)
{
    if (free < 8) {
        return 0;
    }
    size_t pos = written / 8;
    const uint8_t *b = data;
    if (pos < size) {
        for (int k = 0; k < 8; k++) {
            sym[k] = (b[pos] >> (7 - k)) & 1 ? bit1 : bit0;
        }
        return 8;
    }
    sym[0] = reset;
    *done = true;
    return 1;
}

// Frames in RGB; sent on the wire as GRB
static const uint8_t frames[2][N][3] = {
    {{255, 0, 0}, {0, 255, 0}, {0, 0, 255}, {255, 255, 255}, {16, 32, 48}},
    {{0, 0, 0}, {255, 128, 0}, {1, 2, 3}, {128, 0, 255}, {0, 64, 0}},
};

void app_main(void)
{
    rmt_channel_handle_t chan = NULL;
    rmt_tx_channel_config_t cfg = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .gpio_num = LED_GPIO,
        .mem_block_symbols = 64,
        .resolution_hz = RES_HZ,
        .trans_queue_depth = 4,
    };
    ESP_ERROR_CHECK(rmt_new_tx_channel(&cfg, &chan));
    rmt_encoder_handle_t enc = NULL;
    rmt_simple_encoder_config_t ecfg = {.callback = encode};
    ESP_ERROR_CHECK(rmt_new_simple_encoder(&ecfg, &enc));
    ESP_ERROR_CHECK(rmt_enable(chan));
    rmt_transmit_config_t tx = {.loop_count = 0};
    uint8_t grb[N * 3];
    for (int f = 0; f < 2; f++) {
        for (int i = 0; i < N; i++) {
            grb[i * 3 + 0] = frames[f][i][1];
            grb[i * 3 + 1] = frames[f][i][0];
            grb[i * 3 + 2] = frames[f][i][2];
        }
        ESP_ERROR_CHECK(rmt_transmit(chan, enc, grb, sizeof(grb), &tx));
        ESP_ERROR_CHECK(rmt_tx_wait_all_done(chan, 1000));
        printf("ws2812 frame %d\n", f);
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    printf("TRYBOARD_OK esp32-ws2812\n");
}
