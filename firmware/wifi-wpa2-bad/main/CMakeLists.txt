# Shares the wifi-http source with a wrong password on purpose: expect handshake failure, a disconnect reason and no crash
idf_component_register(SRCS "../../wifi-http/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_wifi nvs_flash esp_netif esp_event esp_http_client)
target_compile_definitions(${COMPONENT_LIB} PRIVATE WIFI_SSID="TryBoard-WPA2" WIFI_PASS="wrongpass1" TAG_OK="wifi-wpa2-bad" WIFI_AUTH_MIN=WIFI_AUTH_WPA2_PSK WIFI_EXPECT_FAIL=2)
