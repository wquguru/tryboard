# Shares source with c3-gptimer
idf_component_register(SRCS "../../c3-gptimer/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_gptimer esp_timer)
