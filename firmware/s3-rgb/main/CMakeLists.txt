# Shares the C3 source (firmware/rgb/main/main.c), only pins are overridden
idf_component_register(SRCS "../../rgb/main/main.c" INCLUDE_DIRS ".")
target_compile_definitions(${COMPONENT_LIB} PRIVATE LED_GPIO=48)
