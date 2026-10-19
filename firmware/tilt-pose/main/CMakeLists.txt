# Shares the tilt source (firmware/tilt/main/main.c), STAGE=1: IMU only, no round LCD
idf_component_register(SRCS "../../tilt/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_i2c)
target_compile_definitions(${COMPONENT_LIB} PRIVATE STAGE=1)
