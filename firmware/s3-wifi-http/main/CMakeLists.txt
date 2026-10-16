# 与 C3 版共用源码（firmware/wifi-http/main/main.c），sdkconfig 分开
idf_component_register(SRCS "../../wifi-http/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_wifi nvs_flash esp_netif esp_event esp_http_client)
