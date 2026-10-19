// Tilt buddy (P2-09) reference, STAGE 1 prints pitch / roll every 100 ms, 2 draws "Xiaodou" centred, 3 slides it downhill along the rim.
// Wiring (S3): QMI8658 SDA=GPIO8 SCL=GPIO9 (0x6B); round LCD on SPI2, see firmware/common/round_lcd.h.
#include <stdio.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#ifndef STAGE
#define STAGE 3
#endif
#if STAGE >= 2
#include "round_lcd.h"
#endif

static i2c_master_dev_handle_t imu;

static void wr(uint8_t reg, uint8_t v)
{
    uint8_t b[2] = {reg, v};
    ESP_ERROR_CHECK(i2c_master_transmit(imu, b, 2, 100));
}

static void imu_init(void)
{
    i2c_master_bus_handle_t bus;
    i2c_master_bus_config_t bc = {
        .i2c_port = 0,
        .sda_io_num = 8,
        .scl_io_num = 9,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&bc, &bus));
    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = 0x6B, .scl_speed_hz = 400000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &imu));
    uint8_t reg = 0x00, id = 0;
    ESP_ERROR_CHECK(i2c_master_transmit_receive(imu, &reg, 1, &id, 1, 100));
    printf("QMI8658 WHO_AM_I 0x%02X\n", id);
    wr(0x60, 0xB0); // soft reset
    vTaskDelay(pdMS_TO_TICKS(20));
    wr(0x02, 0x40); // CTRL1: address auto-increment (otherwise burst reads repeat one register)
    wr(0x03, 0x15); // CTRL2: ±4 g
    wr(0x08, 0x01); // CTRL7: accelerometer only
    vTaskDelay(pdMS_TO_TICKS(30));
}

// Pitch / roll (degrees) from gravity: roll = atan2(ay, az), pitch = atan2(-ax, √(ay²+az²))
static void pose(float *pitch, float *roll)
{
    uint8_t reg = 0x35, d[6];
    ESP_ERROR_CHECK(i2c_master_transmit_receive(imu, &reg, 1, d, 6, 100));
    float a[3];
    for (int i = 0; i < 3; i++) a[i] = (int16_t)(d[2 * i] | d[2 * i + 1] << 8) / 8192.0f;
    *roll = atan2f(a[1], a[2]) * 57.29578f;
    *pitch = atan2f(-a[0], sqrtf(a[1] * a[1] + a[2] * a[2])) * 57.29578f;
}

#if STAGE >= 2
#define BG 0x10213A
#define RING 0x3A5A80
#define BODY 0xFFC933
#define VISOR 0x141414
#define EYE 0x7CF5FF
#define BODY_R 28
// Max 82 px from centre: the body (radius 28) stays just inside the track ring (radius 108–112)
#define MAX_OFF 82

static uint16_t c_bg, c_ring, c_body, c_visor, c_eye;

// Background + track ring, rows [y0, y1) only
static void draw_bg(int y0, int y1)
{
    for (int y = y0; y < y1; y++)
        for (int x = 0; x < LCD_W; x++) {
            int dx = x - 120, dy = y - 120, d2 = dx * dx + dy * dy;
            lcd_fb[y * LCD_W + x] = d2 >= 108 * 108 && d2 <= 112 * 112 ? c_ring : c_bg;
        }
}

// Xiaodou: yellow round body, dark rounded visor, two cyan eyes, dark smile
static void draw_bean(int x, int y)
{
    fb_circle(x, y, BODY_R, c_body);
    fb_rrect(x - 20, y - 15, 40, 18, 9, c_visor);
    fb_rrect(x - 13, y - 12, 8, 12, 4, c_eye);
    fb_rrect(x + 5, y - 12, 8, 12, 4, c_eye);
    fb_arc(x, y + 9, 8, 3, 0, c_visor);
}
#endif

void app_main(void)
{
    imu_init();
#if STAGE == 1
    for (int n = 0;; n++) {
        float p, r;
        pose(&p, &r);
        printf("POSE pitch=%.1f roll=%.1f\n", p, r);
        vTaskDelay(pdMS_TO_TICKS(100));
    }
#else
    c_bg = rgb(BG), c_ring = rgb(RING), c_body = rgb(BODY), c_visor = rgb(VISOR), c_eye = rgb(EYE);
    lcd_init();
    draw_bg(0, LCD_H);
    draw_bean(120, 120);
    lcd_flush_rows(0, LCD_H);
    printf("BEAN at 120,120\n");
    printf("TRYBOARD_OK tilt\n");
#if STAGE == 2
    for (;;) vTaskDelay(portMAX_DELAY);
#else
    float x = 120, y = 120, vx = 0, vy = 0;
    int ox = 120, oy = 120, touching = 0;
    for (int n = 1;; n++) {
        float p, r;
        pose(&p, &r);
        // Every 20 ms: velocity += tilt × 0.03 (px / frame), then × 0.9 damping; roll > 0 goes right, pitch > 0 goes down
        vx = (vx + r * 0.03f) * 0.9f;
        vy = (vy + p * 0.03f) * 0.9f;
        x += vx;
        y += vy;
        float dx = x - 120, dy = y - 120, d = sqrtf(dx * dx + dy * dy);
        int edge = 0;
        if (d > MAX_OFF) {
            // Pull back onto the circle and drop the outward velocity component: slide along the rim
            x = 120 + dx * MAX_OFF / d;
            y = 120 + dy * MAX_OFF / d;
            float vn = (vx * dx + vy * dy) / d;
            if (vn > 0) {
                vx -= vn * dx / d;
                vy -= vn * dy / d;
            }
            edge = 1;
        }
        if (edge && !touching) printf("EDGE x=%d y=%d\n", (int)lroundf(x), (int)lroundf(y));
        touching = edge;
        int nx = (int)lroundf(x), ny = (int)lroundf(y);
        if (nx != ox || ny != oy) {
            // Redraw only the rows covered by the old and new positions
            int y0 = (oy < ny ? oy : ny) - BODY_R - 1, y1 = (oy > ny ? oy : ny) + BODY_R + 2;
            if (y0 < 0) y0 = 0;
            if (y1 > LCD_H) y1 = LCD_H;
            draw_bg(y0, y1);
            draw_bean(nx, ny);
            lcd_flush_rows(y0, y1);
            ox = nx, oy = ny;
        }
        if (n % 10 == 0) printf("POS x=%d y=%d pitch=%.1f roll=%.1f\n", nx, ny, p, r);
        vTaskDelay(pdMS_TO_TICKS(20));
    }
#endif
#endif
}
