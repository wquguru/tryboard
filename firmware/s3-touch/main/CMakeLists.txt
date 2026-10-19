# GC9A01 via managed component espressif/esp_lcd_gc9a01 (Apache-2.0); CST816S registers read with the IDF I2C master
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common"
                       PRIV_REQUIRES esp_driver_spi esp_driver_gpio esp_driver_i2c esp_lcd esp_timer)
