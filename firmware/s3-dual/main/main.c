// 验收固件：双核。两个任务分别钉在核 0 / 核 1，共用自旋锁保护的计数器，经队列跨核传消息，
// 再用 esp_ipc 让核 1 执行一个函数。全部结果正确时打印 TRYBOARD_OK s3-dual。
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_cpu.h"
#include "esp_ipc.h"
#include "esp_timer.h"

#define N 20000
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static volatile uint32_t counter;
static QueueHandle_t q;
static volatile int ran_on[2];
static volatile int ipc_core = -1;

static void worker(void *arg)
{
    int id = (int)arg;
    ran_on[id] = esp_cpu_get_core_id();
    for (int i = 0; i < N; i++) {
        portENTER_CRITICAL(&mux);
        counter++;
        portEXIT_CRITICAL(&mux);
    }
    int msg = id * 100 + ran_on[id];
    xQueueSend(q, &msg, portMAX_DELAY);
    vTaskDelete(NULL);
}

static void ipc_fn(void *arg)
{
    ipc_core = esp_cpu_get_core_id();
}

void app_main(void)
{
    printf("app_main on core %d\n", esp_cpu_get_core_id());
    q = xQueueCreate(4, sizeof(int));
    xTaskCreatePinnedToCore(worker, "w0", 3072, (void *)0, 5, NULL, 0);
    xTaskCreatePinnedToCore(worker, "w1", 3072, (void *)1, 5, NULL, 1);
    int got = 0;
    for (int i = 0; i < 2; i++) {
        int m;
        if (xQueueReceive(q, &m, pdMS_TO_TICKS(2000))) {
            printf("msg %d (task %d ran on core %d)\n", m, m / 100, m % 100);
            got++;
        }
    }
    esp_ipc_call_blocking(1, ipc_fn, NULL);
    printf("counter=%lu (expect %d), ipc ran on core %d\n", (unsigned long)counter, 2 * N, ipc_core);
    int64_t t0 = esp_timer_get_time();
    vTaskDelay(pdMS_TO_TICKS(100));
    printf("delay 100ms took %lld us\n", (long long)(esp_timer_get_time() - t0));
    if (got == 2 && counter == 2 * N && ran_on[0] == 0 && ran_on[1] == 1 && ipc_core == 1)
        printf("TRYBOARD_OK s3-dual\n");
}
