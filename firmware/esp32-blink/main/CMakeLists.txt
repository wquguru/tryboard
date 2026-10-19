# Shares source with the C3 version (firmware/blink/main/main.c); DevKitC V4 has no user LED, wire one to GPIO2
idf_component_register(SRCS "../../blink/main/main.c" INCLUDE_DIRS ".")
target_compile_definitions(${COMPONENT_LIB} PRIVATE LED_GPIO=2)
