# Shares source with s3-ultrasonic; C3 Trig=GPIO4, Echo=GPIO5 (avoiding I2S 0..3, strapping 2/8/9, USB 18/19, UART0 20/21)
idf_component_register(SRCS "../../s3-ultrasonic/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_rmt esp_driver_gpio)
target_compile_definitions(${COMPONENT_LIB} PRIVATE TRIG_GPIO=4 ECHO_GPIO=5)
