# 与 C3 版共用源码（firmware/wifi-init/main/main.c）：只验驱动初始化与射频校准
idf_component_register(SRCS "../../wifi-init/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_wifi nvs_flash esp_netif esp_event)
