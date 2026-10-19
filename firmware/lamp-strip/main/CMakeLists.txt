# Shares source with lamp (firmware/lamp/main/main.c), STAGE=1
idf_component_register(SRCS "../../lamp/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_rmt esp_driver_pcnt esp_driver_gpio)
target_compile_definitions(${COMPONENT_LIB} PRIVATE STAGE=1)
