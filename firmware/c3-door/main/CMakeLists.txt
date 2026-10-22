# G-03 RFID door: RC522 register driver (as in c3-rc522) + SH1106 page flush (as in c3-sh1106-pir); font from firmware/common
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common" PRIV_REQUIRES esp_driver_gpio esp_driver_spi esp_driver_i2c esp_driver_ledc esp_timer)
