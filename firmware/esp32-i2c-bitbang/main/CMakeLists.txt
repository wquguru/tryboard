# Shares source with s3-i2c-bitbang; M5 Core internal bus pins (SDA 21 / SCL 22)
idf_component_register(SRCS "../../s3-i2c-bitbang/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_i2c esp_driver_gpio)
target_compile_definitions(${COMPONENT_LIB} PRIVATE SDA=21 SCL=22)
