// Acceptance M5-14: classic ESP32 quad PSRAM is probed over SPI1 / CS1, mapped at 0x3F800000 (<= 4MB without
// himem), memtested and added to the heap; we print the heap caps and write / verify 1MB of a pseudo-random pattern.
#include <stdio.h>
#include <inttypes.h>
#include "esp_heap_caps.h"
#include "esp_psram.h"
#include "esp_timer.h"
#include "esp_memory_utils.h"

#define TEST_BYTES (1u << 20)

static inline uint32_t xorshift(uint32_t x)
{
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return x;
}

void app_main(void)
{
    size_t size = esp_psram_get_size();
    size_t free_ext = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    size_t free_int = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    printf("esp_psram_get_size %u, SPIRAM heap free %u, internal free %u\n", (unsigned)size, (unsigned)free_ext, (unsigned)free_int);

    uint32_t *buf = heap_caps_malloc(TEST_BYTES, MALLOC_CAP_SPIRAM);
    if (!buf || !esp_ptr_external_ram(buf)) {
        printf("TRYBOARD_FAIL esp32-psram malloc %p\n", buf);
        return;
    }
    printf("buffer %p..%p\n", buf, (uint8_t *)buf + TEST_BYTES);

    const size_t n = TEST_BYTES / 4;
    int64_t t0 = esp_timer_get_time();
    uint32_t x = 0x12345678;
    for (size_t i = 0; i < n; i++) {
        x = xorshift(x);
        buf[i] = x ^ i;
    }
    int64_t t1 = esp_timer_get_time();
    x = 0x12345678;
    size_t bad = 0;
    for (size_t i = 0; i < n; i++) {
        x = xorshift(x);
        if (buf[i] != (x ^ i)) {
            if (bad < 4) {
                printf("mismatch @%u: %08" PRIx32 " != %08" PRIx32 "\n", (unsigned)i, buf[i], x ^ (uint32_t)i);
            }
            bad++;
        }
    }
    int64_t t2 = esp_timer_get_time();
    printf("write %lld us, verify %lld us\n", (long long)(t1 - t0), (long long)(t2 - t1));
    heap_caps_free(buf);

    // esp_psram_get_size is the chip size; without himem only 4MB of it is mapped into the heap
    size_t mapped = size > (4u << 20) ? (4u << 20) : size;
    if (bad == 0 && size >= (2u << 20) && free_ext + (256u << 10) > mapped) {
        printf("PSRAM %u MB, %u MB mapped, test 1 MB OK\n", (unsigned)(size >> 20), (unsigned)(mapped >> 20));
        printf("TRYBOARD_OK esp32-psram\n");
    } else {
        printf("TRYBOARD_FAIL esp32-psram size=%u free=%u bad=%u\n", (unsigned)size, (unsigned)free_ext, (unsigned)bad);
    }
}
