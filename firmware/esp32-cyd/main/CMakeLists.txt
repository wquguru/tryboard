# CYD (ESP32-2432S028): ILI9341 on HSPI via espressif/esp_lcd_ili9341; pattern in firmware/common/bare_tft.h
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common"
                       PRIV_REQUIRES esp_driver_spi esp_driver_gpio esp_lcd)
