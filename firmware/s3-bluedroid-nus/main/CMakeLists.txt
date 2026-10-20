# Shares the C3 source (firmware/c3-bluedroid-nus/main/main.c); separate sdkconfig (E-05)
idf_component_register(SRCS "../../c3-bluedroid-nus/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES bt nvs_flash json esp_timer)
