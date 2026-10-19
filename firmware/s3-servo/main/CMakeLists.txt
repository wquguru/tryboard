# Shares the C3 source (firmware/servo/main/main.c), only pins are overridden
idf_component_register(SRCS "../../servo/main/main.c" INCLUDE_DIRS ".")
target_compile_definitions(${COMPONENT_LIB} PRIVATE SERVO_GPIO=4)
