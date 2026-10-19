// Example: boot counter in NVS (flash), incremented after each esp_restart. Checks flash write / erase and soft reset.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "esp_system.h"

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    nvs_handle_t h;
    nvs_open("tryboard", NVS_READWRITE, &h);
    int32_t boots = 0;
    nvs_get_i32(h, "boots", &boots);
    boots++;
    nvs_set_i32(h, "boots", boots);
    nvs_commit(h);
    nvs_close(h);
    printf("开机第 %ld 次（复位原因 %d）\n", (long)boots, esp_reset_reason());
    if (boots >= 3) {
        printf("TRYBOARD_OK nvs\n");
        return;
    }
    vTaskDelay(pdMS_TO_TICKS(300));
    printf("300ms 后重启…\n");
    esp_restart();
}
