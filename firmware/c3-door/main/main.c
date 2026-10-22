// G-03 RFID door (ESP32-C3): RC522 on SPI2 (SCK4 MISO5 MOSI6 CS7 RST3, driver as in c3-rc522), SH1106 OLED on
// I2C SDA2 SCL9 (6 / 7 are SPI, 8 is the DevKitM-1 RGB LED), relay IN GPIO10 (door strike), passive buzzer GPIO1 (LEDC), red LED GPIO0.
#include <stdio.h>
#include <string.h>
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ssd1306_mini.h"

#define PIN_SCK 4
#define PIN_MISO 5
#define PIN_MOSI 6
#define PIN_CS 7
#define PIN_RST 3
#define PIN_SDA 2
#define PIN_SCL 9
#define OLED_ADDR 0x3C
#define RELAY_GPIO 10
#define BUZZER_GPIO 1
#define LED_GPIO 0
#define BUZZER_HZ 2700
#define UNLOCK_MS 3000
#define SHORT_BEEP_MS 100
#define LONG_BEEP_MS 800
#define LED_BLINKS 3
#define LED_HALF_MS 150
#define MAX_FAILS 3
#define LOCKOUT_MS 10000
#define POLL_MS 50
#define SH1106_COL0 2

static const uint8_t WHITELIST[][4] = {{0xDE, 0xAD, 0xBE, 0xEF}};

enum {
    CommandReg = 0x01, ComIrqReg = 0x04, DivIrqReg = 0x05, ErrorReg = 0x06, FIFODataReg = 0x09,
    FIFOLevelReg = 0x0A, ControlReg = 0x0C, BitFramingReg = 0x0D, ModeReg = 0x11, TxModeReg = 0x12,
    RxModeReg = 0x13, TxControlReg = 0x14, TxASKReg = 0x15, CRCResultRegH = 0x21, CRCResultRegL = 0x22,
    ModWidthReg = 0x24, TModeReg = 0x2A, TPrescalerReg = 0x2B, TReloadRegH = 0x2C, TReloadRegL = 0x2D,
    VersionReg = 0x37,
};
enum { CMD_IDLE = 0x00, CMD_CALCCRC = 0x03, CMD_TRANSCEIVE = 0x0C, CMD_SOFTRESET = 0x0F };

static spi_device_handle_t dev;

static void wr(uint8_t reg, uint8_t v)
{
    uint8_t tx[2] = {(uint8_t)(reg << 1), v};
    spi_transaction_t t = {.length = 16, .tx_buffer = tx};
    spi_device_polling_transmit(dev, &t);
}

static uint8_t rd(uint8_t reg)
{
    uint8_t tx[2] = {(uint8_t)(0x80 | reg << 1), 0}, rx[2] = {0};
    spi_transaction_t t = {.length = 16, .tx_buffer = tx, .rx_buffer = rx};
    spi_device_polling_transmit(dev, &t);
    return rx[1];
}

// Burst FIFO read in one transaction: the address byte repeated, 0 last
static void rd_fifo(uint8_t *out, int n)
{
    uint8_t tx[65], rx[65];
    for (int i = 0; i < n; i++) {
        tx[i] = 0x80 | FIFODataReg << 1;
    }
    tx[n] = 0;
    spi_transaction_t t = {.length = 8 * (n + 1), .tx_buffer = tx, .rx_buffer = rx};
    spi_device_polling_transmit(dev, &t);
    memcpy(out, rx + 1, n);
}

static void set_bits(uint8_t reg, uint8_t m)
{
    wr(reg, rd(reg) | m);
}

static int calc_crc(const uint8_t *d, int n, uint8_t out[2])
{
    wr(CommandReg, CMD_IDLE);
    wr(DivIrqReg, 0x04);
    wr(FIFOLevelReg, 0x80);
    for (int i = 0; i < n; i++) {
        wr(FIFODataReg, d[i]);
    }
    wr(CommandReg, CMD_CALCCRC);
    for (int i = 0; i < 100; i++) {
        if (rd(DivIrqReg) & 0x04) {
            wr(CommandReg, CMD_IDLE);
            out[0] = rd(CRCResultRegL);
            out[1] = rd(CRCResultRegH);
            return 0;
        }
    }
    return -1;
}

// Returns bytes received, -1 timeout (no card), -2 error
static int transceive(const uint8_t *d, int n, uint8_t bits, uint8_t *back, int max)
{
    wr(CommandReg, CMD_IDLE);
    wr(ComIrqReg, 0x7F);
    wr(FIFOLevelReg, 0x80);
    for (int i = 0; i < n; i++) {
        wr(FIFODataReg, d[i]);
    }
    wr(BitFramingReg, bits);
    wr(CommandReg, CMD_TRANSCEIVE);
    set_bits(BitFramingReg, 0x80);
    int irq = 0;
    for (int i = 0; i < 200; i++) {
        irq = rd(ComIrqReg);
        if (irq & 0x31) {
            break;
        }
    }
    wr(BitFramingReg, 0);
    if (!(irq & 0x30)) {
        return -1;
    }
    if (rd(ErrorReg) & 0x13) {
        return -2;
    }
    int len = rd(FIFOLevelReg);
    if (len > max) {
        return -2;
    }
    rd_fifo(back, len);
    return len;
}

static void rc522_init(void)
{
    wr(CommandReg, CMD_SOFTRESET);
    vTaskDelay(pdMS_TO_TICKS(50));
    while (rd(CommandReg) & 0x10) {
    }
    wr(TxModeReg, 0x00);
    wr(RxModeReg, 0x00);
    wr(ModWidthReg, 0x26);
    // Timer: TAuto, prescaler 0xA9 -> 40 kHz, reload 1000 -> 25 ms timeout
    wr(TModeReg, 0x80);
    wr(TPrescalerReg, 0xA9);
    wr(TReloadRegH, 0x03);
    wr(TReloadRegL, 0xE8);
    wr(TxASKReg, 0x40);
    wr(ModeReg, 0x3D);
    if ((rd(TxControlReg) & 0x03) != 0x03) {
        set_bits(TxControlReg, 0x03);
    }
}

// REQA (0x26) or WUPA (0x52), 7-bit frame; 0 when a card answered with a 2-byte ATQA
static int request(uint8_t c, uint8_t atqa[2])
{
    return transceive(&c, 1, 0x07, atqa, 2) == 2 ? 0 : -1;
}

// Anticollision + SELECT on every cascade level; returns UID length (4 / 7) or negative
static int select_card(uint8_t uid[10], uint8_t *sak_out)
{
    int len = 0;
    for (int lv = 0; lv < 2; lv++) {
        uint8_t sel = lv ? 0x95 : 0x93, f[9], back[5];
        f[0] = sel;
        f[1] = 0x20;
        if (transceive(f, 2, 0, back, 5) != 5) {
            return -1;
        }
        if ((back[0] ^ back[1] ^ back[2] ^ back[3]) != back[4]) {
            return -2;
        }
        f[1] = 0x70;
        memcpy(f + 2, back, 5);
        if (calc_crc(f, 7, f + 7)) {
            return -3;
        }
        uint8_t sak[3], c[2];
        if (transceive(f, 9, 0, sak, 3) != 3 || calc_crc(sak, 1, c) || c[0] != sak[1] || c[1] != sak[2]) {
            return -4;
        }
        if (back[0] == 0x88) {
            memcpy(uid + len, back + 1, 3);
            len += 3;
        } else {
            memcpy(uid + len, back, 4);
            len += 4;
        }
        if (!(sak[0] & 0x04)) {
            *sak_out = sak[0];
            return len;
        }
    }
    return -5;
}

static void halt(void)
{
    uint8_t f[4] = {0x50, 0x00}, back[4];
    calc_crc(f, 2, f + 2);
    transceive(f, 4, 0, back, 4);
}

static i2c_master_bus_handle_t bus;

static esp_err_t sh1106_init(void)
{
    static const uint8_t init[] = {0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0xAD, 0x8B, 0xA1, 0xC8,
                                   0xDA, 0x12, 0x81, 0xCF, 0xD9, 0x22, 0xDB, 0x35, 0xA4, 0xA6, 0xAF};
    return cmds(init, sizeof init);
}

// SH1106 RAM is 132 columns wide: page addressing from column 2, 128 bytes per page
static esp_err_t sh1106_flush(void)
{
    static uint8_t buf[1 + 128];
    for (int p = 0; p < 8; p++) {
        const uint8_t addr[] = {0xB0 | p, SH1106_COL0 & 0x0F, 0x10 | (SH1106_COL0 >> 4)};
        esp_err_t e = cmds(addr, sizeof addr);
        if (e != ESP_OK) return e;
        buf[0] = 0x40;
        memcpy(buf + 1, fb + p * 128, 128);
        e = i2c_master_transmit(oled, buf, sizeof buf, 100);
        if (e != ESP_OK) return e;
    }
    return ESP_OK;
}

// Big centred word with a small caption under it; 5x7 font is ASCII only, so the glass says WELCOME / DENIED
static void screen(const char *big, const char *small, int invert)
{
    memset(fb, 0, sizeof fb);
    text(4, 2, "RFID DOOR", 1);
    rect(0, 12, 128, 1, 1);
    int w = (int)strlen(big) * 12;
    text((128 - w) / 2, 22, big, 2);
    if (invert) {
        for (int y = 16; y < 42; y++)
            for (int x = 0; x < 128; x++) fb[(y / 8) * 128 + x] ^= 1 << (y & 7);
    }
    text((128 - (int)strlen(small) * 6) / 2, 50, small, 1);
    ESP_ERROR_CHECK(sh1106_flush());
}

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void buzzer(int on)
{
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, on ? 512 : 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

static void outputs_init(void)
{
    gpio_config_t out = {.pin_bit_mask = 1ULL << RELAY_GPIO | 1ULL << LED_GPIO | 1ULL << PIN_RST,
                         .mode = GPIO_MODE_OUTPUT};
    gpio_config(&out);
    gpio_set_level(RELAY_GPIO, 0);
    gpio_set_level(LED_GPIO, 0);
    gpio_set_level(PIN_RST, 1);
    ledc_timer_config_t tc = {.speed_mode = LEDC_LOW_SPEED_MODE, .duty_resolution = LEDC_TIMER_10_BIT,
                              .timer_num = LEDC_TIMER_0, .freq_hz = BUZZER_HZ, .clk_cfg = LEDC_AUTO_CLK};
    ESP_ERROR_CHECK(ledc_timer_config(&tc));
    ledc_channel_config_t ch = {.gpio_num = BUZZER_GPIO, .speed_mode = LEDC_LOW_SPEED_MODE,
                                .channel = LEDC_CHANNEL_0, .timer_sel = LEDC_TIMER_0, .duty = 0};
    ESP_ERROR_CHECK(ledc_channel_config(&ch));
}

static void bus_init(void)
{
    spi_bus_config_t sb = {.sclk_io_num = PIN_SCK, .mosi_io_num = PIN_MOSI, .miso_io_num = PIN_MISO,
                           .quadwp_io_num = -1, .quadhd_io_num = -1};
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &sb, SPI_DMA_CH_AUTO));
    spi_device_interface_config_t sd = {.clock_speed_hz = 4 * 1000 * 1000, .mode = 0, .spics_io_num = PIN_CS,
                                        .queue_size = 1};
    ESP_ERROR_CHECK(spi_bus_add_device(SPI2_HOST, &sd, &dev));
    i2c_master_bus_config_t bc = {.i2c_port = 0, .sda_io_num = PIN_SDA, .scl_io_num = PIN_SCL,
                                  .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7,
                                  .flags.enable_internal_pullup = true};
    ESP_ERROR_CHECK(i2c_new_master_bus(&bc, &bus));
    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = OLED_ADDR,
                              .scl_speed_hz = 400000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &oled));
    ESP_ERROR_CHECK(sh1106_init());
}

static int allowed(const uint8_t *uid, int n)
{
    for (int i = 0; i < (int)(sizeof WHITELIST / sizeof WHITELIST[0]); i++) {
        if (n == 4 && !memcmp(uid, WHITELIST[i], 4)) return 1;
    }
    return 0;
}

static void print_uid(const uint8_t *uid, int n)
{
    printf("读到卡 UID");
    for (int k = 0; k < n; k++) {
        printf("%s%02X", k ? ":" : " ", uid[k]);
    }
    printf(" (%d 字节)", n);
}

// Every output is a deadline checked by the poll loop, so a card is never missed while the door is open or beeping
static struct {
    int64_t open_at, open_until, beep_until, led_until, lock_until;
    int fails, shown_s;
} st;

static void on_card(const uint8_t *uid, int n, int64_t t)
{
    print_uid(uid, n);
    if (st.lock_until) {
        printf(" → 锁定中，不处理\n");
        return;
    }
    if (allowed(uid, n)) {
        printf(" → 欢迎，开锁\n");
        st.fails = 0;
        if (!st.open_until) {
            st.open_at = t;
            gpio_set_level(RELAY_GPIO, 1);
        }
        st.open_until = t + UNLOCK_MS;
        st.beep_until = t + SHORT_BEEP_MS;
        buzzer(1);
        screen("WELCOME", "door open 3 s", 1);
        return;
    }
    st.fails++;
    printf(" → 拒绝（连续第 %d 次）\n", st.fails);
    st.beep_until = t + LONG_BEEP_MS;
    st.led_until = t + LED_BLINKS * 2 * LED_HALF_MS;
    buzzer(1);
    if (st.fails >= MAX_FAILS) {
        printf("连续 %d 次拒绝，锁定 %d 秒\n", MAX_FAILS, LOCKOUT_MS / 1000);
        st.lock_until = t + LOCKOUT_MS;
        st.shown_s = -1;
    } else {
        char why[40];
        snprintf(why, sizeof why, "unknown card %d/%d", st.fails, MAX_FAILS);
        screen("DENIED", why, 0);
    }
}

static void tick(int64_t t)
{
    if (st.open_until && t >= st.open_until) {
        gpio_set_level(RELAY_GPIO, 0);
        int64_t held = t - st.open_at;
        printf("已上锁，开锁 %d.%02d 秒\n", (int)(held / 1000), (int)(held % 1000 / 10));
        st.open_until = 0;
        screen("LOCKED", "scan your card", 0);
    }
    if (st.beep_until && t >= st.beep_until) {
        buzzer(0);
        st.beep_until = 0;
    }
    if (st.led_until) {
        int on = t < st.led_until && (st.led_until - t - 1) / LED_HALF_MS % 2 == 1;
        gpio_set_level(LED_GPIO, on);
        if (t >= st.led_until) st.led_until = 0;
    }
    if (st.lock_until) {
        int left = (int)((st.lock_until - t + 999) / 1000);
        if (left <= 0) {
            printf("解除锁定\n");
            st.lock_until = 0;
            st.fails = 0;
            screen("LOCKED", "scan your card", 0);
        } else if (left != st.shown_s) {
            char s[24];
            snprintf(s, sizeof s, "wait %2d s", left);
            printf("锁定倒计时 %d 秒\n", left);
            screen("LOCKOUT", s, 1);
            st.shown_s = left;
        }
    }
}

void app_main(void)
{
    outputs_init();
    bus_init();
    rc522_init();
    uint8_t ver = rd(VersionReg);
    printf("RC522 版本 0x%02X 天线 %s\n", ver, (rd(TxControlReg) & 3) == 3 ? "开" : "关");
    printf("门禁启动：白名单 %d 张卡，继电器 GPIO%d，屏 SH1106 I2C 0x%02X\n",
           (int)(sizeof WHITELIST / sizeof WHITELIST[0]), RELAY_GPIO, OLED_ADDR);
    screen("LOCKED", ver == 0x92 ? "scan your card" : "RC522 missing", 0);
    if (ver == 0x92) {
        printf("TRYBOARD_OK c3-door\n");
    }
    int present = 0;
    uint8_t last[10];
    int last_len = 0;
    for (;;) {
        uint8_t atqa[2], uid[10], sak = 0;
        // A new card answers REQA; a halted one only answers WUPA, which is how removal is noticed
        if (request(present ? 0x52 : 0x26, atqa) == 0) {
            int n = select_card(uid, &sak);
            if (n > 0 && (!present || n != last_len || memcmp(uid, last, n))) {
                on_card(uid, n, now_ms());
                memcpy(last, uid, n);
                last_len = n;
            }
            present = n > 0;
            halt();
        } else if (present) {
            printf("卡已移开\n");
            present = 0;
        }
        tick(now_ms());
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
}
