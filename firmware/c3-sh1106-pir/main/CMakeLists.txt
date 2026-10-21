# F-04a2 example: SH1106 page-mode flush (as in c3-sh1106) + PIR on GPIO4; font / frame buffer from firmware/common/ssd1306_mini.h
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common" PRIV_REQUIRES esp_driver_i2c esp_driver_gpio esp_timer)
