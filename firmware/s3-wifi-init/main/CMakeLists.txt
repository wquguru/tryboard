# 与 C3 版共用源码（firmware/wifi-init/main/main.c），sdkconfig 分开
idf_component_register(SRCS "../../wifi-init/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_wifi nvs_flash esp_netif esp_event)
