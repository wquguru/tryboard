# 与 C3 版 wifi-wpa2 相同（经典 ESP32）：共用 wifi-http 源码，只换 SSID / 密码
idf_component_register(SRCS "../../wifi-http/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_wifi nvs_flash esp_netif esp_event esp_http_client)
target_compile_definitions(${COMPONENT_LIB} PRIVATE WIFI_SSID="TryBoard-WPA2" WIFI_PASS="tryboard123" TAG_OK="wifi-wpa2" WIFI_AUTH_MIN=WIFI_AUTH_WPA2_PSK)
