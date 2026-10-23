// G-12 M5Unified PDM mic sample order on classic ESP32: record 0.1 s of a rising sawtooth (tools/audio/saw50.wav).
// M5Unified moves its DC offset once per sample pair, so order shows within pairs: rising when in order.
#include <M5Unified.h>

static int16_t buf[1600];

void setup() {
  Serial.begin(115200);
  auto cfg = M5.config();
  M5.begin(cfg);
  // Unity gain and no smoothing, so recorded steps follow the source
  auto mc = M5.Mic.config();
  mc.magnification = 1;
  mc.noise_filter_level = 0;
  M5.Mic.config(mc);
  M5.Speaker.end();
  M5.Mic.begin();
  M5.Mic.record(buf, 1600, 16000);
  while (M5.Mic.isRecording()) delay(1);
  // Skip the first half: the DMA ring may still hold samples from before the tone
  int rising = 0;
  for (int i = 800; i < 1600; i += 2) {
    if (buf[i + 1] > buf[i]) rising++;
  }
  Serial.printf("ORDER board=%d first8=", (int)M5.getBoard());
  for (int i = 800; i < 808; i++) Serial.printf("%d%s", buf[i], i < 807 ? "," : "\n");
  Serial.printf("ORDER rising pairs=%d of 400 -> %s\n", rising, rising > 360 ? "in order" : "pairs swapped");
  Serial.println("TRYBOARD_OK m5-mic-order");
}

void loop() { delay(100); }
