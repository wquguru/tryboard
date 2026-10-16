# 超声波尺子三个检查点共用一份源码（STAGE 1 测距打印 / 2 OLED 显示 / 3 合体）；SSD1306 画法在 firmware/common
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." "../../common" PRIV_REQUIRES esp_driver_rmt esp_driver_gpio esp_driver_i2c esp_driver_ledc)
