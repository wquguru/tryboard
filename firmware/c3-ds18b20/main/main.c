// F-04c acceptance: DS18B20 thermometers on one 1-Wire bus (GPIO4), hand-written bit-bang driver.
// Slot timing follows Maxim AN126 (standard speed); ROM search follows the AN187 algorithm description.
#include <stdio.h>
#include <string.h>
#include "driver/gpio.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define OW_GPIO 4
#define MAX_DEVS 8
#define ROUNDS 10

static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

// Open drain: writing 1 releases the line to the pull-up
static int ow_reset(void)
{
    portENTER_CRITICAL(&mux);
    gpio_set_level(OW_GPIO, 0);
    esp_rom_delay_us(480);
    gpio_set_level(OW_GPIO, 1);
    esp_rom_delay_us(70);
    int present = gpio_get_level(OW_GPIO) == 0;
    portEXIT_CRITICAL(&mux);
    esp_rom_delay_us(410);
    return present;
}

static void ow_write_bit(int b)
{
    portENTER_CRITICAL(&mux);
    gpio_set_level(OW_GPIO, 0);
    esp_rom_delay_us(b ? 6 : 60);
    gpio_set_level(OW_GPIO, 1);
    esp_rom_delay_us(b ? 64 : 10);
    portEXIT_CRITICAL(&mux);
}

static int ow_read_bit(void)
{
    portENTER_CRITICAL(&mux);
    gpio_set_level(OW_GPIO, 0);
    esp_rom_delay_us(6);
    gpio_set_level(OW_GPIO, 1);
    esp_rom_delay_us(9);
    int b = gpio_get_level(OW_GPIO);
    esp_rom_delay_us(55);
    portEXIT_CRITICAL(&mux);
    return b;
}

static void ow_write(uint8_t v)
{
    for (int i = 0; i < 8; i++) {
        ow_write_bit(v >> i & 1);
    }
}

static uint8_t ow_read(void)
{
    uint8_t v = 0;
    for (int i = 0; i < 8; i++) {
        v |= ow_read_bit() << i;
    }
    return v;
}

// CRC-8/MAXIM, x^8 + x^5 + x^4 + 1 (reflected 0x8C); a block followed by its CRC sums to 0
static uint8_t crc8(const uint8_t *p, int n)
{
    uint8_t crc = 0;
    while (n--) {
        uint8_t b = *p++;
        for (int i = 0; i < 8; i++) {
            uint8_t mix = (crc ^ b) & 1;
            crc >>= 1;
            if (mix) {
                crc ^= 0x8C;
            }
            b >>= 1;
        }
    }
    return crc;
}

// ROM search state: the last bit position where 0 was taken at a conflict (0 = none left)
static uint8_t s_rom[8];
static int s_last_conflict;
static int s_done;

// Next device: 1 = found into rom, 0 = no more, -1 = bus error or bad CRC
static int ow_search(uint8_t rom[8])
{
    if (s_done || !ow_reset()) {
        return 0;
    }
    ow_write(0xF0);
    int zero_at = 0;
    for (int i = 1; i <= 64; i++) {
        int b = ow_read_bit(), c = ow_read_bit();
        if (b && c) {
            return -1;
        }
        int dir;
        if (b != c) {
            dir = b;
        } else {
            // Conflict: repeat earlier choices, take 1 at the last conflict, 0 at new ones
            dir = i < s_last_conflict ? (s_rom[(i - 1) / 8] >> ((i - 1) % 8) & 1) : i == s_last_conflict;
            if (!dir) {
                zero_at = i;
            }
        }
        if (dir) {
            s_rom[(i - 1) / 8] |= 1 << ((i - 1) % 8);
        } else {
            s_rom[(i - 1) / 8] &= ~(1 << ((i - 1) % 8));
        }
        ow_write_bit(dir);
    }
    s_last_conflict = zero_at;
    s_done = zero_at == 0;
    if (crc8(s_rom, 8) != 0) {
        return -1;
    }
    memcpy(rom, s_rom, 8);
    return 1;
}

static int select_dev(const uint8_t rom[8])
{
    if (!ow_reset()) {
        return 0;
    }
    ow_write(0x55);
    for (int i = 0; i < 8; i++) {
        ow_write(rom[i]);
    }
    return 1;
}

// Scratchpad of one device; 0 = ok
static int read_scratch(const uint8_t rom[8], uint8_t s[9])
{
    if (!select_dev(rom)) {
        return -1;
    }
    ow_write(0xBE);
    for (int i = 0; i < 9; i++) {
        s[i] = ow_read();
    }
    return crc8(s, 9) ? -2 : 0;
}

// Raw 1/16 °C as "-10.1250"
static void fmt_temp(char *buf, int raw)
{
    int a = raw < 0 ? -raw : raw;
    sprintf(buf, "%s%d.%04d", raw < 0 ? "-" : "", a >> 4, (a & 15) * 625);
}

static void fmt_rom(char *buf, const uint8_t rom[8])
{
    for (int i = 0; i < 8; i++) {
        sprintf(buf + 2 * i, "%02X", rom[i]);
    }
}

void app_main(void)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << OW_GPIO,
        .mode = GPIO_MODE_INPUT_OUTPUT_OD,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&io);
    gpio_set_level(OW_GPIO, 1);
    printf("DS18B20 启动，单总线 GPIO%d\n", OW_GPIO);
    vTaskDelay(pdMS_TO_TICKS(100));
    if (!ow_reset()) {
        printf("错误: GPIO%d 上没有存在脉冲，未检测到 DS18B20（检查接线和 4.7k 上拉）\n", OW_GPIO);
        return;
    }
    uint8_t roms[MAX_DEVS][8];
    int n = 0, r;
    char txt[24];
    while (n < MAX_DEVS && (r = ow_search(roms[n])) == 1) {
        fmt_rom(txt, roms[n]);
        printf("找到设备 %d ROM %s\n", n + 1, txt);
        n++;
    }
    if (r < 0) {
        printf("搜索 ROM 出错\n");
    }
    printf("总线上共 %d 个 DS18B20\n", n);
    if (n == 0) {
        return;
    }
    // READ POWER SUPPLY: 0 means some device is parasite powered
    ow_reset();
    ow_write(0xCC);
    ow_write(0xB4);
    printf("供电方式: %s\n", ow_read_bit() ? "外部供电" : "寄生供电");
    uint8_t s[9];
    if (read_scratch(roms[0], s) == 0) {
        fmt_temp(txt, (int16_t)(s[0] | s[1] << 8));
        printf("上电默认值 %s 配置 0x%02X\n", txt, s[4]);
    }
    int ok = 0, conv_ok = 0, raws[MAX_DEVS] = {0};
    for (int k = 1; k <= ROUNDS; k++) {
        // Convert all at once (SKIP ROM), then poll the busy bit like DallasTemperature's isConversionComplete
        ow_reset();
        ow_write(0xCC);
        ow_write(0x44);
        int64_t t0 = esp_timer_get_time();
        while (!ow_read_bit() && esp_timer_get_time() - t0 < 2000000) {
            vTaskDelay(1);
        }
        int ms = (int)((esp_timer_get_time() - t0) / 1000);
        conv_ok += ms >= 740 && ms <= 800;
        for (int i = 0; i < n; i++) {
            int e = read_scratch(roms[i], s);
            if (e) {
                printf("第 %d 轮 设备 %d 读取失败 %d\n", k, i + 1, e);
                continue;
            }
            ok++;
            raws[i] = (int16_t)(s[0] | s[1] << 8);
            if (k == 1 || k == ROUNDS) {
                fmt_temp(txt, raws[i]);
                printf("第 %d 轮 设备 %d 温度 %s 转换 %d ms\n", k, i + 1, txt, ms);
            }
        }
    }
    for (int i = 0; i < n; i++) {
        fmt_temp(txt, raws[i]);
        printf("设备 %d 温度 %s °C\n", i + 1, txt);
    }
    printf("校验通过 %d/%d 转换时间正常 %d/%d\n", ok, n * ROUNDS, conv_ok, ROUNDS);
    if (ok == n * ROUNDS && conv_ok == ROUNDS) {
        printf("TRYBOARD_OK ds18b20\n");
    }
}
