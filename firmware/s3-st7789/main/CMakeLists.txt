# ST7789 with the panel driver built into IDF esp_lcd (no component); pattern in firmware/common/bare_tft.h
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common"
                       PRIV_REQUIRES esp_driver_spi esp_driver_gpio esp_lcd)
