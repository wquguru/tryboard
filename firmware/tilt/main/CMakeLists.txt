# 体感小人三个检查点共用一份源码（STAGE 1 读姿态 / 2 圆屏画小人 / 3 合体）。
# 圆屏走组件管理器的 espressif/esp_lcd_gc9a01（Apache-2.0，与 spin / lens 相同）；画图公共件在 firmware/common/round_lcd.h
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common"
                       PRIV_REQUIRES esp_driver_i2c esp_driver_spi esp_driver_gpio esp_lcd)
