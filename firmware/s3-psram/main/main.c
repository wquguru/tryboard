// Acceptance: S3 octal PSRAM (N16R8, 8MB OPI). IDF inits and maps PSRAM into the heap at boot;
// we allocate 4MB from it, write a pseudo-random pattern, read it back and print the time taken.
#include <stdio.h>
#include <inttypes.h>
#include "esp_heap_caps.h"
#include "esp_psram.h"
#include "esp_timer.h"
#include "esp_memory_utils.h"

#define TEST_BYTES (4u << 20)

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
        printf("TRYBOARD_FAIL s3-psram malloc %p\n", buf);
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

    int ok = bad == 0 && size == (8u << 20) && free_ext > (7u << 20) + (512u << 10);
    if (ok) {
        printf("PSRAM %u MB, test 4 MB OK\n", (unsigned)(size >> 20));
        printf("TRYBOARD_OK s3-psram\n");
    } else {
        printf("TRYBOARD_FAIL s3-psram size=%u free=%u bad=%u\n", (unsigned)size, (unsigned)free_ext, (unsigned)bad);
    }
}
