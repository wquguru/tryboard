# Shares the C3 source (firmware/wifi-scan/main/main.c); separate sdkconfig
idf_component_register(SRCS "../../wifi-scan/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_wifi nvs_flash esp_netif esp_event)
