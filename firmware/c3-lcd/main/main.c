// ESP32-C3 + GC9A01 圆屏（SPI2 + GDMA）验收固件：画一张测试图（四色扇区 + 白环 + 中心靶心），
// 然后让一个小球沿圆周走，每 50ms 只重画小球所在的行带（验证局部刷新 / 多次 DMA）。
// 接线（C3 DevKitM-1）：SCLK=GPIO6 MOSI=GPIO7 CS=GPIO10 DC=GPIO5 RST=GPIO4 背光=GPIO3，见 firmware/common/round_lcd.h。
#include <stdio.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "round_lcd.h"

static uint16_t C_R, C_G, C_B, C_Y, C_W, C_K;

static void background(void)
{
    // 四个扇区：右上红、左上绿、左下蓝、右下黄
    for (int y = 0; y < LCD_H; y++)
        for (int x = 0; x < LCD_W; x++) fb_px(x, y, y < 120 ? (x >= 120 ? C_R : C_G) : (x < 120 ? C_B : C_Y));
    fb_circle(120, 120, 70, C_W);
    fb_circle(120, 120, 60, C_K);
    fb_circle(120, 120, 20, C_W);
}

void app_main(void)
{
    C_R = rgb(0xFF3030);
    C_G = rgb(0x30FF30);
    C_B = rgb(0x3030FF);
    C_Y = rgb(0xFFE030);
    C_W = rgb(0xFFFFFF);
    C_K = rgb(0x000000);
    lcd_init();
    background();
    lcd_flush_rows(0, LCD_H);
    printf("LCD GC9A01 240x240 SPI2 (SCLK=%d MOSI=%d CS=%d DC=%d RST=%d BL=%d)\n", LCD_SCLK, LCD_MOSI, LCD_CS, LCD_DC,
           LCD_RST, LCD_BL);
    printf("TRYBOARD_OK c3-lcd\n");
    for (int i = 0;; i++) {
        float a = i * 0.2f;
        int cx = 120 + (int)(40 * cosf(a)), cy = 120 + (int)(40 * sinf(a));
        background();
        fb_circle(cx, cy, 8, C_W);
        lcd_flush_rows(cy - 10 < 0 ? 0 : cy - 10, cy + 10 > LCD_H ? LCD_H : cy + 10);
        // 上一帧小球所在行带也要刷掉：简单起见每 8 帧整屏刷一次
        if (i % 8 == 7) lcd_flush_rows(0, LCD_H);
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
