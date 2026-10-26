# Lesson 4 period variant: same source as s3-fade, only FADE_MS overridden
idf_component_register(SRCS "../../s3-fade/main/main.c" INCLUDE_DIRS ".")
target_compile_definitions(${COMPONENT_LIB} PRIVATE FADE_MS=4000)
