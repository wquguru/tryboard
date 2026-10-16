// 成品："会转身的小黄"（ESP32-S3 + GC9A01 圆屏 + 舵机转台）。
// 舵机 GPIO4（LEDC 50Hz）以 90° 为中心在 ±60° 之间来回转，2 秒一个来回（脉宽 1.5 ± 0.667ms）；
// 圆屏画小黄的脸，眼珠朝转动方向看。按 BOOT（GPIO0）停在正面（90°）并打印 LOOK FRONT，再按一次继续转。
// 圆屏接线见 firmware/common/round_lcd.h。
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/ledc.h"
#include "esp_timer.h"
#include "round_lcd.h"

#define SERVO_GPIO 4
#define BTN_GPIO 0
#define STEP_MS 20
// 一个来回 2 秒 = 100 步；半程 50 步从 -60° 走到 +60°
#define HALF_STEPS 50
#define CENTER_US 1500
#define SWING_US 667 // 60° 对应的脉宽（0.5–2.5ms 映射 0–180°）
#define EYE_Y 104
#define EYE_DX 48
#define PUPIL_MAX 13
// 眼睛所在的行带：只重画这一段
#define BAND_Y0 (EYE_Y - 44)
#define BAND_Y1 (EYE_Y + 44)

static QueueHandle_t btn_q;
static uint16_t C_SKIN, C_STRAP, C_RIM, C_WHITE, C_IRIS, C_PUPIL, C_MOUTH;

static void IRAM_ATTR on_press(void *arg)
{
    int64_t t = esp_timer_get_time();
    xQueueSendFromISR(btn_q, &t, NULL);
}

static void servo_init(void)
{
    ledc_timer_config_t tc = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_14_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 50,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&tc));
    ledc_channel_config_t ch = {
        .gpio_num = SERVO_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .timer_sel = LEDC_TIMER_0,
        .duty = CENTER_US * (1 << 14) / 20000,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&ch));
}

static void servo_us(uint32_t us)
{
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, us * (1 << 14) / 20000);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

// 眼睛：护目镜灰框 + 眼白 + 棕色虹膜 + 黑瞳孔；look = 眼珠水平偏移（像素）
static void draw_eyes(int look)
{
    // 先把眼睛这条带子恢复成皮肤 + 护目镜带
    for (int y = BAND_Y0; y < BAND_Y1; y++)
        for (int x = 0; x < LCD_W; x++) fb_px(x, y, (y > EYE_Y - 12 && y < EYE_Y + 12) ? C_STRAP : C_SKIN);
    for (int i = -1; i <= 1; i += 2) {
        int cx = 120 + i * EYE_DX;
        fb_circle(cx, EYE_Y, 40, C_RIM);
        fb_circle(cx, EYE_Y, 31, C_WHITE);
        fb_circle(cx + look, EYE_Y + 2, 14, C_IRIS);
        fb_circle(cx + look, EYE_Y + 2, 7, C_PUPIL);
        fb_circle(cx + look - 5, EYE_Y - 4, 3, C_WHITE);
    }
}

static void draw_face(int look)
{
    fb_clear(C_SKIN);
    draw_eyes(look);
    fb_arc(120, 160, 34, 6, 0, C_MOUTH); // 笑嘴
    lcd_flush_rows(0, LCD_H);
}

void app_main(void)
{
    C_SKIN = rgb(0xFFD84A);
    C_STRAP = rgb(0x303030);
    C_RIM = rgb(0x9AA0A6);
    C_WHITE = rgb(0xFFFFFF);
    C_IRIS = rgb(0x7A4A20);
    C_PUPIL = rgb(0x101010);
    C_MOUTH = rgb(0x5A3A1A);
    lcd_init();
    servo_init();
    draw_face(0);

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
    printf("SERVO GPIO%d 50Hz, sweep %d..%d us; LCD GC9A01 SPI2\n", SERVO_GPIO, CENTER_US - SWING_US, CENTER_US + SWING_US);
    printf("TRYBOARD_OK spin\n");

    int front = 0, step = 0, look = 0;
    int64_t last_press = -1000000;
    TickType_t wake = xTaskGetTickCount();
    for (;;) {
        int64_t ts;
        while (xQueueReceive(btn_q, &ts, 0) == pdTRUE) {
            if (ts - last_press < 50000) continue; // 50ms 消抖
            last_press = ts;
            front = !front;
            printf(front ? "LOOK FRONT\n" : "LOOK AROUND\n");
        }
        int target;
        if (front) {
            servo_us(CENTER_US);
            target = 0;
        } else {
            // 三角波：前半程 -60° → +60°，后半程回来
            int k = step % (2 * HALF_STEPS);
            int off = k < HALF_STEPS ? -SWING_US + 2 * SWING_US * k / HALF_STEPS
                                     : SWING_US - 2 * SWING_US * (k - HALF_STEPS) / HALF_STEPS;
            servo_us(CENTER_US + off);
            if (k == 0) printf("SPIN -60\n");
            if (k == HALF_STEPS) printf("SPIN +60\n");
            // 眼珠朝转动方向看（脉宽变大 = 往 + 方向转）
            target = k < HALF_STEPS ? PUPIL_MAX : -PUPIL_MAX;
            step++;
        }
        // 眼珠每步最多挪 4 像素，转向时有个"扫一眼"的过渡
        int next = look + (target > look ? 4 : target < look ? -4 : 0);
        if ((target - look) * (target - next) < 0) next = target;
        if (next != look) {
            look = next;
            draw_eyes(look);
            lcd_flush_rows(BAND_Y0, BAND_Y1);
        }
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(STEP_MS));
    }
}
