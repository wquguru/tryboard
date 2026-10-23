// G-13 M5Dial buzzer: M5Unified drives G3 as 1-bit delta-sigma over I2S DOUT; back-to-back 2 kHz beeps keep the last second busy.
#include <M5Unified.h>

void setup() {
  auto cfg = M5.config();
  M5.begin(cfg);
  Serial.begin(115200);
  M5.Speaker.setVolume(128);
  Serial.printf("TONE ready board=%d speaker=%d\n", (int)M5.getBoard(), (int)M5.Speaker.isEnabled());
}

void loop() {
  static int n = 0;
  M5.Speaker.tone(2000, 200);
  if (++n == 8) Serial.println("TRYBOARD_OK m5-dial-tone");
  delay(200);
}
