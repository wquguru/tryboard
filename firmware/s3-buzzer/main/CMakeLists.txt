# Lesson 6 (H-16): passive buzzer on GPIO6 plays do re mi from an LEDC square wave
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_ledc)
