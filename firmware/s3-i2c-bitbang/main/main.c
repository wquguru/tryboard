// M5-02 acceptance: one I2C bus on fixed pads (SDA=GPIO11, SCL=GPIO12, external pull-ups, like M5Dial's internal bus).
// 1) M5GFX-style pull test (pulldown on, external pull-up must still read 1), 2) bit-banged GPIO scan + register read,
// 3) the same with the i2c_master driver on I2C_NUM_1 (not the default port). Both address lists must match.
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_rom_sys.h"

#ifndef SDA
#define SDA 11
#endif
#ifndef SCL
#define SCL 12
#endif
#define BME_ADDR 0x76

// Pulldown on both lines: 1 only where a board pull-up wins (M5GFX _detect_i2c_device)
static int pull_test(int sda, int scl)
{
    int r = 0;
    int pins[2] = {sda, scl};
    for (int i = 0; i < 2; i++) {
        gpio_reset_pin(pins[i]);
        gpio_set_direction(pins[i], GPIO_MODE_INPUT);
        gpio_set_pull_mode(pins[i], GPIO_PULLDOWN_ONLY);
    }
    esp_rom_delay_us(10);
    for (int i = 0; i < 2; i++) r |= gpio_get_level(pins[i]) << i;
    for (int i = 0; i < 2; i++) gpio_set_pull_mode(pins[i], GPIO_FLOATING);
    return r;
}

// Open drain: writing 1 releases the line to the pull-up, 0 pulls it low
static void line(int pin, int v)
{
    gpio_set_level(pin, v);
    esp_rom_delay_us(5);
}

static void bb_start(void)
{
    line(SDA, 1);
    line(SCL, 1);
    line(SDA, 0);
    line(SCL, 0);
}

static void bb_stop(void)
{
    line(SDA, 0);
    line(SCL, 1);
    line(SDA, 1);
}

static int bb_bit(int b)
{
    line(SDA, b);
    line(SCL, 1);
    int v = gpio_get_level(SDA);
    line(SCL, 0);
    return v;
}

// Returns 1 when the byte is ACKed
static int bb_write(uint8_t v)
{
    for (int i = 7; i >= 0; i--) bb_bit((v >> i) & 1);
    return bb_bit(1) == 0;
}

static uint8_t bb_read(int ack)
{
    uint8_t v = 0;
    for (int i = 0; i < 8; i++) v = (v << 1) | bb_bit(1);
    bb_bit(!ack);
    return v;
}

static int bb_scan(uint8_t *found)
{
    int n = 0;
    for (int a = 0x08; a < 0x78; a++) {
        bb_start();
        if (bb_write(a << 1)) found[n++] = a;
        bb_stop();
    }
    return n;
}

static void print_list(const char *tag, const uint8_t *a, int n)
{
    printf("%s:", tag);
    for (int i = 0; i < n; i++) printf(" 0x%02X", a[i]);
    printf(n ? "\n" : " (none)\n");
}

void app_main(void)
{
    printf("pull test SDA%d/SCL%d = 0x%02X\n", SDA, SCL, pull_test(SDA, SCL));
    printf("pull test SDA4/SCL5 = 0x%02X\n", pull_test(4, 5));

    gpio_config_t io = {
        .pin_bit_mask = (1ULL << SDA) | (1ULL << SCL),
        .mode = GPIO_MODE_INPUT_OUTPUT_OD,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
    };
    gpio_config(&io);
    gpio_set_level(SDA, 1);
    gpio_set_level(SCL, 1);
    // M5GFX sends a few STOPs first so a half-finished transfer releases SDA
    for (int i = 0; i < 4; i++) bb_stop();

    uint8_t sw[128], hw[128];
    int nsw = bb_scan(sw);
    print_list("bitbang scan", sw, nsw);

    bb_start();
    int ok = bb_write(BME_ADDR << 1) && bb_write(0xD0);
    bb_start();
    ok = ok && bb_write(BME_ADDR << 1 | 1);
    uint8_t id_sw = ok ? bb_read(0) : 0;
    bb_stop();
    printf("bitbang BME280 id 0x%02X\n", id_sw);

    i2c_master_bus_config_t bc = {
        .i2c_port = I2C_NUM_1,
        .sda_io_num = SDA,
        .scl_io_num = SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
    };
    i2c_master_bus_handle_t bus;
    ESP_ERROR_CHECK(i2c_new_master_bus(&bc, &bus));
    int nhw = 0;
    for (int a = 0x08; a < 0x78; a++)
        if (i2c_master_probe(bus, a, 50) == ESP_OK) hw[nhw++] = a;
    print_list("I2C1 scan", hw, nhw);

    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = BME_ADDR, .scl_speed_hz = 100000};
    i2c_master_dev_handle_t bme;
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &bme));
    uint8_t reg = 0xD0, id_hw = 0;
    // No ESP_ERROR_CHECK: without the bus wired this must print FAIL, not reboot
    if (i2c_master_transmit_receive(bme, &reg, 1, &id_hw, 1, 100) != ESP_OK) id_hw = 0;
    printf("I2C1 BME280 id 0x%02X\n", id_hw);

    // Hand the pads back to GPIO after the controller: bit-bang must still see the same bus
    ESP_ERROR_CHECK(i2c_master_bus_rm_device(bme));
    ESP_ERROR_CHECK(i2c_del_master_bus(bus));
    gpio_config(&io);
    gpio_set_level(SDA, 1);
    gpio_set_level(SCL, 1);
    uint8_t again[128];
    int nagain = bb_scan(again);
    print_list("bitbang rescan", again, nagain);

    int same = nsw == nhw && nsw > 0 && memcmp(sw, hw, nsw) == 0 && nagain == nsw && memcmp(sw, again, nsw) == 0;
    if (same && id_sw == 0x60 && id_hw == 0x60)
        printf("TRYBOARD_OK i2c-bitbang\n");
    else
        printf("TRYBOARD_FAIL i2c-bitbang\n");
    for (;;) vTaskDelay(pdMS_TO_TICKS(1000));
}
