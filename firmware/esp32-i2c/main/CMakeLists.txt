# 字库 / SSD1306 / BME280 补偿与 oled、bme280 示例共用（firmware/common）
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common" PRIV_REQUIRES esp_driver_i2c)
