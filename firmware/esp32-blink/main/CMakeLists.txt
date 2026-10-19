# 与 C3 版共用源码（firmware/blink/main/main.c）；DevKitC V4 没有用户 LED，外接 LED 到 GPIO2
idf_component_register(SRCS "../../blink/main/main.c" INCLUDE_DIRS ".")
target_compile_definitions(${COMPONENT_LIB} PRIVATE LED_GPIO=2)
