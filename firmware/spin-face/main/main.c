// 检查点 spin-1「画脸」参考固件（ESP32-S3 + GC9A01 圆屏）：画一次小黄的脸，眼睛正视前方。
// 后面两个检查点在这张脸上加舵机（spin-2）、再加眼珠跟随和按键回头（07-spin）。接线见 firmware/common/round_lcd.h。
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "round_lcd.h"

#define EYE_Y 104
#define EYE_DX 30

void app_main(void)
{
    uint16_t skin = rgb(0xFFC933), visor = rgb(0x141414), eye = rgb(0x7CF5FF), white = rgb(0xFFFFFF);
    lcd_init();
    fb_clear(skin);
    // 深色眼罩里两只青色圆角矩形眼睛，各带一个白色高光；下面一张深色笑嘴
    fb_rrect(120 - 74, EYE_Y - 44, 148, 88, 32, visor);
    for (int i = -1; i <= 1; i += 2) {
        int cx = 120 + i * EYE_DX;
        fb_rrect(cx - 14, EYE_Y - 28, 28, 56, 14, eye);
        fb_circle(cx - 4, EYE_Y - 16, 5, white);
    }
    fb_arc(120, 160, 34, 6, 0, visor);
    lcd_flush_rows(0, LCD_H);
    printf("FACE drawn: skin #FFC933, eyes #7CF5FF at x=90/150\n");
    printf("TRYBOARD_OK spin-face\n");
    for (;;) vTaskDelay(portMAX_DELAY);
}
