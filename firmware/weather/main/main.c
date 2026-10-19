// Desk weather station (S3): SSD1306@0x3C + BME280@0x76 on I2C 8/9, servo dial GPIO4, WS2812 GPIO48 by temp, BOOT toggles °C/°F,
// buzzer GPIO5 alarms at ≥30 °C (ALARM ON / OFF, 1 °C hysteresis); serial line per reading: T=23.50 C H=45.0 % P=1013.25 hPa ...
#include <stdio.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/i2c_master.h"
#include "driver/ledc.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "led_strip.h"
#include "ssd1306_mini.h"
#include "bme280_calc.h"

#define PIN_SDA 8
#define PIN_SCL 9
#define SERVO_GPIO 4
#define LED_GPIO 48
#define BTN_GPIO 0
#define BUZZER_GPIO 5
#define BUZZER_HZ 2700
#define ALARM_ON_T 3000
#define ALARM_OFF_T 2900
#define OLED_ADDR 0x3C
#define BME_ADDR 0x76
#define PERIOD_MS 500
// The onboard LED is close to your eyes; full brightness glares
#define LED_LEVEL 0x20

static i2c_master_bus_handle_t bus;
static i2c_master_dev_handle_t bme;
static led_strip_handle_t strip;
static QueueHandle_t btn_q;

static esp_err_t rd(uint8_t reg, uint8_t *buf, size_t n)
{
    return i2c_master_transmit_receive(bme, &reg, 1, buf, n, 100);
}

static esp_err_t wr(uint8_t reg, uint8_t v)
{
    uint8_t b[2] = {reg, v};
    return i2c_master_transmit(bme, b, 2, 100);
}

static void IRAM_ATTR on_press(void *arg)
{
    int64_t t = esp_timer_get_time();
    xQueueSendFromISR(btn_q, &t, NULL);
}

// Temperature (0.01 °C) → servo pulse: 0–40 °C maps linearly to 0.5–2.5ms, clamped
static uint32_t temp_to_us(int32_t t)
{
    if (t < 0) t = 0;
    if (t > 4000) t = 4000;
    return 500 + (uint32_t)t / 2;
}

static void servo_init(uint32_t us)
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
        .duty = us * (1 << 14) / 20000,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&ch));
}

static void servo_set(uint32_t us)
{
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, us * (1 << 14) / 20000);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

// Buzzer configured only on first alarm, so without an alarm behaviour matches the no-buzzer build (level 06 fingerprint unchanged)
static volatile int alarm_on;

static void buzzer_duty(uint32_t d)
{
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1, d);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1);
}

static void alarm_task(void *arg)
{
    ledc_timer_config_t tc = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_10_BIT,
        .timer_num = LEDC_TIMER_1,
        .freq_hz = BUZZER_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&tc));
    ledc_channel_config_t ch = {
        .gpio_num = BUZZER_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_1,
        .timer_sel = LEDC_TIMER_1,
        .duty = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&ch));
    // A passive buzzer needs a square wave: 50% duty is loudest, 0 is silent
    for (int beep = 1;; beep = !beep) {
        buzzer_duty(alarm_on && beep ? 512 : 0);
        if (!alarm_on) beep = 0;
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}

// Degree sign: not in the font, so draw a 3x3 ring
static void degree(int x, int y, int s)
{
    for (int i = 0; i < 3 * s; i++) {
        px(x + i, y, 1);
        px(x + i, y + 3 * s - 1, 1);
        px(x, y + i, 1);
        px(x + 3 * s - 1, y + i, 1);
    }
}

static void draw(int32_t t, uint32_t hh, uint32_t p, int fahrenheit)
{
    memset(fb, 0, sizeof fb);
    char s[32];
    // First row: large temperature (1 decimal, rounded)
    int32_t v = fahrenheit ? t * 9 / 5 + 3200 : t;
    int32_t a = v < 0 ? -v : v;
    a = (a + 5) / 10;
    snprintf(s, sizeof s, "%s%" PRId32 ".%" PRId32, v < 0 ? "-" : "", a / 10, a % 10);
    int n = strlen(s);
    int w = n * 18 + 8 + 18;
    int x = (128 - w) / 2;
    if (x < 0) x = 0;
    text(x, 4, s, 3);
    degree(x + n * 18 + 1, 4, 2);
    text(x + n * 18 + 8, 4, fahrenheit ? "F" : "C", 3);
    // Second row: humidity + pressure (rounded)
    snprintf(s, sizeof s, "%" PRIu32 "%% %" PRIu32 "hPa", (hh + 512) / 1024, (p + 12800) / 25600);
    text((128 - (int)strlen(s) * 6) / 2, 34, s, 1);
    // Bottom bar: 0–40 °C pointer, matching the servo dial
    rect(4, 50, 120, 10, 0);
    int32_t c = t < 0 ? 0 : t > 4000 ? 4000 : t;
    rect(6, 52, 116 * c / 4000, 6, 1);
    ESP_ERROR_CHECK(flush());
}

void app_main(void)
{
    i2c_master_bus_config_t bc = {
        .i2c_port = 0,
        .sda_io_num = PIN_SDA,
        .scl_io_num = PIN_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&bc, &bus));
    printf("I2C scan (SDA=GPIO%d, SCL=GPIO%d):", PIN_SDA, PIN_SCL);
    for (int a = 0x08; a < 0x78; a++)
        if (i2c_master_probe(bus, a, 50) == ESP_OK) printf(" 0x%02X", a);
    printf("\n");

    i2c_device_config_t od = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = OLED_ADDR, .scl_speed_hz = 400000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &od, &oled));
    i2c_device_config_t bd = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = BME_ADDR, .scl_speed_hz = 400000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &bd, &bme));

    ESP_ERROR_CHECK(ssd1306_init());
    printf("SSD1306 init OK\n");
    uint8_t id = 0;
    ESP_ERROR_CHECK(rd(0xD0, &id, 1));
    printf("BME280 chip id 0x%02X %s\n", id, id == 0x60 ? "OK" : "(unexpected)");
    uint8_t c[26], h[7];
    ESP_ERROR_CHECK(rd(0x88, c, 26));
    ESP_ERROR_CHECK(rd(0xE1, h, 7));
    bme280_parse_calib(c, h);
    // Humidity x1; temperature x1, pressure x1, normal mode; standby 125ms, filter off
    ESP_ERROR_CHECK(wr(0xF2, 0x01));
    ESP_ERROR_CHECK(wr(0xF5, 0x40));
    ESP_ERROR_CHECK(wr(0xF4, 0x27));

    led_strip_config_t sc = {
        .strip_gpio_num = LED_GPIO,
        .max_leds = 1,
        .led_model = LED_MODEL_WS2812,
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
    };
    led_strip_rmt_config_t rc = {.clk_src = RMT_CLK_SRC_DEFAULT, .resolution_hz = 10 * 1000 * 1000};
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&sc, &rc, &strip));

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

    // The first normal-mode conversion takes ~10ms before data is ready
    vTaskDelay(pdMS_TO_TICKS(50));
    int fahrenheit = 0, servo_on = 0;
    int64_t last_press = -1000000;
    int32_t t = 0;
    uint32_t hh = 0, p = 0;
    for (int n = 0;; n++) {
        uint8_t d[8];
        ESP_ERROR_CHECK(rd(0xF7, d, 8));
        t = comp_t((d[3] << 12) | (d[4] << 4) | (d[5] >> 4));
        p = comp_p((d[0] << 12) | (d[1] << 4) | (d[2] >> 4));
        hh = comp_h((d[6] << 8) | d[7]);

        const char *name = t < 1800 ? "blue" : t < 2800 ? "green" : "red";
        uint8_t r = 0, g = 0, b = 0;
        if (t < 1800) b = LED_LEVEL;
        else if (t < 2800) g = LED_LEVEL;
        else r = LED_LEVEL;
        led_strip_set_pixel(strip, 0, r, g, b);
        led_strip_refresh(strip);

        uint32_t us = temp_to_us(t);
        if (!servo_on) {
            servo_init(us);
            servo_on = 1;
        } else {
            servo_set(us);
        }
        draw(t, hh, p, fahrenheit);

        uint32_t h10 = (hh * 10 + 512) / 1024;
        printf("T=%s%" PRId32 ".%02" PRId32 " C H=%" PRIu32 ".%" PRIu32 " %% P=%" PRIu32 ".%02" PRIu32 " hPa LED=%s PWM=%" PRIu32 "us\n",
               t < 0 && t > -100 ? "-" : "", t / 100, (t < 0 ? -t : t) % 100, h10 / 10, h10 % 10, p / 25600,
               (p % 25600) * 100 / 25600, name, us);
        if (n == 0) printf("TRYBOARD_OK weather\n");

        int want = alarm_on ? t >= ALARM_OFF_T : t >= ALARM_ON_T;
        if (want != alarm_on) {
            static int started;
            alarm_on = want;
            printf("ALARM %s\n", want ? "ON" : "OFF");
            if (!started) {
                started = 1;
                xTaskCreate(alarm_task, "alarm", 3072, NULL, 5, NULL);
            }
        }

        // Wait for the next reading while handling BOOT (50ms debounce)
        TickType_t until = xTaskGetTickCount() + pdMS_TO_TICKS(PERIOD_MS);
        for (;;) {
            TickType_t now = xTaskGetTickCount();
            if ((int32_t)(until - now) <= 0) break;
            int64_t ts;
            if (xQueueReceive(btn_q, &ts, until - now) != pdTRUE) break;
            if (ts - last_press < 50000) continue;
            last_press = ts;
            fahrenheit = !fahrenheit;
            printf("UNIT %s\n", fahrenheit ? "F" : "C");
            draw(t, hh, p, fahrenheit);
        }
    }
}
