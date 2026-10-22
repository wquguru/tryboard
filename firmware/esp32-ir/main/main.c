// Acceptance (F-10c): classic ESP32 RMT RX + TX 38 kHz NEC IR, after IDF's ir_nec_transceiver (CC0; ir_nec_encoder.c / .h copied unchanged).
// RX GPIO19 = receiver, TX GPIO18 = IR LED aimed at it: one frame at start comes back, then whatever the remote sends is decoded.
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/rmt_tx.h"
#include "driver/rmt_rx.h"
#include "ir_nec_encoder.h"

#define RES_HZ 1000000
#define TX_GPIO 18
#define RX_GPIO 19
#define MARGIN 200
#define SELF_ADDR 0x0440
#define SELF_CMD 0x3003

static bool in_range(uint32_t d, uint32_t spec)
{
    return d < spec + MARGIN && d > spec - MARGIN;
}

// 34 symbols: lead 9000 / 4500, 32 bits LSB first (address then command), stop
static bool parse_frame(const rmt_symbol_word_t *s, uint16_t *addr, uint16_t *cmd)
{
    if (!in_range(s[0].duration0, 9000) || !in_range(s[0].duration1, 4500)) {
        return false;
    }
    uint32_t bits = 0;
    for (int i = 0; i < 32; i++) {
        const rmt_symbol_word_t *b = &s[1 + i];
        if (!in_range(b->duration0, 560)) {
            return false;
        }
        if (in_range(b->duration1, 1690)) {
            bits |= 1u << i;
        } else if (!in_range(b->duration1, 560)) {
            return false;
        }
    }
    *addr = bits & 0xffff;
    *cmd = bits >> 16;
    return true;
}

static bool rx_done(rmt_channel_handle_t ch, const rmt_rx_done_event_data_t *ed, void *arg)
{
    BaseType_t wake = pdFALSE;
    xQueueSendFromISR((QueueHandle_t)arg, ed, &wake);
    return wake == pdTRUE;
}

void app_main(void)
{
    rmt_channel_handle_t rx = NULL, tx = NULL;
    rmt_rx_channel_config_t rx_cfg = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = RES_HZ,
        .mem_block_symbols = 64,
        .gpio_num = RX_GPIO,
    };
    ESP_ERROR_CHECK(rmt_new_rx_channel(&rx_cfg, &rx));
    QueueHandle_t q = xQueueCreate(1, sizeof(rmt_rx_done_event_data_t));
    rmt_rx_event_callbacks_t cbs = {.on_recv_done = rx_done};
    ESP_ERROR_CHECK(rmt_rx_register_event_callbacks(rx, &cbs, q));
    rmt_receive_config_t rcv = {.signal_range_min_ns = 1250, .signal_range_max_ns = 12000000};

    rmt_tx_channel_config_t tx_cfg = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = RES_HZ,
        .mem_block_symbols = 64,
        .trans_queue_depth = 4,
        .gpio_num = TX_GPIO,
    };
    ESP_ERROR_CHECK(rmt_new_tx_channel(&tx_cfg, &tx));
    rmt_carrier_config_t car = {.duty_cycle = 0.33, .frequency_hz = 38000};
    ESP_ERROR_CHECK(rmt_apply_carrier(tx, &car));
    ir_nec_encoder_config_t enc_cfg = {.resolution = RES_HZ};
    rmt_encoder_handle_t enc = NULL;
    ESP_ERROR_CHECK(rmt_new_ir_nec_encoder(&enc_cfg, &enc));
    ESP_ERROR_CHECK(rmt_enable(tx));
    ESP_ERROR_CHECK(rmt_enable(rx));
    printf("IR 就绪 接收 GPIO%d 发射 GPIO%d 载波 38kHz\n", RX_GPIO, TX_GPIO);

    static rmt_symbol_word_t syms[64];
    rmt_rx_done_event_data_t ed;
    uint16_t last_addr = 0, last_cmd = 0;
    int self_seen = 0, remote = 0, repeats = 0;
    ESP_ERROR_CHECK(rmt_receive(rx, syms, sizeof(syms), &rcv));
    const ir_nec_scan_code_t code = {.address = SELF_ADDR, .command = SELF_CMD};
    rmt_transmit_config_t tcfg = {.loop_count = 0};
    ESP_ERROR_CHECK(rmt_transmit(tx, enc, &code, sizeof(code), &tcfg));
    printf("IR 发射 地址=%04X 命令=%04X\n", SELF_ADDR, SELF_CMD);
    // Keeps listening after the self-check so the web remote works at any time (F-08f)
    bool done = false;
    for (;;) {
        if (xQueueReceive(q, &ed, portMAX_DELAY) != pdPASS) {
            continue;
        }
        uint16_t a, c;
        if (ed.num_symbols == 34 && parse_frame(ed.received_symbols, &a, &c)) {
            last_addr = a;
            last_cmd = c;
            if (a == SELF_ADDR && c == SELF_CMD) {
                self_seen++;
                printf("IR 收到 自己发的 地址=%04X 命令=%04X\n", a, c);
            } else {
                remote++;
                printf("IR 收到 遥控器 地址=%04X 命令=%04X\n", a, c);
            }
        } else if (ed.num_symbols == 2 && in_range(ed.received_symbols[0].duration0, 9000) &&
                   in_range(ed.received_symbols[0].duration1, 2250)) {
            repeats++;
            printf("IR 收到 重复码 地址=%04X 命令=%04X\n", last_addr, last_cmd);
        } else {
            printf("IR 收到 未知帧 %u 个符号\n", (unsigned)ed.num_symbols);
        }
        if (!done && self_seen && remote >= 2 && repeats) {
            printf("IR 自发自收 %d 遥控 %d 重复 %d\n", self_seen, remote, repeats);
            printf("TRYBOARD_OK esp32-ir\n");
            done = true;
        }
        ESP_ERROR_CHECK(rmt_receive(rx, syms, sizeof(syms), &rcv));
    }
}
