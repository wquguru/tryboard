# One source for the ultrasonic ruler's three checkpoints (STAGE 1 print distance / 2 OLED / 3 combined); SSD1306 drawing in firmware/common
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common" PRIV_REQUIRES esp_driver_rmt esp_driver_gpio esp_driver_i2c esp_driver_ledc)
