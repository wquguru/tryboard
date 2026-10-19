# Shares the C3 source (firmware/pot/main/main.c), only pins are overridden
idf_component_register(SRCS "../../pot/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_adc esp_driver_ledc)
target_compile_definitions(${COMPONENT_LIB} PRIVATE POT_CHANNEL=ADC_CHANNEL_3 LED_GPIO=5 FULL_MV=3100)
