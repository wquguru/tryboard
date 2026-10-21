# F-04a2 example: ILI9341 temperature screen (espressif/esp_lcd_ili9341, bare_tft.h) + DS18B20 on GPIO1 (own 1-Wire bit-bang)
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common"
                       PRIV_REQUIRES esp_driver_spi esp_driver_gpio esp_lcd esp_timer)
