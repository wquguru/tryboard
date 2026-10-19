# Shared by MPU6050 / QMI8658 (s3-qmi8658 defines IMU_QMI8658)
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_i2c)
