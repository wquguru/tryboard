# Shares the s3-imu source (firmware/s3-imu/main/main.c), only the device changes
idf_component_register(SRCS "../../s3-imu/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_i2c)
target_compile_definitions(${COMPONENT_LIB} PRIVATE IMU_QMI8658=1)
