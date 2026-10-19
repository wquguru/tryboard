# 与 c3-softap-prov 同一份源码，跑在 ESP32-S3 上（Wi-Fi MAC 模型两颗芯片共用）
idf_component_register(SRCS "../../c3-softap-prov/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_wifi nvs_flash esp_netif esp_event esp_http_server lwip)
target_compile_definitions(${COMPONENT_LIB} PRIVATE TAG_OK="s3-softap-prov")
