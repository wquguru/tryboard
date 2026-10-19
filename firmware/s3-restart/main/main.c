// Acceptance: S3 software reset on both cores; NVS counts boots: boot 1 restarts from core 0, boot 2 from a core-1 task
// (core 1 resets core 0), boot 3 checks. Also RTC_NOINIT survives reset while RTC_DATA reloads from the image.
#include <stdio.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "esp_system.h"
#include "esp_attr.h"

#define NOINIT_MAGIC 0x54425254u

static RTC_NOINIT_ATTR uint32_t s_noinit_magic;
static RTC_NOINIT_ATTR uint32_t s_noinit_boots;
static RTC_DATA_ATTR uint32_t s_rtc_data = 7;

static int32_t s_boots;
static volatile int s_core1_seen = -1;

static const char *reason_name(esp_reset_reason_t r)
{
    switch (r) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_SW: return "SW";
    case ESP_RST_PANIC: return "PANIC";
    default: return "OTHER";
    }
}

static void core1_task(void *arg)
{
    s_core1_seen = xPortGetCoreID();
    printf("core1 task on core %d (boot %" PRId32 ")\n", s_core1_seen, s_boots);
    if (s_boots == 2) {
        vTaskDelay(pdMS_TO_TICKS(100));
        printf("restart from core %d\n", xPortGetCoreID());
        fflush(stdout);
        esp_restart();
    }
    vTaskDelete(NULL);
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }
    nvs_handle_t h;
    nvs_open("tryboard", NVS_READWRITE, &h);
    nvs_get_i32(h, "boots", &s_boots);
    s_boots++;
    nvs_set_i32(h, "boots", s_boots);
    nvs_commit(h);
    nvs_close(h);

    if (s_noinit_magic != NOINIT_MAGIC) {
        s_noinit_magic = NOINIT_MAGIC;
        s_noinit_boots = 0;
    }
    s_noinit_boots++;
    uint32_t data_at_boot = s_rtc_data;
    s_rtc_data = 99;

    esp_reset_reason_t r = esp_reset_reason();
    printf("BOOT COUNT %" PRId32 " reason=%s\n", s_boots, reason_name(r));
    printf("RTC noinit=%" PRIu32 " data=%" PRIu32 "\n", s_noinit_boots, data_at_boot);

    xTaskCreatePinnedToCore(core1_task, "c1", 3072, NULL, 5, NULL, 1);
    vTaskDelay(pdMS_TO_TICKS(50));
    if (s_core1_seen != 1) {
        printf("core1 not running\n");
    }

    if (s_boots == 1) {
        vTaskDelay(pdMS_TO_TICKS(100));
        printf("restart from core %d\n", xPortGetCoreID());
        fflush(stdout);
        esp_restart();
    }
    if (s_boots == 3) {
        int ok = r == ESP_RST_SW && s_noinit_boots == 3 && data_at_boot == 7 && s_core1_seen == 1;
        if (ok) {
            printf("TRYBOARD_OK s3-restart\n");
        } else {
            printf("TRYBOARD_FAIL s3-restart noinit=%" PRIu32 " data=%" PRIu32 " core1=%d\n", s_noinit_boots, data_at_boot, s_core1_seen);
        }
    }
}
