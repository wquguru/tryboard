# One source for the knob lamp's three checkpoints (STAGE 1 strip on / 2 knob reading / 3 combined); only IDF's RMT, PCNT, GPIO drivers
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_rmt esp_driver_pcnt esp_driver_gpio)
