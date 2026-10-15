// 验收固件：启动、打印芯片信息、FreeRTOS 延时计时。
#include <stdio.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_timer.h"
#include "esp_system.h"

void app_main(void)
{
    printf("Hello world!\n");
    esp_chip_info_t chip;
    esp_chip_info(&chip);
    printf("This is %s chip with %d CPU core(s), revision v%d.%d\n", CONFIG_IDF_TARGET, chip.cores,
           chip.revision / 100, chip.revision % 100);
    uint32_t size = 0;
    if (esp_flash_get_size(NULL, &size) == ESP_OK) {
        printf("%" PRIu32 "MB flash\n", size / (1024 * 1024));
    }
    printf("Free heap: %" PRIu32 " bytes\n", esp_get_free_heap_size());
    for (int i = 1; i <= 3; i++) {
        int64_t t0 = esp_timer_get_time();
        vTaskDelay(pdMS_TO_TICKS(500));
        printf("tick %d: delay 500ms took %lld us\n", i, (long long)(esp_timer_get_time() - t0));
    }
    printf("TRYBOARD_OK s3-hello\n");
}
