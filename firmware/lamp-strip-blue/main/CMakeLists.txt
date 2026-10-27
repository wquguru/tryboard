# Lesson 5 colour variant (H-28): same source as lamp-strip, only WARM overridden
idf_component_register(SRCS "../../lamp/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_rmt esp_driver_pcnt esp_driver_gpio)
target_compile_definitions(${COMPONENT_LIB} PRIVATE STAGE=1 WARM=0x0000FF)
