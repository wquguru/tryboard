// E-01: CO5300 480x480 AMOLED over QSPI (Waveshare ESP32-S3-Touch-AMOLED-2.16 pins), drawn through esp_lcd + esp_lcd_co5300.
// Known pattern: red / green / blue quadrants plus a grey ramp bottom-right; prints a pixel checksum and the frame transfer time.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_co5300.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"

#define PIN_CS 12
#define PIN_CLK 38
#define PIN_D0 4
#define PIN_D1 5
#define PIN_D2 6
#define PIN_D3 7
#define PIN_RST 39
#define LCD_W 480
#define LCD_H 480
#define STRIP 40

static SemaphoreHandle_t done;

static bool on_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *e, void *ctx)
{
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(done, &woken);
    return woken == pdTRUE;
}

static uint16_t rgb565(int r, int g, int b)
{
    return (uint16_t)(((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3));
}

static uint16_t pattern(int x, int y)
{
    if (y < LCD_H / 2) return x < LCD_W / 2 ? rgb565(255, 0, 0) : rgb565(0, 255, 0);
    if (x < LCD_W / 2) return rgb565(0, 0, 255);
    int v = (x - LCD_W / 2) * 255 / (LCD_W / 2 - 1);
    return rgb565(v, v, v);
}

void app_main(void)
{
    done = xSemaphoreCreateBinary();
    const spi_bus_config_t bc = CO5300_PANEL_BUS_QSPI_CONFIG(PIN_CLK, PIN_D0, PIN_D1, PIN_D2, PIN_D3, LCD_W * STRIP * 2);
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bc, SPI_DMA_CH_AUTO));
    esp_lcd_panel_io_handle_t io = NULL;
    const esp_lcd_panel_io_spi_config_t ioc = CO5300_PANEL_IO_QSPI_CONFIG(PIN_CS, on_done, NULL);
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &ioc, &io));
    co5300_vendor_config_t vc = {.flags = {.use_qspi_interface = 1}};
    const esp_lcd_panel_dev_config_t pc = {
        .reset_gpio_num = PIN_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
        .vendor_config = &vc,
    };
    esp_lcd_panel_handle_t panel = NULL;
    ESP_ERROR_CHECK(esp_lcd_new_panel_co5300(io, &pc, &panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));
    printf("CO5300 QSPI init ok\n");

    uint16_t *buf = heap_caps_malloc(LCD_W * STRIP * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    uint32_t sum = 0;
    int64_t busy = 0;
    for (int y0 = 0; y0 < LCD_H; y0 += STRIP) {
        for (int y = 0; y < STRIP; y++) {
            for (int x = 0; x < LCD_W; x++) {
                uint16_t c = pattern(x, y0 + y);
                sum = sum * 31 + c;
                // LCD wants the high byte first; SPI sends memory order
                buf[y * LCD_W + x] = (uint16_t)((c >> 8) | (c << 8));
            }
        }
        int64_t t0 = esp_timer_get_time();
        ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(panel, 0, y0, LCD_W, y0 + STRIP, buf));
        xSemaphoreTake(done, portMAX_DELAY);
        busy += esp_timer_get_time() - t0;
    }
    printf("frame checksum %08lx, bus time %lld us (%d strips of %d rows)\n", (unsigned long)sum, busy, LCD_H / STRIP, STRIP);
    printf("TRYBOARD_OK s3-co5300\n");
    while (1) vTaskDelay(pdMS_TO_TICKS(1000));
}
