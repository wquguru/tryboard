# 与 c3-gptimer 共用源码
idf_component_register(SRCS "../../c3-gptimer/main/main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_gptimer esp_timer)
