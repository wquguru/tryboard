# 与 C3 版共用源码（firmware/pot/main/main.c），只覆盖引脚
idf_component_register(SRCS "../../pot/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_adc esp_driver_ledc)
target_compile_definitions(${COMPONENT_LIB} PRIVATE POT_CHANNEL=ADC_CHANNEL_3 LED_GPIO=5 FULL_MV=3100)
