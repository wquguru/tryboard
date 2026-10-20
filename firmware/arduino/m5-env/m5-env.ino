// M5-09 Grove Unit ENV III (SHT30 + QMP6988) / ENV IV (SHT40 + BMP280) on Port A, plain Wire reads (no unit library).
// Detects the unit by chip id, prints `ENV3 t=.. h=.. p=..` / `ENV4 ...` twice a second (t, h from the SHT, p in hPa).
#include <M5Unified.h>
#include <Wire.h>

static const uint8_t SHT = 0x44, QMP = 0x70, BMP = 0x76;
static int unit = 0;  // 3 = ENV III, 4 = ENV IV

static uint8_t crc8(const uint8_t *d, int n) {
  uint8_t c = 0xff;
  for (int i = 0; i < n; i++) {
    c ^= d[i];
    for (int b = 0; b < 8; b++) c = (c & 0x80) ? (c << 1) ^ 0x31 : c << 1;
  }
  return c;
}

static bool reg_read(uint8_t addr, uint8_t reg, uint8_t *buf, int n) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(addr, (uint8_t)n) != n) return false;
  for (int i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

static void reg_write(uint8_t addr, uint8_t reg, uint8_t v) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(v);
  Wire.endTransmission();
}

static bool sht_cmd(const uint8_t *cmd, int n) {
  Wire.beginTransmission(SHT);
  Wire.write(cmd, n);
  return Wire.endTransmission() == 0;
}

// Two CRC-checked words; polls while the sensor NACKs the read header (still measuring)
static bool sht_words(uint16_t *w0, uint16_t *w1) {
  uint8_t b[6];
  for (int tries = 0; tries < 20; tries++) {
    if (Wire.requestFrom(SHT, (uint8_t)6) == 6) {
      for (int i = 0; i < 6; i++) b[i] = Wire.read();
      if (crc8(b, 2) != b[2] || crc8(b + 3, 2) != b[5]) return false;
      *w0 = (b[0] << 8) | b[1];
      *w1 = (b[3] << 8) | b[4];
      return true;
    }
    delay(2);
  }
  return false;
}

// QMP6988 OTP -> datasheet floating-point coefficients (A + S * OTP / 32767)
static double qa0, qa1, qa2, qb00, qbt1, qbt2, qbp1, qb11, qbp2, qb12, qb21, qbp3;

static bool qmp_init() {
  uint8_t o[25];
  reg_write(QMP, 0xe0, 0xe6);  // soft reset
  delay(20);
  reg_write(QMP, 0xe0, 0x00);
  if (!reg_read(QMP, 0xa0, o, 25)) return false;
  auto w = [&](int i) { return (double)(int16_t)((o[i] << 8) | o[i + 1]); };
  auto s20 = [](int32_t v) { return (double)((int32_t)((uint32_t)v << 12) >> 12); };
  qb00 = s20((o[0] << 12) | (o[1] << 4) | (o[24] >> 4)) / 16.0;
  qa0 = s20((o[18] << 12) | (o[19] << 4) | (o[24] & 0x0f)) / 16.0;
  auto k = [](double a, double s, double v) { return a + s * v / 32767.0; };
  qbt1 = k(1.0e-1, 9.1e-2, w(2));
  qbt2 = k(1.2e-8, 1.2e-6, w(4));
  qbp1 = k(3.3e-2, 1.9e-2, w(6));
  qb11 = k(2.1e-7, 1.4e-7, w(8));
  qbp2 = k(-6.3e-10, 3.5e-10, w(10));
  qb12 = k(2.9e-13, 7.6e-13, w(12));
  qb21 = k(2.1e-15, 1.2e-14, w(14));
  qbp3 = k(1.3e-16, 7.9e-17, w(16));
  qa1 = k(-6.3e-3, 4.3e-4, w(20));
  qa2 = k(-1.9e-11, 1.2e-10, w(22));
  reg_write(QMP, 0xf5, 0x20);  // 5 ms standby
  reg_write(QMP, 0xf4, (1 << 5) | (4 << 2) | 3);  // T x1, P x8, normal mode
  return true;
}

static bool qmp_read(double *t, double *p) {
  uint8_t b[6];
  if (!reg_read(QMP, 0xf7, b, 6)) return false;
  double dp = (double)(int32_t)(((uint32_t)b[0] << 16 | b[1] << 8 | b[2]) - 8388608);
  double dt = (double)(int32_t)(((uint32_t)b[3] << 16 | b[4] << 8 | b[5]) - 8388608);
  double tr = qa0 + qa1 * dt + qa2 * dt * dt;  // 1/256 degC
  *t = tr / 256.0;
  *p = qb00 + qbt1 * tr + qbp1 * dp + qb11 * dp * tr + qbt2 * tr * tr + qbp2 * dp * dp + qb12 * dp * tr * tr +
       qb21 * dp * dp * tr + qbp3 * dp * dp * dp;
  return true;
}

// BMP280 calibration and the datasheet's double-precision compensation (section 8.1)
static double T1, T2, T3, P[10];

static bool bmp_init() {
  uint8_t c[24];
  reg_write(BMP, 0xe0, 0xb6);
  delay(5);
  if (!reg_read(BMP, 0x88, c, 24)) return false;
  T1 = (uint16_t)(c[1] << 8 | c[0]);
  T2 = (int16_t)(c[3] << 8 | c[2]);
  T3 = (int16_t)(c[5] << 8 | c[4]);
  P[1] = (uint16_t)(c[7] << 8 | c[6]);
  for (int i = 2; i <= 9; i++) P[i] = (int16_t)(c[2 * i + 5] << 8 | c[2 * i + 4]);
  reg_write(BMP, 0xf5, 0x00);
  reg_write(BMP, 0xf4, (1 << 5) | (1 << 2) | 3);  // T x1, P x1, normal mode
  return true;
}

static bool bmp_read(double *t, double *p) {
  uint8_t b[6];
  if (!reg_read(BMP, 0xf7, b, 6)) return false;
  double ap = (double)((b[0] << 12) | (b[1] << 4) | (b[2] >> 4));
  double at = (double)((b[3] << 12) | (b[4] << 4) | (b[5] >> 4));
  double v1 = (at / 16384.0 - T1 / 1024.0) * T2;
  double v2 = (at / 131072.0 - T1 / 8192.0) * (at / 131072.0 - T1 / 8192.0) * T3;
  double tf = v1 + v2;
  *t = tf / 5120.0;
  v1 = tf / 2.0 - 64000.0;
  v2 = v1 * v1 * P[6] / 32768.0 + v1 * P[5] * 2.0;
  v2 = v2 / 4.0 + P[4] * 65536.0;
  v1 = (P[3] * v1 * v1 / 524288.0 + P[2] * v1) / 524288.0;
  v1 = (1.0 + v1 / 32768.0) * P[1];
  if (v1 == 0) return false;
  double pp = 1048576.0 - ap;
  pp = (pp - v2 / 4096.0) * 6250.0 / v1;
  *p = pp + (P[9] * pp * pp / 2147483648.0 + pp * P[8] / 32768.0 + P[7]) / 16.0;
  return true;
}

void setup() {
  Serial.begin(115200);
  auto cfg = M5.config();
  M5.begin(cfg);
  int sda = M5.getPin(m5::pin_name_t::port_a_sda), scl = M5.getPin(m5::pin_name_t::port_a_scl);
  Wire.begin(sda, scl, 100000);
  uint8_t id = 0;
  if (reg_read(QMP, 0xd1, &id, 1) && id == 0x5c) unit = 3;
  else if (reg_read(BMP, 0xd0, &id, 1) && id == 0x58) unit = 4;
  uint16_t s0 = 0, s1 = 0;
  bool ok = false;
  if (unit == 3) {
    static const uint8_t reset[] = {0x30, 0xa2}, serial[] = {0x37, 0x80};
    sht_cmd(reset, 2);
    delay(2);
    ok = sht_cmd(serial, 2) && sht_words(&s0, &s1) && qmp_init();
  } else if (unit == 4) {
    static const uint8_t reset[] = {0x94}, serial[] = {0x89};
    sht_cmd(reset, 1);
    delay(2);
    ok = sht_cmd(serial, 1) && (delay(1), sht_words(&s0, &s1)) && bmp_init();
  }
  Serial.printf("ENV ready unit=%d port_a=%d/%d sht_serial=%04x%04x init=%s\n", unit, sda, scl, s0, s1,
                ok ? "ok" : "fail");
  M5.Display.setTextSize(2);
}

void loop() {
  M5.update();
  uint16_t st = 0, srh = 0;
  double t = 0, h = 0, bt = 0, p = 0;
  bool ok = false;
  if (unit == 3) {
    static const uint8_t single[] = {0x2c, 0x06};  // high repeatability, clock stretching
    ok = sht_cmd(single, 2) && (delay(16), sht_words(&st, &srh)) && qmp_read(&bt, &p);
    h = 100.0 * srh / 65535.0;
  } else if (unit == 4) {
    static const uint8_t high[] = {0xfd};
    ok = sht_cmd(high, 1) && (delay(9), sht_words(&st, &srh)) && bmp_read(&bt, &p);
    h = -6.0 + 125.0 * srh / 65535.0;
    h = h < 0 ? 0 : (h > 100 ? 100 : h);
  }
  t = -45.0 + 175.0 * st / 65535.0;
  if (unit == 0) {
    Serial.println("ENV no unit on Port A");
  } else if (!ok) {
    Serial.printf("ENV%d read error\n", unit);
  } else {
    Serial.printf("ENV%d t=%.1f h=%.1f p=%.1f bt=%.1f\n", unit, t, h, p / 100.0, bt);
    M5.Display.fillScreen(TFT_BLACK);
    M5.Display.setCursor(4, 8);
    M5.Display.printf("ENV%d\n%.1fC\n%.1f%%\n%.1fhPa", unit, t, h, p / 100.0);
  }
  delay(500);
}
