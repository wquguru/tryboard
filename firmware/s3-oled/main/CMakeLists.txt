# Shares the C3 source (firmware/oled/main/main.c), only pins are overridden
idf_component_register(SRCS "../../oled/main/main.c" INCLUDE_DIRS "." "../../common" PRIV_REQUIRES esp_driver_i2c esp_timer)
target_compile_definitions(${COMPONENT_LIB} PRIVATE PIN_SDA=8 PIN_SCL=9)
