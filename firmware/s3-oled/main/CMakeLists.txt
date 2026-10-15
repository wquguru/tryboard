# 与 C3 版共用源码（firmware/oled/main/main.c），只覆盖引脚
idf_component_register(SRCS "../../oled/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_i2c esp_timer)
target_compile_definitions(${COMPONENT_LIB} PRIVATE PIN_SDA=8 PIN_SCL=9)
