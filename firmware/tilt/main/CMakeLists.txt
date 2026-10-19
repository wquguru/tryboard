# One source for the three tilt checkpoints (STAGE 1 pose / 2 draw on round LCD / 3 combined).
# LCD via managed espressif/esp_lcd_gc9a01 (Apache-2.0, as spin / lens); drawing helpers in firmware/common/round_lcd.h
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common"
                       PRIV_REQUIRES esp_driver_i2c esp_driver_spi esp_driver_gpio esp_lcd)
