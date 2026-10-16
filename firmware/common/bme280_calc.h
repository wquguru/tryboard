// BME280 出厂校准参数解析 + 数据手册整数补偿公式，供 bme280 / weather 等示例共用（只在一个 .c 里包含）。
#pragma once
#include <stdint.h>

static uint16_t T1, P1;
static int16_t T2, T3, P2, P3, P4, P5, P6, P7, P8, P9, H2, H4, H5;
static uint8_t H1, H3;
static int8_t H6;
static int32_t t_fine;

static inline int32_t comp_t(int32_t adc)
{
    int32_t v1 = ((((adc >> 3) - ((int32_t)T1 << 1))) * T2) >> 11;
    int32_t v2 = (((((adc >> 4) - (int32_t)T1) * ((adc >> 4) - (int32_t)T1)) >> 12) * T3) >> 14;
    t_fine = v1 + v2;
    return (t_fine * 5 + 128) >> 8;
}

static inline uint32_t comp_p(int32_t adc)
{
    int64_t v1 = (int64_t)t_fine - 128000;
    int64_t v2 = v1 * v1 * P6;
    v2 += (v1 * P5) << 17;
    v2 += ((int64_t)P4) << 35;
    v1 = ((v1 * v1 * P3) >> 8) + ((v1 * P2) << 12);
    v1 = (((((int64_t)1) << 47) + v1)) * P1 >> 33;
    if (v1 == 0) return 0;
    int64_t p = 1048576 - adc;
    p = (((p << 31) - v2) * 3125) / v1;
    v1 = (((int64_t)P9) * (p >> 13) * (p >> 13)) >> 25;
    v2 = (((int64_t)P8) * p) >> 19;
    p = ((p + v1 + v2) >> 8) + (((int64_t)P7) << 4);
    return (uint32_t)p;
}

static inline uint32_t comp_h(int32_t adc)
{
    int32_t v = t_fine - 76800;
    v = (((((adc << 14) - (((int32_t)H4) << 20) - (((int32_t)H5) * v)) + 16384) >> 15) *
         (((((((v * H6) >> 10) * (((v * (int32_t)H3) >> 11) + 32768)) >> 10) + 2097152) * H2 + 8192) >> 14));
    v = v - (((((v >> 15) * (v >> 15)) >> 7) * H1) >> 4);
    v = v < 0 ? 0 : v;
    v = v > 419430400 ? 419430400 : v;
    return (uint32_t)(v >> 12);
}

// c = 0x88 起 26 字节，h = 0xE1 起 7 字节
static inline void bme280_parse_calib(const uint8_t *c, const uint8_t *h)
{
    T1 = c[0] | c[1] << 8; T2 = c[2] | c[3] << 8; T3 = c[4] | c[5] << 8;
    P1 = c[6] | c[7] << 8; P2 = c[8] | c[9] << 8; P3 = c[10] | c[11] << 8; P4 = c[12] | c[13] << 8;
    P5 = c[14] | c[15] << 8; P6 = c[16] | c[17] << 8; P7 = c[18] | c[19] << 8; P8 = c[20] | c[21] << 8;
    P9 = c[22] | c[23] << 8; H1 = c[25];
    H2 = h[0] | h[1] << 8; H3 = h[2];
    H4 = (int16_t)((int8_t)h[3] * 16) | (h[4] & 0x0F);
    H5 = (int16_t)((int8_t)h[5] * 16) | (h[4] >> 4);
    H6 = (int8_t)h[6];
}
