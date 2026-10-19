# Shares source with the C3 version (firmware/wifi-http/main/main.c); separate sdkconfig
idf_component_register(SRCS "../../wifi-http/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_wifi nvs_flash esp_netif esp_event esp_http_client)
