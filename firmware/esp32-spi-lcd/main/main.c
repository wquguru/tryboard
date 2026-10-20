// M5-10 acceptance: classic ESP32 VSPI + DMA driving an ST7789 135x240 (M5StickC Plus2 wiring),
// then a raw 3-wire half-duplex RDDID read through spi_device_polling_transmit.
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_st7789.h"

#define HOST SPI3_HOST
#define PIN_SCLK 13
#define PIN_MOSI 15
#define PIN_CS 5
#define PIN_DC 14
#define PIN_RST 12
#define PIN_BL 27
#define W 135
#define H 240
#define BAND 60

static SemaphoreHandle_t done;

static bool on_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *e, void *ctx)
{
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(done, &woken);
    return woken == pdTRUE;
}

void app_main(void)
{
    done = xSemaphoreCreateBinary();
    gpio_config_t bl = {.pin_bit_mask = 1ULL << PIN_BL, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&bl);
    gpio_set_level(PIN_BL, 0);

    spi_bus_config_t bus = {
        .sclk_io_num = PIN_SCLK,
        .mosi_io_num = PIN_MOSI,
        .miso_io_num = -1,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = W * BAND * 2,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(HOST, &bus, SPI_DMA_CH_AUTO));

    esp_lcd_panel_io_handle_t io;
    esp_lcd_panel_io_spi_config_t ioc = {
        .dc_gpio_num = PIN_DC,
        .cs_gpio_num = PIN_CS,
        .pclk_hz = 20 * 1000 * 1000,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .spi_mode = 0,
        .trans_queue_depth = 4,
        .on_color_trans_done = on_done,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)HOST, &ioc, &io));

    esp_lcd_panel_handle_t panel;
    esp_lcd_panel_dev_config_t pc = {
        .reset_gpio_num = PIN_RST,
        // BGR subpixels on this glass: MADCTL.BGR=1 gives true red / blue
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
        .bits_per_pixel = 16,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(io, &pc, &panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
    // IPS glass (as on the StickC Plus2) shows true colours only with INVON
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(panel, true));
    ESP_ERROR_CHECK(esp_lcd_panel_set_gap(panel, 52, 40));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));
    gpio_set_level(PIN_BL, 1);
    printf("ST7789 135x240 init OK (VSPI, DMA)\n");

    // Four bands top to bottom: red, green, blue, white; each strip is 16200 bytes so DMA chains descriptors
    static const uint16_t colors[4] = {0xF800, 0x07E0, 0x001F, 0xFFFF};
    uint16_t *buf = heap_caps_malloc(W * BAND * 2, MALLOC_CAP_DMA);
    for (int b = 0; b < 4; b++) {
        uint16_t c = (uint16_t)((colors[b] >> 8) | (colors[b] << 8));
        for (int i = 0; i < W * BAND; i++) buf[i] = c;
        ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(panel, 0, b * BAND, W, (b + 1) * BAND, buf));
        xSemaphoreTake(done, portMAX_DELAY);
    }
    printf("draw done: 4 bands of %d bytes\n", W * BAND * 2);

    // Hand CS to a raw half-duplex 3-wire device: 8-bit command, 1 dummy clock, 24 bits read back on SDA
    ESP_ERROR_CHECK(esp_lcd_panel_io_del(io));
    gpio_config_t dc = {.pin_bit_mask = 1ULL << PIN_DC, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&dc);
    gpio_set_level(PIN_DC, 0);
    spi_device_handle_t dev;
    spi_device_interface_config_t dcfg = {
        .command_bits = 8,
        .mode = 0,
        .clock_speed_hz = 1 * 1000 * 1000,
        .spics_io_num = PIN_CS,
        .flags = SPI_DEVICE_3WIRE | SPI_DEVICE_HALFDUPLEX,
        .queue_size = 1,
    };
    ESP_ERROR_CHECK(spi_bus_add_device(HOST, &dcfg, &dev));
    spi_transaction_ext_t t;
    memset(&t, 0, sizeof t);
    t.base.flags = SPI_TRANS_VARIABLE_DUMMY | SPI_TRANS_USE_RXDATA;
    t.base.cmd = 0x04;
    t.base.rxlength = 24;
    t.dummy_bits = 1;
    ESP_ERROR_CHECK(spi_device_polling_transmit(dev, &t.base));
    printf("RDDID: %02X %02X %02X\n", t.base.rx_data[0], t.base.rx_data[1], t.base.rx_data[2]);
    if (t.base.rx_data[0] == 0x85 && t.base.rx_data[1] == 0x85 && t.base.rx_data[2] == 0x52) {
        printf("TRYBOARD_OK esp32-spi-lcd\n");
    }
    while (1) vTaskDelay(pdMS_TO_TICKS(1000));
}
