# 与 tilt 共用源码（firmware/tilt/main/main.c），STAGE=2
idf_component_register(SRCS "../../tilt/main/main.c" INCLUDE_DIRS "." "../../common"
                       PRIV_REQUIRES esp_driver_i2c esp_driver_spi esp_driver_gpio esp_lcd)
target_compile_definitions(${COMPONENT_LIB} PRIVATE STAGE=2)
