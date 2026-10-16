# 字库 / SSD1306 / BME280 补偿与 oled、bme280 示例共用（firmware/common）；WS2812 走 led_strip 组件（与 rgb 相同）
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common"
                       PRIV_REQUIRES esp_driver_i2c esp_driver_ledc esp_driver_gpio esp_timer)
