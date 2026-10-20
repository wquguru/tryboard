# DS18B20 on GPIO4 (open drain, own 1-Wire bit-bang driver: no third-party library)
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_gpio esp_timer)
