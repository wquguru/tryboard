# Shares source with the C3 version (firmware/blink/main/main.c), only pins overridden
idf_component_register(SRCS "../../blink/main/main.c" INCLUDE_DIRS ".")
target_compile_definitions(${COMPONENT_LIB} PRIVATE LED_GPIO=5 BLINK_MS=1000)
