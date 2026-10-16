# 与 C3 版共用源码（firmware/button/main/main.c），只覆盖引脚：S3 的 BOOT 键在 GPIO0
idf_component_register(SRCS "../../button/main/main.c" INCLUDE_DIRS ".")
target_compile_definitions(${COMPONENT_LIB} PRIVATE BTN_GPIO=0 LED_GPIO=5)
