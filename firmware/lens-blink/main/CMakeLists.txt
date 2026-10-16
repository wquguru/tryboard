# GC9A01 圆屏走组件管理器的 espressif/esp_lcd_gc9a01（Apache-2.0）；画图公共件在 firmware/common/round_lcd.h
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common"
                       PRIV_REQUIRES esp_driver_spi esp_driver_gpio esp_lcd esp_timer)
