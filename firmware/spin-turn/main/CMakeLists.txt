# GC9A01 via managed component espressif/esp_lcd_gc9a01 (Apache-2.0); drawing helpers in firmware/common/round_lcd.h
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common"
                       PRIV_REQUIRES esp_driver_spi esp_driver_gpio esp_driver_ledc esp_lcd)
