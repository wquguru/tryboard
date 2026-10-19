// Checkpoint lens-1 "eyes + blink" reference (S3 + GC9A01): cyan rounded-rect eyes, white highlights, pink cheeks on black; blinks every 3 s
// (6 frames x 30ms), printing BLINK <count>. lens-2 adds a mood button, 07-lens cycles four moods. Wiring: firmware/common/round_lcd.h.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "round_lcd.h"

#define BLINK_PERIOD_MS 3000

static uint16_t C_BG, C_EYE, C_HI, C_CHEEK;

// openness: 0..100, how open the eyes are while blinking
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
