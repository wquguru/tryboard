// M5-05 M5Dial demo: encoder detents, touch point, RTC time and BtnA on the round screen and on Serial.
// Only M5Unified / M5GFX (no M5Dial library): the encoder is read with the IDF pulse counter on G40 / G41.
#include <M5Unified.h>
#include "driver/pulse_cnt.h"

static const int ENC_A = 40, ENC_B = 41;
static pcnt_unit_handle_t unit;

// Quadrature x4 as in IDF peripherals/pcnt/rotary_encoder: 4 counts per detent
static void encoder_begin() {
  pcnt_unit_config_t uc = {};
  uc.high_limit = 100;
  uc.low_limit = -100;
  uc.flags.accum_count = 1;
  pcnt_new_unit(&uc, &unit);
  pcnt_glitch_filter_config_t f = {.max_glitch_ns = 1000};
  pcnt_unit_set_glitch_filter(unit, &f);
  pcnt_chan_config_t ac = {}, bc = {};
  ac.edge_gpio_num = ENC_A;
  ac.level_gpio_num = ENC_B;
  bc.edge_gpio_num = ENC_B;
  bc.level_gpio_num = ENC_A;
  pcnt_channel_handle_t ca, cb;
  pcnt_new_channel(unit, &ac, &ca);
  pcnt_new_channel(unit, &bc, &cb);
  pcnt_channel_set_edge_action(ca, PCNT_CHANNEL_EDGE_ACTION_DECREASE, PCNT_CHANNEL_EDGE_ACTION_INCREASE);
  pcnt_channel_set_level_action(ca, PCNT_CHANNEL_LEVEL_ACTION_KEEP, PCNT_CHANNEL_LEVEL_ACTION_INVERSE);
  pcnt_channel_set_edge_action(cb, PCNT_CHANNEL_EDGE_ACTION_INCREASE, PCNT_CHANNEL_EDGE_ACTION_DECREASE);
  pcnt_channel_set_level_action(cb, PCNT_CHANNEL_LEVEL_ACTION_KEEP, PCNT_CHANNEL_LEVEL_ACTION_INVERSE);
  pcnt_unit_add_watch_point(unit, 100);
  pcnt_unit_add_watch_point(unit, -100);
  pcnt_unit_enable(unit);
  pcnt_unit_clear_count(unit);
  pcnt_unit_start(unit);
}

static int detents() {
  int c = 0;
  pcnt_unit_get_count(unit, &c);
  return c / 4;
}

static int enc = 0, tx = -1, ty = -1, presses = 0;
static char clock_text[24] = "";

static void draw() {
  auto &d = M5.Display;
  d.startWrite();
  d.fillScreen(TFT_NAVY);
  d.fillCircle(120, 120, 100, TFT_DARKCYAN);
  d.setTextColor(TFT_WHITE);
  d.setTextDatum(middle_center);
  d.setTextSize(4);
  d.drawNumber(enc, 120, 80);
  d.setTextSize(2);
  char line[32];
  snprintf(line, sizeof line, "x%d y%d", tx, ty);
  d.drawString(line, 120, 130);
  d.drawString(clock_text + 11, 120, 165);
  if (tx >= 0) d.fillCircle(tx, ty, 8, TFT_YELLOW);
  d.endWrite();
}

static void read_clock() {
  auto dt = M5.Rtc.getDateTime();
  snprintf(clock_text, sizeof clock_text, "%04d-%02d-%02d %02d:%02d:%02d", dt.date.year, dt.date.month,
           dt.date.date, dt.time.hours, dt.time.minutes, dt.time.seconds);
}

void setup() {
  Serial.begin(115200);
  auto cfg = M5.config();
  M5.begin(cfg);
  encoder_begin();
  read_clock();
  Serial.printf("DIAL ready board=%d display=%dx%d rtc=%d touch=%d\n", (int)M5.getBoard(), (int)M5.Display.width(),
                (int)M5.Display.height(), (int)M5.Rtc.isEnabled(), (int)M5.Touch.isEnabled());
  draw();
}

void loop() {
  M5.update();
  bool dirty = false;
  int e = detents();
  if (e != enc) {
    enc = e;
    Serial.printf("DIAL enc=%d\n", enc);
    dirty = true;
  }
  auto t = M5.Touch.getDetail();
  if (t.wasPressed()) {
    tx = t.x;
    ty = t.y;
    Serial.printf("DIAL touch x=%d y=%d\n", tx, ty);
    dirty = true;
  }
  if (M5.BtnA.wasPressed()) {
    presses++;
    Serial.printf("DIAL btnA presses=%d\n", presses);
    M5.Speaker.tone(2000, 100);
  }
  static uint32_t last = 0;
  if (millis() - last >= 1000) {
    last = millis();
    read_clock();
    Serial.printf("DIAL rtc=%s\n", clock_text);
    dirty = true;
  }
  if (dirty) draw();
  delay(10);
}
