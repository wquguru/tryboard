# IR remote night light (G-04): RMT RX decodes NEC, RMT TX drives the WS2812 strip; only IDF's RMT driver
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_rmt)
