# Shares source with the C3 version (firmware/wifi-init/main/main.c): checks only driver init and RF calibration
idf_component_register(SRCS "../../wifi-init/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_wifi nvs_flash esp_netif esp_event)
