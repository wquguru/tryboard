# Same source as c3-ds18b20 (DS18B20 on GPIO4)
idf_component_register(SRCS "../../c3-ds18b20/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_gpio esp_timer)
