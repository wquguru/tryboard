idf_component_register(SRCS "main.c" "prov.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_i2c esp_driver_gpio esp_timer esp_wifi nvs_flash esp_netif esp_event mqtt esp_http_server lwip)
