# Shares source with the C3 version (firmware/bme280/main/main.c), only pins overridden
idf_component_register(SRCS "../../bme280/main/main.c" INCLUDE_DIRS "." "../../common" PRIV_REQUIRES esp_driver_i2c)
target_compile_definitions(${COMPONENT_LIB} PRIVATE PIN_SDA=8 PIN_SCL=9)
