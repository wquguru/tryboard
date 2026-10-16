// 检查点 lens-2「按键换表情」参考固件（ESP32-S3 + GC9A01 圆屏）：在 lens-1 的眼睛 + 眨眼上加 BOOT 键，
// 每按一次在 normal（圆角矩形眼，会眨）和 happy（^ ^ 弯眼 + 笑嘴，不眨）之间切换，打印 MOOD <编号> <名字>。
// 07-lens 再加 love / sleepy 两种并循环。接线见 firmware/common/round_lcd.h。
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_timer.h"
#include "round_lcd.h"

#define BTN_GPIO 0
#define BLINK_PERIOD_MS 3000

static const char *MOOD_NAME[] = {"normal", "happy"};
static QueueHandle_t btn_q;
static uint16_t C_BG, C_EYE, C_HI, C_CHEEK;

static void IRAM_ATTR on_press(void *arg)
{
    int64_t t = esp_timer_get_time();
    xQueueSendFromISR(btn_q, &t, NULL);
}

static void draw_face(int mood, int openness)
{
    fb_clear(C_BG);
    const int ex[2] = {120 - 48, 120 + 48};
    const int ew = 52, eh = 84, ey = 112;
    for (int i = 0; i < 2; i++) {
        int x0 = ex[i] - ew / 2;
        if (mood == 1) {
            fb_arc(ex[i], ey + 10, 30, 12, 1, C_EYE); // ^ ^
            continue;
        }
        int h = eh * openness / 100;
        if (h < 8) h = 8;
        fb_rrect(x0, ey - h / 2, ew, h, 20, C_EYE);
        if (h > eh / 2) {
            fb_circle(x0 + 15, ey - h / 2 + 18, 9, C_HI);
            fb_circle(x0 + 34, ey - h / 2 + 34, 4, C_HI);
        }
    }
    fb_ellipse(120 - 78, 170, 18, 10, C_CHEEK);
    fb_ellipse(120 + 78, 170, 18, 10, C_CHEEK);
    if (mood == 1) fb_arc(120, 168, 18, 5, 0, C_EYE); // 笑嘴
    lcd_flush_rows(0, LCD_H);
}

void app_main(void)
{
    C_BG = rgb(0x000000);
    C_EYE = rgb(0x7CF5FF);
    C_HI = rgb(0xFFFFFF);
    C_CHEEK = rgb(0xFF8FB8);
    lcd_init();
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

    int mood = 0, blinks = 0;
    draw_face(mood, 100);
    printf("MOOD %d %s\n", mood, MOOD_NAME[mood]);
    printf("TRYBOARD_OK lens-mood\n");
    int64_t last_press = -1000000;
    TickType_t next_blink = xTaskGetTickCount() + pdMS_TO_TICKS(BLINK_PERIOD_MS);
    for (;;) {
        TickType_t now = xTaskGetTickCount();
        int64_t ts;
        if ((int32_t)(next_blink - now) > 0 && xQueueReceive(btn_q, &ts, next_blink - now) == pdTRUE) {
            if (ts - last_press < 30000) continue; // 30ms 消抖
            last_press = ts;
            mood = !mood;
            printf("MOOD %d %s\n", mood, MOOD_NAME[mood]);
            draw_face(mood, 100);
            continue;
        }
        if (mood == 0) {
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
