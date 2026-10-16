# 旋钮台灯三个检查点共用一份源码（STAGE 1 灯带点亮 / 2 旋钮读数 / 3 合体），只用 IDF 自带的 RMT、PCNT、GPIO 驱动
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." PRIV_REQUIRES esp_driver_rmt esp_driver_pcnt esp_driver_gpio)
