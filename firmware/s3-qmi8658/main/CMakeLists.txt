# 与 s3-imu 共用源码（firmware/s3-imu/main/main.c），只换器件
idf_component_register(SRCS "../../s3-imu/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_i2c)
target_compile_definitions(${COMPONENT_LIB} PRIVATE IMU_QMI8658=1)
