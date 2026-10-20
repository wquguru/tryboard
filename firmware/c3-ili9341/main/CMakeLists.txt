# ILI9341 via component manager espressif/esp_lcd_ili9341 (vendor init sequence); pattern in firmware/common/bare_tft.h
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common"
                       PRIV_REQUIRES esp_driver_spi esp_driver_gpio esp_lcd)
