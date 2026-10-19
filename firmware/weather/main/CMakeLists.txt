# Font / SSD1306 / BME280 compensation shared via firmware/common; WS2812 via the led_strip component (as rgb)
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common"
                       PRIV_REQUIRES esp_driver_i2c esp_driver_ledc esp_driver_gpio esp_timer)
