// F-08f: NEC IR transmitter on the core's RMT driver only (no third-party library), IR LED on GPIO4.
// Written from the public NEC timing: 38 kHz carrier, 9 ms + 4.5 ms leader, 560 us marks, LSB first.

const int IR_PIN = 4;
const uint32_t TICK_HZ = 1000000;  // 1 us per RMT tick
const uint8_t ADDR = 0x00;
const uint8_t CMD = 0x36;

// Leader + 32 data bits + trailing mark
rmt_data_t frame[34];

static rmt_data_t mark_space(uint16_t mark_us, uint16_t space_us) {
  rmt_data_t s;
  s.level0 = 1;
  s.duration0 = mark_us;
  s.level1 = 0;
  s.duration1 = space_us;
  return s;
}

static size_t build_nec(uint8_t addr, uint8_t cmd) {
  size_t n = 0;
  frame[n++] = mark_space(9000, 4500);
  uint32_t bits = addr | (uint32_t)(uint8_t)~addr << 8 | (uint32_t)cmd << 16 | (uint32_t)(uint8_t)~cmd << 24;
  for (int i = 0; i < 32; i++) {
    frame[n++] = mark_space(560, (bits >> i) & 1 ? 1690 : 560);
  }
  // Zero space duration ends the transmission right after the trailing mark
  frame[n++] = mark_space(560, 0);
  return n;
}

void setup() {
  Serial.begin(115200);
  delay(100);
  if (!rmtInit(IR_PIN, RMT_TX_MODE, RMT_MEM_NUM_BLOCKS_1, TICK_HZ)) {
    Serial.println("rmtInit failed");
    return;
  }
  // The core maps carrier_level=true to an active-low carrier, so false modulates the high marks
  rmtSetCarrier(IR_PIN, true, false, 38000, 0.33);
  size_t n = build_nec(ADDR, CMD);
  Serial.printf("ir nec frame: %u symbols, leader 9000/4500 us, bit 560 us, 38 kHz carrier\n", (unsigned)n);
  for (int k = 0; k < 2; k++) {
    if (!rmtWrite(IR_PIN, frame, n, 200)) {
      Serial.println("rmtWrite failed");
      return;
    }
    Serial.printf("ir sent NEC addr=0x%02X cmd=0x%02X\n", ADDR, CMD);
    delay(108 - 68);
  }
  Serial.println("TRYBOARD_OK ir-nec-rmt");
}

void loop() { delay(1000); }
