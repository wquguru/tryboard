// 基准：纯 CPU 负载（素数筛 + CRC32 + 浮点），用 CPU 周期计数报告耗时。
// 真机 160MHz 下的耗时可用于标定模拟器的 CPI 模型。
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include "esp_cpu.h"
#include "esp_timer.h"

static uint8_t sieve[32768];

static int primes(void)
{
    memset(sieve, 1, sizeof(sieve));
    int n = 0;
    for (int i = 2; i < (int)sizeof(sieve); i++) {
        if (!sieve[i]) continue;
        n++;
        for (int j = i * 2; j < (int)sizeof(sieve); j += i) sieve[j] = 0;
    }
    return n;
}

static uint32_t crc32(const uint8_t *p, int len)
{
    uint32_t c = 0xffffffff;
    while (len--) {
        c ^= *p++;
        for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c;
}

static float fsum(int n)
{
    float s = 0;
    for (int i = 1; i <= n; i++) s += 1.0f / ((float)i * i);
    return s;
}

void app_main(void)
{
    for (int round = 0; round < 3; round++) {
        int64_t t0 = esp_timer_get_time();
        uint32_t c0 = esp_cpu_get_cycle_count();
        int p = primes();
        uint32_t crc = crc32(sieve, sizeof(sieve));
        float f = fsum(20000);
        uint32_t cyc = esp_cpu_get_cycle_count() - c0;
        int64_t us = esp_timer_get_time() - t0;
        printf("round %d: primes=%d crc=%08lx sum=%.6f cycles=%lu time=%lld us\n", round, p, (unsigned long)crc, f, (unsigned long)cyc, (long long)us);
    }
    printf("TRYBOARD_OK bench\n");
}
