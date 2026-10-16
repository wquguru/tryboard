// 检查点 lens-1「眼睛 + 眨眼」参考固件（ESP32-S3 + GC9A01 圆屏）：黑底一对青色圆角矩形眼睛、白色高光、粉色腮红，
// 画好后每 3 秒眨一次眼（6 帧、每帧 30ms），眨完打印 BLINK <次数>。
// 下一个检查点 lens-2 加按键换表情，07-lens 合成四种表情循环。接线见 firmware/common/round_lcd.h。
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "round_lcd.h"

#define BLINK_PERIOD_MS 3000

static uint16_t C_BG, C_EYE, C_HI, C_CHEEK;

// openness：0..100，眨眼时的睁开程度
static void draw_face(int openness)
{
    fb_clear(C_BG);
    const int ex[2] = {120 - 48, 120 + 48};
    const int ew = 52, eh = 84, ey = 112;
    for (int i = 0; i < 2; i++) {
        int x0 = ex[i] - ew / 2;
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
    lcd_flush_rows(0, LCD_H);
}

void app_main(void)
{
    C_BG = rgb(0x000000);
    C_EYE = rgb(0x7CF5FF);
    C_HI = rgb(0xFFFFFF);
    C_CHEEK = rgb(0xFF8FB8);
    lcd_init();
    draw_face(100);
    printf("TRYBOARD_OK lens-blink\n");
    int blinks = 0;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(BLINK_PERIOD_MS));
        static const int seq[] = {60, 25, 5, 25, 60, 100};
        for (int i = 0; i < 6; i++) {
            draw_face(seq[i]);
            vTaskDelay(pdMS_TO_TICKS(30));
        }
        printf("BLINK %d\n", ++blinks);
    }
}
