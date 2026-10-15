# 与 C3 版共用源码（firmware/rgb/main/main.c），只覆盖引脚
idf_component_register(SRCS "../../rgb/main/main.c" INCLUDE_DIRS ".")
target_compile_definitions(${COMPONENT_LIB} PRIVATE LED_GPIO=48)
