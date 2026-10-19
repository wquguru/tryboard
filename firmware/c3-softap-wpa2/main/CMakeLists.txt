# 与 c3-softap-prov 同一份源码，只是热点带口令（WPA2-PSK）：验证虚拟手机当请求方的四次握手
idf_component_register(SRCS "../../c3-softap-prov/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_wifi nvs_flash esp_netif esp_event esp_http_server lwip)
target_compile_definitions(${COMPONENT_LIB} PRIVATE AP_PASS="tryboard123" TAG_OK="c3-softap-wpa2")
