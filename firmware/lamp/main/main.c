// 旋钮台灯（P2-09）参考固件，三个检查点共用：
//   STAGE 1 lamp-1「灯带点亮」：8 灯 WS2812 逐颗点亮成暖白（1/4 亮度）
//   STAGE 2 lamp-2「旋钮读数」：+ EC11 编码器接 PCNT，打印格数和按键次数
//   STAGE 3 lamp-3「合体」：旋钮调亮度 / 换颜色，按下切换模式
// 接线（ESP32-S3）：灯条 DIN=GPIO5（经 74AHCT125 升到 5 V），编码器 CLK=GPIO6、DT=GPIO7、SW=GPIO15（按下接地）。
// WS2812 不用 led_strip 组件：IDF 自带的 RMT TX + 字节编码器就够（10 MHz：0 码 0.3/0.9 µs、1 码 0.9/0.3 µs）。
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/rmt_tx.h"
#include "driver/pulse_cnt.h"

#ifndef STAGE
#define STAGE 3
#endif
#define STRIP_GPIO 5
#define N_LED 8
#define ENC_A 6
#define ENC_B 7
#define ENC_SW 15

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

// 送一帧（前 lit 颗是 rgb，其余灭），等发完再留出 > 280 µs 低电平当复位
static void strip_show(uint32_t rgb, int lit)
{
    for (int i = 0; i < N_LED; i++) {
        uint32_t c = i < lit ? rgb : 0;
        grb[i * 3] = (c >> 8) & 0xFF;
        grb[i * 3 + 1] = (c >> 16) & 0xFF;
        grb[i * 3 + 2] = c & 0xFF;
    }
    rmt_transmit_config_t tc = {.loop_count = 0};
    ESP_ERROR_CHECK(rmt_transmit(tx, enc, grb, sizeof(grb), &tc));
    ESP_ERROR_CHECK(rmt_tx_wait_all_done(tx, 100));
    vTaskDelay(1);
}

// 颜色按亮度缩放：每个通道 = 值 × k / 255（整数除法），任务书里写的就是这个公式
static uint32_t scale(uint32_t c, int k)
{
    uint32_t r = ((c >> 16) & 0xFF) * k / 255, g = ((c >> 8) & 0xFF) * k / 255, b = (c & 0xFF) * k / 255;
    return r << 16 | g << 8 | b;
}

#define WARM 0xFF9933

#if STAGE >= 2
static pcnt_unit_handle_t unit;

// 与 ESP-IDF 示例 peripherals/pcnt/rotary_encoder 相同：两个通道互为边沿 / 电平，4 倍频，顺时针计数增加
static void knob_init(void)
{
    pcnt_unit_config_t uc = {.high_limit = 100, .low_limit = -100, .flags.accum_count = 1};
    ESP_ERROR_CHECK(pcnt_new_unit(&uc, &unit));
    pcnt_glitch_filter_config_t f = {.max_glitch_ns = 1000};
    ESP_ERROR_CHECK(pcnt_unit_set_glitch_filter(unit, &f));
    pcnt_chan_config_t ac = {.edge_gpio_num = ENC_A, .level_gpio_num = ENC_B};
    pcnt_chan_config_t bcfg = {.edge_gpio_num = ENC_B, .level_gpio_num = ENC_A};
    pcnt_channel_handle_t ca, cb;
    ESP_ERROR_CHECK(pcnt_new_channel(unit, &ac, &ca));
    ESP_ERROR_CHECK(pcnt_new_channel(unit, &bcfg, &cb));
    ESP_ERROR_CHECK(pcnt_channel_set_edge_action(ca, PCNT_CHANNEL_EDGE_ACTION_DECREASE, PCNT_CHANNEL_EDGE_ACTION_INCREASE));
    ESP_ERROR_CHECK(pcnt_channel_set_level_action(ca, PCNT_CHANNEL_LEVEL_ACTION_KEEP, PCNT_CHANNEL_LEVEL_ACTION_INVERSE));
    ESP_ERROR_CHECK(pcnt_channel_set_edge_action(cb, PCNT_CHANNEL_EDGE_ACTION_INCREASE, PCNT_CHANNEL_EDGE_ACTION_DECREASE));
    ESP_ERROR_CHECK(pcnt_channel_set_level_action(cb, PCNT_CHANNEL_LEVEL_ACTION_KEEP, PCNT_CHANNEL_LEVEL_ACTION_INVERSE));
    ESP_ERROR_CHECK(pcnt_unit_add_watch_point(unit, 100));
    ESP_ERROR_CHECK(pcnt_unit_add_watch_point(unit, -100));
    ESP_ERROR_CHECK(pcnt_unit_enable(unit));
    ESP_ERROR_CHECK(pcnt_unit_clear_count(unit));
    ESP_ERROR_CHECK(pcnt_unit_start(unit));
    gpio_config_t sw = {.pin_bit_mask = 1ULL << ENC_SW, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE};
    gpio_config(&sw);
}

// 当前格数（一格 4 个计数；停在格上时计数是 4 的倍数）
static int knob_detents(void)
{
    int c = 0;
    pcnt_unit_get_count(unit, &c);
    return c / 4;
}
#endif

#if STAGE == 3
static const uint32_t COLORS[] = {0xFF9933, 0xFF2020, 0x20FF40, 0x2040FF, 0xC040FF, 0xFFFFFF};
static const char *NAMES[] = {"warm", "red", "green", "blue", "purple", "white"};
#define N_COLORS 6
#endif

void app_main(void)
{
    strip_init();
#if STAGE >= 2
    knob_init();
#endif
    // 上电逐颗点亮（每 60 ms 多亮一颗），亮度 64/255
    for (int i = 1; i <= N_LED; i++) {
        strip_show(scale(WARM, 64), i);
        vTaskDelay(pdMS_TO_TICKS(60));
    }
    printf("LAMP ON %d\n", N_LED);
#if STAGE == 1
    for (;;) vTaskDelay(portMAX_DELAY);
#else
    int last = 0, presses = 0, sw_reported = 1, sw_last = 1, sw_stable = 0;
#if STAGE == 3
    int level = 4, color = 0, mode = 0;
#endif
    for (;;) {
        int d = knob_detents();
        if (d != last) {
#if STAGE == 2
            printf("KNOB %d\n", d);
#else
            int step = d - last;
            if (mode == 0) {
                level += step;
                if (level < 1) level = 1;
                if (level > 8) level = 8;
                printf("LEVEL %d\n", level);
            } else {
                color = ((color + step) % N_COLORS + N_COLORS) % N_COLORS;
                printf("COLOR %d %s\n", color, NAMES[color]);
            }
            strip_show(scale(COLORS[color], level * 16), N_LED);
#endif
            last = d;
        }
        // 按键：连续 3 次（30 ms）读到同一电平才算
        int lv = gpio_get_level(ENC_SW);
        if (lv == sw_last) {
            if (++sw_stable == 3 && lv != sw_reported) {
                sw_reported = lv;
                if (lv == 0) {
#if STAGE == 2
                    printf("PRESS %d\n", ++presses);
#else
                    presses++;
                    mode ^= 1;
                    printf("MODE %s\n", mode ? "color" : "level");
#endif
                }
            }
        } else {
            sw_last = lv;
            sw_stable = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
#endif
}
