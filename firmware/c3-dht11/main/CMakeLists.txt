# DHT11 on GPIO5 (open drain, own bit-bang driver: no third-party library)
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_gpio)
