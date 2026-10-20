// ESP32-S3 + bare ST7789 IPS module (SPI2 + GDMA) acceptance with IDF's built-in esp_lcd_new_panel_st7789. One image for both
// common glasses: 240x320 (2.0" / 2.4") shows all four bands, 240x240 (1.3") the top three. IPS: inversion on, RGB subpixels. (lint: allow-long-comment)
#include "esp_lcd_panel_st7789.h"
#define TFT_NEW_PANEL esp_lcd_new_panel_st7789
#define TFT_BGR 0
#define TFT_INVERT true
#include "bare_tft.h"

void app_main(void)
{
    tft_init();
    printf("ST7789 240x320 init OK (" TFT_HOST_NAME ", DMA, SCLK=%d MOSI=%d CS=%d DC=%d RST=%d BL=%d)\n", TFT_SCLK, TFT_MOSI,
           TFT_CS, TFT_DC, TFT_RST, TFT_BL);
    int n = tft_draw_pattern();
    printf("pattern drawn in %d chunks of %d rows\n", n, TFT_CHUNK);
    printf("TRYBOARD_OK s3-st7789\n");
}
