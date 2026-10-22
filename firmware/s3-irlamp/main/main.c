// IR remote night light (G-04) reference firmware for checkpoints irlamp-1..4, ESP32-S3. Receiver OUT (VS1838B class, active low) on GPIO4,
// 8 x WS2812 DIN on GPIO5 via 74AHCT125 to 5 V (same strip as the knob lamp). NEC decoding after esp32-ir; strip driving after lamp. (lint: allow-long-comment)
// Common 21-key "Car MP3" NEC remote, address 0x00 (command byte, inverse sent after it):
//   CH- 45  CH 46  CH+ 47 | prev 44  next 40  play 43 | VOL- 07  VOL+ 15  EQ 09 | 0 16  100+ 19  200+ 0D
//   1 0C  2 18  3 5E | 4 08  5 1C  6 5A | 7 42  8 52  9 4A   (0x45 is the power key on the variant that labels it so)
// Keys: 1-9 pick a colour, VOL+ / VOL- step brightness 1..8, 0x45 toggles on / off, a repeat code repeats VOL+ / VOL- (hold to ramp).
#include <stdbool.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/rmt_tx.h"
#include "driver/rmt_rx.h"

#define IR_GPIO 4
#define STRIP_GPIO 5
#define N_LED 8
#define MARGIN 200
#define KEY_POWER 0x45
#define KEY_UP 0x15
#define KEY_DOWN 0x07

static const uint8_t DIGIT_KEYS[9] = {0x0C, 0x18, 0x5E, 0x08, 0x1C, 0x5A, 0x42, 0x52, 0x4A};
static const uint32_t COLORS[9] = {0xFF2020, 0x20FF40, 0x2040FF, 0xFFC000, 0x00E0FF, 0xC040FF, 0xFF60A0, 0xFF9933, 0xFFFFFF};
static const char *NAMES[9] = {"红", "绿", "蓝", "黄", "青", "紫", "粉", "暖白", "白"};

static rmt_channel_handle_t tx;
static rmt_encoder_handle_t enc;
static uint8_t grb[N_LED * 3];

static void strip_init(void)
{
    rmt_tx_channel_config_t cfg = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .gpio_num = STRIP_GPIO,
        .mem_block_symbols = 48,
        .resolution_hz = 10 * 1000 * 1000,
        .trans_queue_depth = 4,
    };
    ESP_ERROR_CHECK(rmt_new_tx_channel(&cfg, &tx));
    rmt_bytes_encoder_config_t bc = {
        .bit0 = {.level0 = 1, .duration0 = 3, .level1 = 0, .duration1 = 9},
        .bit1 = {.level0 = 1, .duration0 = 9, .level1 = 0, .duration1 = 3},
        .flags.msb_first = 1,
    };
    ESP_ERROR_CHECK(rmt_new_bytes_encoder(&bc, &enc));
    ESP_ERROR_CHECK(rmt_enable(tx));
}

// All 8 LEDs the same colour, each channel = value x level / 8 (integer division); off = all zero
static void strip_show(uint32_t rgb, int level, bool on)
{
    uint32_t r = on ? ((rgb >> 16) & 0xFF) * level / 8 : 0;
    uint32_t g = on ? ((rgb >> 8) & 0xFF) * level / 8 : 0;
    uint32_t b = on ? (rgb & 0xFF) * level / 8 : 0;
    for (int i = 0; i < N_LED; i++) {
        grb[i * 3] = g;
        grb[i * 3 + 1] = r;
        grb[i * 3 + 2] = b;
    }
    rmt_transmit_config_t tc = {.loop_count = 0};
    ESP_ERROR_CHECK(rmt_transmit(tx, enc, grb, sizeof(grb), &tc));
    ESP_ERROR_CHECK(rmt_tx_wait_all_done(tx, 100));
    // Estimate: 1 mA idle per LED + 20 mA per channel at 255, from the frame just sent (not measured)
    printf("电流估算 %lu mA\n", (unsigned long)(N_LED + N_LED * (r + g + b) * 20 / 255));
    vTaskDelay(1);
}

static bool in_range(uint32_t d, uint32_t spec)
{
    return d < spec + MARGIN && d > spec - MARGIN;
}

// 34 symbols at 1 MHz (receiver output inverted by the RMT idle level): lead 9000 / 4500, 32 bits LSB first, stop
static bool parse_frame(const rmt_symbol_word_t *s, uint32_t *bits)
{
    if (!in_range(s[0].duration0, 9000) || !in_range(s[0].duration1, 4500)) {
        return false;
    }
    uint32_t v = 0;
    for (int i = 0; i < 32; i++) {
        const rmt_symbol_word_t *b = &s[1 + i];
        if (!in_range(b->duration0, 560)) {
            return false;
        }
        if (in_range(b->duration1, 1690)) {
            v |= 1u << i;
        } else if (!in_range(b->duration1, 560)) {
            return false;
        }
    }
    *bits = v;
    return true;
}

static bool rx_done(rmt_channel_handle_t ch, const rmt_rx_done_event_data_t *ed, void *arg)
{
    BaseType_t wake = pdFALSE;
    xQueueSendFromISR((QueueHandle_t)arg, ed, &wake);
    return wake == pdTRUE;
}

static int color = 7, level = 4;
static bool on = true;

// One key press (or its repeat); returns true when the strip changed
static bool handle_key(uint8_t cmd, bool repeat)
{
    if (cmd == KEY_POWER) {
        if (repeat) {
            return false;
        }
        on = !on;
        printf(on ? "开灯\n" : "关灯\n");
        return true;
    }
    if (!on) {
        printf("关灯中 忽略\n");
        return false;
    }
    if (cmd == KEY_UP || cmd == KEY_DOWN) {
        int nl = level + (cmd == KEY_UP ? 1 : -1);
        if (nl < 1 || nl > 8) {
            return false;
        }
        level = nl;
        printf("亮度 %d/8\n", level);
        return true;
    }
    if (repeat) {
        return false;
    }
    for (int i = 0; i < 9; i++) {
        if (DIGIT_KEYS[i] == cmd) {
            color = i;
            printf("颜色 %d %s\n", i + 1, NAMES[i]);
            return true;
        }
    }
    return false;
}

void app_main(void)
{
    strip_init();
    rmt_channel_handle_t rx = NULL;
    rmt_rx_channel_config_t rx_cfg = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 1000000,
        .mem_block_symbols = 48,
        .gpio_num = IR_GPIO,
    };
    ESP_ERROR_CHECK(rmt_new_rx_channel(&rx_cfg, &rx));
    QueueHandle_t q = xQueueCreate(2, sizeof(rmt_rx_done_event_data_t));
    rmt_rx_event_callbacks_t cbs = {.on_recv_done = rx_done};
    ESP_ERROR_CHECK(rmt_rx_register_event_callbacks(rx, &cbs, q));
    ESP_ERROR_CHECK(rmt_enable(rx));
    rmt_receive_config_t rcv = {.signal_range_min_ns = 1250, .signal_range_max_ns = 12000000};

    printf("红外小夜灯 接收 GPIO%d 灯带 GPIO%d\n", IR_GPIO, STRIP_GPIO);
    printf("开灯 颜色 %d %s 亮度 %d/8\n", color + 1, NAMES[color], level);
    strip_show(COLORS[color], level, on);
    printf("TRYBOARD_OK s3-irlamp\n");

    static rmt_symbol_word_t syms[64];
    rmt_rx_done_event_data_t ed;
    int last_cmd = -1;
    ESP_ERROR_CHECK(rmt_receive(rx, syms, sizeof(syms), &rcv));
    for (;;) {
        if (xQueueReceive(q, &ed, portMAX_DELAY) != pdPASS) {
            continue;
        }
        uint32_t bits;
        bool changed = false;
        if (ed.num_symbols == 34 && parse_frame(ed.received_symbols, &bits)) {
            uint8_t a = bits, na = bits >> 8, c = bits >> 16, nc = bits >> 24;
            if ((uint8_t)~c != nc) {
                printf("收到 命令校验错 %08lX\n", (unsigned long)bits);
            } else if ((uint8_t)~a != na) {
                printf("收到 地址=%04X 命令=%02X 不是本灯遥控器\n", (unsigned)(bits & 0xFFFF), c);
                last_cmd = -1;
            } else {
                printf("收到 地址=%02X 命令=%02X\n", a, c);
                last_cmd = a == 0x00 ? c : -1;
                if (last_cmd >= 0) {
                    changed = handle_key(c, false);
                }
            }
        } else if (ed.num_symbols == 2 && in_range(ed.received_symbols[0].duration0, 9000) &&
                   in_range(ed.received_symbols[0].duration1, 2250)) {
            printf("收到 重复码\n");
            if (last_cmd >= 0) {
                changed = handle_key(last_cmd, true);
            }
        } else {
            printf("收到 未知帧 %u 个符号\n", (unsigned)ed.num_symbols);
        }
        ESP_ERROR_CHECK(rmt_receive(rx, syms, sizeof(syms), &rcv));
        if (changed) {
            strip_show(COLORS[color], level, on);
        }
    }
}
