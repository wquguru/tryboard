# Shares the C3 source (firmware/c3-ble-hr/main/main.c); separate sdkconfig (E-09)
idf_component_register(SRCS "../../c3-ble-hr/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES bt nvs_flash esp_driver_gpio)
