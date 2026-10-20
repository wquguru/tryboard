# SH1106 with an in-tree page-mode flush; font / frame buffer helpers from firmware/common/ssd1306_mini.h
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common" PRIV_REQUIRES esp_driver_i2c esp_timer)
