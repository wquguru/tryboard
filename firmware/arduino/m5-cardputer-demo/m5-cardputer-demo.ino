// M5-08 Cardputer / Cardputer-Adv demo: keys typed on the built-in keyboard are echoed on the screen and on Serial,
// then the microphone records 0.1 s and prints its RMS. Only M5Unified / M5GFX (no M5Cardputer library): the
// Cardputer matrix (74HC138 on G8 / G9 / G11, columns G13 G15 G3..G7) is scanned here, the Adv's TCA8418 is polled.
#include <M5Unified.h>

// 4 x 14 legend; the row / column maps below match core/crates/machine/src/keyboard.rs
static const char *const LEGEND[4][14] = {
    {"`", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=", "bksp"},
    {"tab", "q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "[", "]", "\\"},
    {"fn", "shift", "a", "s", "d", "f", "g", "h", "j", "k", "l", ";", "'", "enter"},
    {"ctrl", "opt", "alt", "z", "x", "c", "v", "b", "n", "m", ",", ".", "/", "space"},
};

static const int SEL[3] = {8, 9, 11};
static const int COLS[7] = {13, 15, 3, 4, 5, 6, 7};
static const uint8_t TCA = 0x34;
static const uint32_t I2C_HZ = 400000;

static bool adv = false;
static bool down[4][14];
static String text;
static int mic_rms = -1;

static void matrix_begin() {
  for (int p : SEL) pinMode(p, OUTPUT);
  for (int p : COLS) pinMode(p, INPUT_PULLUP);
}

static void tca_begin() {
  M5.In_I2C.writeRegister8(TCA, 0x1D, 0xFF, I2C_HZ);  // rows 0..7 in the matrix
  M5.In_I2C.writeRegister8(TCA, 0x1E, 0x7F, I2C_HZ);  // cols 0..6
  M5.In_I2C.writeRegister8(TCA, 0x1F, 0x00, I2C_HZ);
  M5.In_I2C.writeRegister8(TCA, 0x01, 0x01, I2C_HZ);  // KE_IEN
}

static void draw() {
  auto &d = M5.Display;
  d.startWrite();
  d.fillScreen(TFT_BLACK);
  d.setTextColor(TFT_GREEN, TFT_BLACK);
  d.setTextSize(2);
  d.setCursor(4, 4);
  d.print(adv ? "Cardputer-Adv" : "Cardputer");
  d.setTextColor(TFT_WHITE, TFT_BLACK);
  d.setCursor(4, 40);
  d.print("> ");
  d.print(text);
  if (mic_rms >= 0) {
    d.setTextColor(TFT_YELLOW, TFT_BLACK);
    d.setCursor(4, 100);
    d.printf("mic rms %d", mic_rms);
  }
  d.endWrite();
}

static void on_key(int r, int c, bool pressed) {
  if (down[r][c] == pressed) return;
  down[r][c] = pressed;
  const char *name = LEGEND[r][c];
  Serial.printf("CARDPUTER key=%s %s\n", name, pressed ? "down" : "up");
  if (!pressed) return;
  if (!strcmp(name, "space")) text += ' ';
  else if (!strcmp(name, "bksp")) { if (text.length()) text.remove(text.length() - 1); }
  else if (!strcmp(name, "enter")) {
    Serial.printf("CARDPUTER line=%s\n", text.c_str());
    text = "";
  } else if (strlen(name) == 1) text += name;
  Serial.printf("CARDPUTER text=%s\n", text.c_str());
  draw();
}

static void matrix_scan() {
  bool now[4][14] = {};
  for (int row = 0; row < 8; row++) {
    for (int i = 0; i < 3; i++) digitalWrite(SEL[i], (row >> i) & 1);
    for (int col = 0; col < 7; col++) {
      if (digitalRead(COLS[col]) == LOW) now[3 - (row & 3)][2 * col + (row >= 4 ? 0 : 1)] = true;
    }
  }
  for (int r = 0; r < 4; r++)
    for (int c = 0; c < 14; c++) on_key(r, c, now[r][c]);
}

static void tca_poll() {
  int n = M5.In_I2C.readRegister8(TCA, 0x03, I2C_HZ) & 0x0F;
  for (int i = 0; i < n; i++) {
    uint8_t ev = M5.In_I2C.readRegister8(TCA, 0x04, I2C_HZ);
    int k = (ev & 0x7F) - 1;
    if (k < 0) continue;
    int trow = k / 10, tcol = k % 10;
    if (trow < 8 && tcol < 7) on_key(trow / 2, (trow % 2) * 7 + tcol, ev & 0x80);
  }
  if (n) M5.In_I2C.writeRegister8(TCA, 0x02, 0x01, I2C_HZ);
}

static void mic_test() {
  static int16_t buf[1600];
  M5.Speaker.end();
  if (!M5.Mic.begin()) {
    Serial.println("CARDPUTER mic begin failed");
    return;
  }
  // First block may hold the filter's start-up; measure the second
  for (int pass = 0; pass < 2; pass++) {
    M5.Mic.record(buf, 1600, 16000);
    while (M5.Mic.isRecording()) delay(1);
  }
  double acc = 0;
  int lo = 0, hi = 0;
  for (int16_t s : buf) {
    acc += (double)s * s;
    lo = s < lo ? s : lo;
    hi = s > hi ? s : hi;
  }
  mic_rms = (int)sqrt(acc / 1600);
  M5.Mic.end();
  // min / max show a waveform rather than a stuck level
  Serial.printf("CARDPUTER mic rms=%d min=%d max=%d\n", mic_rms, lo, hi);
}

void setup() {
  Serial.begin(115200);
  auto cfg = M5.config();
  M5.begin(cfg);
  adv = M5.getBoard() == m5::board_t::board_M5CardputerADV;
  if (adv) tca_begin();
  else matrix_begin();
  Serial.printf("CARDPUTER ready board=%d display=%dx%d keyboard=%s\n", (int)M5.getBoard(), (int)M5.Display.width(),
                (int)M5.Display.height(), adv ? "tca8418" : "74hc138");
  draw();
}

void loop() {
  static uint32_t t0 = millis();
  static bool mic_done = false;
  if (adv) tca_poll();
  else matrix_scan();
  if (!mic_done && millis() - t0 > 3000) {
    mic_done = true;
    mic_test();
    draw();
  }
  delay(10);
}
