// Finished build: turning Xiaohuang (S3 + GC9A01 + servo GPIO4, 90° ±60°, 2 s cycle); eyes look the way it turns (EYE R / EYE L).
// BOOT (GPIO0) stops facing front and prints LOOK FRONT, press again to resume. Last of spin-1 → spin-2 → 07-spin.
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
// One cycle 2 s = 100 steps; half of 50 steps goes from -60° to +60°
#define HALF_STEPS 50
#define CENTER_US 1500
#define SWING_US 667 // pulse for 60° (0.5–2.5ms maps 0–180°)
#define EYE_Y 104
#define EYE_DX 30
#define PUPIL_MAX 13
// Rows covered by the visor (dark rounded rect): only this band is redrawn
#define BAND_Y0 (EYE_Y - 46)
#define BAND_Y1 (EYE_Y + 46)

static QueueHandle_t btn_q;
static uint16_t C_SKIN, C_VISOR, C_EYE, C_WHITE, C_MOUTH;

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

// Eyes: TryBoard's original "Xiaohuang", a dark visor holding two cyan rounded-rect eyes (no goggles, frame or strap).
// look = horizontal eye offset in pixels
static void draw_eyes(int look)
{
    for (int y = BAND_Y0; y < BAND_Y1; y++)
        for (int x = 0; x < LCD_W; x++) fb_px(x, y, C_SKIN);
    fb_rrect(120 - 74, EYE_Y - 44, 148, 88, 32, C_VISOR);
    for (int i = -1; i <= 1; i += 2) {
        int cx = 120 + i * EYE_DX + look;
        fb_rrect(cx - 14, EYE_Y - 28, 28, 56, 14, C_EYE);
        fb_circle(cx - 4, EYE_Y - 16, 5, C_WHITE);
    }
}

static void draw_face(int look)
{
    fb_clear(C_SKIN);
    draw_eyes(look);
    fb_arc(120, 160, 34, 6, 0, C_MOUTH); // smile
    lcd_flush_rows(0, LCD_H);
}

void app_main(void)
{
    C_SKIN = rgb(0xFFC933);
    C_VISOR = rgb(0x141414);
    C_EYE = rgb(0x7CF5FF);
    C_WHITE = rgb(0xFFFFFF);
    C_MOUTH = rgb(0x141414);
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
            if (ts - last_press < 50000) continue; // 50ms debounce
            last_press = ts;
            front = !front;
            printf(front ? "LOOK FRONT\n" : "LOOK AROUND\n");
        }
        int target;
        if (front) {
            servo_us(CENTER_US);
            target = 0;
        } else {
            // Triangle wave: first half -60° → +60°, second half back
            int k = step % (2 * HALF_STEPS);
            int off = k < HALF_STEPS ? -SWING_US + 2 * SWING_US * k / HALF_STEPS
                                     : SWING_US - 2 * SWING_US * (k - HALF_STEPS) / HALF_STEPS;
            servo_us(CENTER_US + off);
            if (k == 0) printf("SPIN -60\n");
            if (k == HALF_STEPS) printf("SPIN +60\n");
            // Eyes look the way it turns (wider pulse = turning in the + direction)
            target = k < HALF_STEPS ? PUPIL_MAX : -PUPIL_MAX;
            step++;
        }
        // Pupils move at most 4 px per step, giving a glance-over transition when it reverses
        int next = look + (target > look ? 4 : target < look ? -4 : 0);
        if ((target - look) * (target - next) < 0) next = target;
        if (next != look) {
            look = next;
            // Report once at far right / far left (checkpoint 07-spin judges eye tracking from serial)
            if (look == PUPIL_MAX) printf("EYE R\n");
            if (look == -PUPIL_MAX) printf("EYE L\n");
            draw_eyes(look);
            lcd_flush_rows(BAND_Y0, BAND_Y1);
        }
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(STEP_MS));
    }
}
