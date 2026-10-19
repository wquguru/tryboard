// Checkpoint spin-1 "draw the face" reference (S3 + GC9A01): Xiaohuang's face once, eyes front.
// spin-2 adds the servo, 07-spin adds eye tracking and the BOOT turn-back. Wiring in round_lcd.h.
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
    // Dark visor with two cyan rounded-rect eyes, each with a white highlight; a dark smile below
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
