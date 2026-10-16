# GC9A01 圆屏走组件管理器的 espressif/esp_lcd_gc9a01（Apache-2.0）；CST816S 用 IDF 的 I2C 主机驱动直接读寄存器
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common"
                       PRIV_REQUIRES esp_driver_spi esp_driver_gpio esp_driver_i2c esp_lcd esp_timer)
