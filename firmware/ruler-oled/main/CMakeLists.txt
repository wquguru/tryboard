# Shares source with ruler (firmware/ruler/main/main.c), STAGE=2
idf_component_register(SRCS "../../ruler/main/main.c" INCLUDE_DIRS "." "../../common" PRIV_REQUIRES esp_driver_rmt esp_driver_gpio esp_driver_i2c esp_driver_ledc)
target_compile_definitions(${COMPONENT_LIB} PRIVATE STAGE=2)
