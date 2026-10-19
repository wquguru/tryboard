# Shares the C3 source (firmware/c3-adc-cali/main/main.c), only the pin and naive full scale differ
idf_component_register(SRCS "../../c3-adc-cali/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_adc)
target_compile_definitions(${COMPONENT_LIB} PRIVATE CALI_CHANNEL=ADC_CHANNEL_3 FULL_MV=3100)
