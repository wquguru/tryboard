// F-10a2: classic ESP32 "Cheap Yellow Display" (ESP32-2432S028) acceptance, IDF esp_lcd + espressif/esp_lcd_ili9341.
// Panel on HSPI (SCLK=14 MOSI=13 CS=15 DC=2, reset tied to EN, BL=21); TN glass: BGR, no inversion. Pattern in bare_tft.h.
#include "esp_lcd_ili9341.h"
#define TFT_NEW_PANEL esp_lcd_new_panel_ili9341
#define TFT_BGR 1
#define TFT_INVERT false
#include "bare_tft.h"

void app_main(void)
{
    tft_init();
    printf("CYD ILI9341 240x320 init OK (" TFT_HOST_NAME ", DMA, SCLK=%d MOSI=%d CS=%d DC=%d RST=%d BL=%d)\n", TFT_SCLK,
           TFT_MOSI, TFT_CS, TFT_DC, TFT_RST, TFT_BL);
    int n = tft_draw_pattern();
    printf("pattern drawn in %d chunks of %d rows\n", n, TFT_CHUNK);
    printf("TRYBOARD_OK esp32-cyd\n");
}
