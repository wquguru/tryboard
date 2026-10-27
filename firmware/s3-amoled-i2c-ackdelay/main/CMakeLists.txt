# CST9220 ack-race variant (H-35): same source as s3-amoled-i2c, acks each touch report 50 ms after reading it
idf_component_register(SRCS "../../s3-amoled-i2c/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_i2c esp_driver_gpio)
target_compile_definitions(${COMPONENT_LIB} PRIVATE ACK_DELAY_MS=50)
