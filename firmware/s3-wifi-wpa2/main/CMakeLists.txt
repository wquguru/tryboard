# Same as C3 wifi-wpa2: shares the wifi-http source, only SSID / password differ
idf_component_register(SRCS "../../wifi-http/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_wifi nvs_flash esp_netif esp_event esp_http_client)
target_compile_definitions(${COMPONENT_LIB} PRIVATE WIFI_SSID="TryBoard-WPA2" WIFI_PASS="tryboard123" TAG_OK="wifi-wpa2" WIFI_AUTH_MIN=WIFI_AUTH_WPA2_PSK)
