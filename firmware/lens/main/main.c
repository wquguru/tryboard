// 成品："透镜小人"（ESP32-S3 + GC9A01 240×240 圆屏）。
// 圆屏上一对卡通眼睛：青色圆角矩形眼 + 白色高光 + 粉色腮红，每 3 秒眨一次眼。
// BOOT 键（GPIO0）切换表情：平常 → 开心 → 喜欢 → 困了 → 平常，串口打印 "MOOD 1 happy" 这类。
// 接线见 firmware/common/round_lcd.h。
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_timer.h"
#include "round_lcd.h"

#define BTN_GPIO 0
#define BLINK_PERIOD_MS 3000

static const char *MOOD_NAME[] = {"normal", "happy", "love", "sleepy"};
static QueueHandle_t btn_q;

static void IRAM_ATTR on_press(void *arg)
{
    int64_t t = esp_timer_get_time();
    xQueueSendFromISR(btn_q, &t, NULL);
}

static uint16_t C_BG, C_EYE, C_HI, C_CHEEK, C_HEART;

// 心形：两个圆 + 下面收尖
static void heart(int cx, int cy, int s, uint16_t c)
{
    fb_circle(cx - s / 2, cy - s / 4, s / 2 + 1, c);
    fb_circle(cx + s / 2, cy - s / 4, s / 2 + 1, c);
    for (int j = 0; j <= s + s / 4; j++) {
        int half = s - j * s / (s + s / 4);
        for (int x = cx - half; x <= cx + half; x++) fb_px(x, cy - s / 4 + j, c);
    }
}

// openness：0..100，眨眼时的睁开程度
static void draw_face(int mood, int openness)
{
    fb_clear(C_BG);
    const int ex[2] = {120 - 48, 120 + 48};
    const int ew = 52, eh = 84, ey = 112; // 眼睛中心 y
    for (int i = 0; i < 2; i++) {
        int x0 = ex[i] - ew / 2;
        switch (mood) {
        case 1: // 开心：^ ^
            fb_arc(ex[i], ey + 10, 30, 12, 1, C_EYE);
            break;
        case 2: // 喜欢：心形眼
            heart(ex[i], ey, 30, C_HEART);
            fb_circle(ex[i] - 16, ey - 16, 6, C_HI);
            break;
        case 3: { // 困了：只睁开下面三分之一，上眼皮压着
            int h = eh / 3 * openness / 100;
            if (h < 6) h = 6;
            fb_rrect(x0, ey + eh / 2 - h - 10, ew, h, 8, C_EYE);
            break;
        }
        default: {
            int h = eh * openness / 100;
            if (h < 8) h = 8;
            fb_rrect(x0, ey - h / 2, ew, h, 20, C_EYE);
            // 高光：睁得够开才画
            if (h > eh / 2) {
                fb_circle(x0 + 15, ey - h / 2 + 18, 9, C_HI);
                fb_circle(x0 + 34, ey - h / 2 + 34, 4, C_HI);
            }
        }
        }
    }
    // 腮红
    fb_ellipse(120 - 78, 170, 18, 10, C_CHEEK);
    fb_ellipse(120 + 78, 170, 18, 10, C_CHEEK);
    if (mood == 1 || mood == 2) fb_arc(120, 168, 18, 5, 0, C_EYE); // 笑嘴
    if (mood == 3) {
        // 困了：右上角一个小 "z"
        for (int i = 0; i < 14; i++) {
            fb_px(160 + i, 50, C_HI);
            fb_px(160 + i, 51, C_HI);
            fb_px(160 + i, 64, C_HI);
            fb_px(160 + i, 65, C_HI);
            fb_px(173 - i, 51 + i, C_HI);
            fb_px(172 - i, 51 + i, C_HI);
        }
    }
    lcd_flush_rows(0, LCD_H);
}

void app_main(void)
{
    C_BG = rgb(0x000000);
    C_EYE = rgb(0x7CF5FF);
    C_HI = rgb(0xFFFFFF);
    C_CHEEK = rgb(0xFF8FB8);
    C_HEART = rgb(0xFF4F8B);
    lcd_init();
    printf("LCD GC9A01 240x240 SPI2 (SCLK=%d MOSI=%d CS=%d DC=%d RST=%d BL=%d)\n", LCD_SCLK, LCD_MOSI, LCD_CS, LCD_DC,
           LCD_RST, LCD_BL);

    btn_q = xQueueCreate(8, sizeof(int64_t));
    gpio_config_t btn = {
        .pin_bit_mask = 1ULL << BTN_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .intr_type = GPIO_INTR_NEGEDGE,
    };
    ESP_ERROR_CHECK(gpio_config(&btn));
    ESP_ERROR_CHECK(gpio_install_isr_service(0));
    ESP_ERROR_CHECK(gpio_isr_handler_add(BTN_GPIO, on_press, NULL));

    int mood = 0;
    draw_face(mood, 100);
    printf("MOOD %d %s\n", mood, MOOD_NAME[mood]);
    printf("TRYBOARD_OK lens\n");

    int64_t last_press = -1000000;
    TickType_t next_blink = xTaskGetTickCount() + pdMS_TO_TICKS(BLINK_PERIOD_MS);
    int blinks = 0;
    for (;;) {
        TickType_t now = xTaskGetTickCount();
        int64_t ts;
        if ((int32_t)(next_blink - now) > 0 && xQueueReceive(btn_q, &ts, next_blink - now) == pdTRUE) {
            if (ts - last_press < 50000) continue; // 50ms 消抖
            last_press = ts;
            mood = (mood + 1) % 4;
            printf("MOOD %d %s\n", mood, MOOD_NAME[mood]);
            draw_face(mood, 100);
            continue;
        }
        // 眨眼：闭上再睁开（开心 / 喜欢时眼睛是弯的，不眨）
        if (mood == 0 || mood == 3) {
            static const int seq[] = {60, 25, 5, 25, 60, 100};
            for (int i = 0; i < 6; i++) {
                draw_face(mood, seq[i]);
                vTaskDelay(pdMS_TO_TICKS(30));
            }
            printf("BLINK %d\n", ++blinks);
        }
        next_blink = xTaskGetTickCount() + pdMS_TO_TICKS(BLINK_PERIOD_MS);
    }
}
