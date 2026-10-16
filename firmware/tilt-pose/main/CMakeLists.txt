# 与 tilt 共用源码（firmware/tilt/main/main.c），STAGE=1：只读 IMU，不接圆屏
idf_component_register(SRCS "../../tilt/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_i2c)
target_compile_definitions(${COMPONENT_LIB} PRIVATE STAGE=1)
