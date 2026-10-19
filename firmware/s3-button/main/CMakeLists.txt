# Shares source with the C3 version (firmware/button/main/main.c), only pins overridden: the S3 BOOT button is GPIO0
idf_component_register(SRCS "../../button/main/main.c" INCLUDE_DIRS ".")
target_compile_definitions(${COMPONENT_LIB} PRIVATE BTN_GPIO=0 LED_GPIO=5)
