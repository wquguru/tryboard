// ESP32-C3 + bare 2.4" / 2.8" ILI9341 240x320 module (SPI2 + GDMA) acceptance, IDF esp_lcd + espressif/esp_lcd_ili9341.
// TN panel: BGR subpixels, no inversion (as in the IDF spi_lcd_touch example). Pattern and wiring in firmware/common/bare_tft.h.
#include "esp_lcd_ili9341.h"
#define TFT_NEW_PANEL esp_lcd_new_panel_ili9341
#define TFT_BGR 1
#define TFT_INVERT false
#include "bare_tft.h"

void app_main(void)
{
    tft_init();
    printf("ILI9341 240x320 init OK (" TFT_HOST_NAME ", DMA, SCLK=%d MOSI=%d CS=%d DC=%d RST=%d BL=%d)\n", TFT_SCLK, TFT_MOSI,
           TFT_CS, TFT_DC, TFT_RST, TFT_BL);
    int n = tft_draw_pattern();
    printf("pattern drawn in %d chunks of %d rows\n", n, TFT_CHUNK);
    printf("TRYBOARD_OK c3-ili9341\n");
}
