// F-10a2: classic ESP32 "Cheap Yellow Display" (ESP32-2432S028) acceptance, IDF esp_lcd + espressif/esp_lcd_ili9341.
// Panel on HSPI (SCLK=14 MOSI=13 CS=15 DC=2, reset tied to EN, BL=21); TN glass: BGR, no inversion. Pattern in bare_tft.h.
#include "esp_lcd_ili9341.h"
#define TFT_NEW_PANEL esp_lcd_new_panel_ili9341
#define TFT_BGR 1
#define TFT_INVERT false
#include "bare_tft.h"

// XPT2046 touch on its own VSPI bus (CYD schematic): CLK 25, DIN 32, DOUT 39, CS 33, PENIRQ 36 (input only, low = pressed)
#define T_CLK 25
#define T_MOSI 32
#define T_MISO 39
#define T_CS 33
#define T_IRQ 36
// Raw span of the panel edges, the usual CYD tutorial calibration (portrait 240x320)
#define RAW_X0 200
#define RAW_X1 3700
#define RAW_Y0 240
#define RAW_Y1 3800

static spi_device_handle_t touch;

static void touch_init(void)
{
    spi_bus_config_t bc = {
        .sclk_io_num = T_CLK,
        .mosi_io_num = T_MOSI,
        .miso_io_num = T_MISO,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(SPI3_HOST, &bc, SPI_DMA_DISABLED));
    spi_device_interface_config_t dc = {
        .mode = 0,
        .clock_speed_hz = 2 * 1000 * 1000,
        .spics_io_num = T_CS,
        .queue_size = 1,
    };
    ESP_ERROR_CHECK(spi_bus_add_device(SPI3_HOST, &dc, &touch));
    gpio_config_t irq = {.pin_bit_mask = 1ULL << T_IRQ, .mode = GPIO_MODE_INPUT};
    ESP_ERROR_CHECK(gpio_config(&irq));
}

// One full-duplex conversion: control byte, then BUSY + 12 result bits + 3 zero bits
static int touch_read(uint8_t cmd)
{
    spi_transaction_t t = {
        .flags = SPI_TRANS_USE_TXDATA | SPI_TRANS_USE_RXDATA,
        .length = 24,
        .tx_data = {cmd, 0, 0},
    };
    ESP_ERROR_CHECK(spi_device_polling_transmit(touch, &t));
    return ((t.rx_data[1] << 8) | t.rx_data[2]) >> 3;
}

void app_main(void)
{
    tft_init();
    printf("CYD ILI9341 240x320 init OK (" TFT_HOST_NAME ", DMA, SCLK=%d MOSI=%d CS=%d DC=%d RST=%d BL=%d)\n", TFT_SCLK,
           TFT_MOSI, TFT_CS, TFT_DC, TFT_RST, TFT_BL);
    int n = tft_draw_pattern();
    printf("pattern drawn in %d chunks of %d rows\n", n, TFT_CHUNK);
    printf("TRYBOARD_OK esp32-cyd\n");

    touch_init();
    int z_idle = touch_read(0xB0) + 4095 - touch_read(0xC0);
    printf("XPT2046 ready (VSPI, CS=%d IRQ=%d), idle pressure %d\n", T_CS, T_IRQ, z_idle);
    while (gpio_get_level(T_IRQ)) vTaskDelay(pdMS_TO_TICKS(10));
    int z = touch_read(0xB0) + 4095 - touch_read(0xC0);
    int rx = touch_read(0xD0), ry = touch_read(0x90);
    int x = (rx - RAW_X0) * (TFT_W - 1) / (RAW_X1 - RAW_X0);
    int y = (ry - RAW_Y0) * (TFT_H - 1) / (RAW_Y1 - RAW_Y0);
    printf("touch raw x=%d y=%d z=%d -> pixel %d,%d\n", rx, ry, z, x, y);
    while (!gpio_get_level(T_IRQ)) vTaskDelay(pdMS_TO_TICKS(10));
    printf("touch released, pressure %d\n", touch_read(0xB0) + 4095 - touch_read(0xC0));
    printf("TRYBOARD_OK esp32-cyd-touch\n");
}
