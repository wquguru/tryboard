// F-04d: RC522 on SPI2 (Arduino default pins), hand-written driver with the usual register sequence: soft reset,
// timer, antenna on, REQA / anticollision / SELECT / HLTA. s3-rc522 builds this same file.
#include <stdio.h>
#include <string.h>
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "sdkconfig.h"

#if CONFIG_IDF_TARGET_ESP32S3
// Arduino S3 default SPI = the SPI2 IO_MUX pins, so CS goes through IO_MUX rather than the GPIO matrix
#define PIN_SCK 12
#define PIN_MISO 13
#define PIN_MOSI 11
#define PIN_CS 10
#define PIN_RST 9
#else
#define PIN_SCK 4
#define PIN_MISO 5
#define PIN_MOSI 6
#define PIN_CS 7
#define PIN_RST 3
#endif
#define RUN_POLLS 40

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

void app_main(void)
{
    // Module RST (NRSTPD) high = running
    gpio_config_t rst = {.pin_bit_mask = 1ULL << PIN_RST, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&rst);
    gpio_set_level(PIN_RST, 1);
    spi_bus_config_t bus = {.sclk_io_num = PIN_SCK, .mosi_io_num = PIN_MOSI, .miso_io_num = PIN_MISO,
                            .quadwp_io_num = -1, .quadhd_io_num = -1};
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));
    spi_device_interface_config_t dc = {.clock_speed_hz = 4 * 1000 * 1000, .mode = 0, .spics_io_num = PIN_CS,
                                        .queue_size = 1};
    ESP_ERROR_CHECK(spi_bus_add_device(SPI2_HOST, &dc, &dev));
    rc522_init();
    uint8_t ver = rd(VersionReg);
    printf("RC522 版本 0x%02X 天线 %s\n", ver, (rd(TxControlReg) & 3) == 3 ? "开" : "关");

    int present = 0, reads = 0;
    uint8_t last[10];
    int last_len = 0;
    for (int i = 0; i < RUN_POLLS; i++) {
        uint8_t atqa[2], uid[10], sak = 0;
        // A new card answers REQA; a halted one only answers WUPA, which is how removal is noticed
        int got = request(present ? 0x52 : 0x26, atqa);
        if (got == 0) {
            int n = select_card(uid, &sak);
            if (n > 0 && (!present || n != last_len || memcmp(uid, last, n))) {
                printf("读到卡 UID");
                for (int k = 0; k < n; k++) {
                    printf("%s%02X", k ? ":" : " ", uid[k]);
                }
                printf(" (%d 字节) SAK %02X ATQA %02X%02X\n", n, sak, atqa[0], atqa[1]);
                reads++;
                memcpy(last, uid, n);
                last_len = n;
            } else if (n <= 0) {
                printf("选卡失败 %d\n", n);
            }
            present = n > 0;
            halt();
        } else if (present) {
            printf("卡已移开\n");
            present = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    printf("RC522 读卡 %d 次\n", reads);
    if (ver == 0x92 && reads == 2) {
        printf("TRYBOARD_OK rc522\n");
    }
}
