// G-16a Dial timer: the ring sets 1-60 minutes, BtnA starts / pauses, three 2 kHz beeps on G3 at zero, a tap cancels.
// Time comes from millis() so the countdown follows simulated time; the encoder is read with PCNT as in m5-dial-demo.
#include <M5Unified.h>
#include "driver/pulse_cnt.h"

static const int ENC_A = 40, ENC_B = 41;
static const int BEEP_HZ = 2000, BEEP_MS = 200, BEEP_GAP_MS = 400, BEEPS = 3;
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

enum State { SET, RUN, PAUSE, RING };
static const char *STATE_TEXT[] = {"SET", "RUN", "PAUSE", "TIME UP"};
static State state = SET;
static int minutes = 5, last_det = 0, beeps = 0;
static uint32_t left_ms = 0, deadline = 0, next_beep = 0;
static int shown = -1;

static uint32_t remaining() {
  if (state != RUN) return left_ms;
  int32_t d = (int32_t)(deadline - millis());
  return d > 0 ? d : 0;
}

// Whole seconds rounded up, so the display shows 05:00 until a full second has gone
static int secs_left() { return (remaining() + 999) / 1000; }

static void mmss(char *buf, size_t n, int s) { snprintf(buf, n, "%02d:%02d", s / 60, s % 60); }

static void draw() {
  auto &d = M5.Display;
  int s = secs_left();
  int total = minutes * 60;
  char t[8];
  mmss(t, sizeof t, s);
  d.startWrite();
  d.fillScreen(TFT_BLACK);
  uint16_t ring = state == RING ? TFT_RED : state == PAUSE ? TFT_ORANGE : TFT_DARKCYAN;
  d.fillArc(120, 120, 118, 104, 0, 360, TFT_DARKGREY);
  // Progress ring from 12 o'clock, clockwise: the part still to run
  int deg = total ? (int)(360L * s / total) : 0;
  if (deg > 0) d.fillArc(120, 120, 118, 104, 270, 270 + deg, ring);
  d.setTextColor(TFT_WHITE);
  d.setTextDatum(middle_center);
  d.setTextSize(5);
  d.drawString(t, 120, 110);
  d.setTextSize(2);
  d.setTextColor(ring);
  d.drawString(STATE_TEXT[state], 120, 165);
  d.endWrite();
}

static void to_set(const char *why) {
  state = SET;
  left_ms = minutes * 60000u;
  last_det = detents();
  char t[8];
  mmss(t, sizeof t, minutes * 60);
  Serial.printf("%s%s%s\n", why, why[0] ? " " : "", t);
  shown = -1;
}

void setup() {
  Serial.begin(115200);
  auto cfg = M5.config();
  M5.begin(cfg);
  M5.Speaker.setVolume(128);
  encoder_begin();
  Serial.printf("Dial 计时器 就绪 board=%d display=%dx%d touch=%d speaker=%d\n", (int)M5.getBoard(), (int)M5.Display.width(),
                (int)M5.Display.height(), (int)M5.Touch.isEnabled(), (int)M5.Speaker.isEnabled());
  to_set("设定");
}

void loop() {
  M5.update();
  char t[8];
  if (state == SET) {
    int e = detents();
    if (e != last_det) {
      int m = minutes + (e - last_det);
      last_det = e;
      m = m < 1 ? 1 : m > 60 ? 60 : m;
      if (m != minutes) {
        minutes = m;
        to_set("设定");
      }
    }
  } else {
    last_det = detents();
  }
  if (M5.BtnA.wasPressed()) {
    mmss(t, sizeof t, secs_left());
    if (state == SET || state == PAUSE) {
      Serial.printf("%s %s\n", state == SET ? "开始" : "继续", t);
      deadline = millis() + left_ms;
      state = RUN;
    } else if (state == RUN) {
      left_ms = remaining();
      state = PAUSE;
      Serial.printf("暂停 %s\n", t);
    }
    shown = -1;
  }
  if (M5.Touch.getDetail().wasPressed() && (state == RUN || state == PAUSE)) {
    to_set("取消 回到");
  }
  if (state == RUN) {
    int s = secs_left();
    if (s != shown && s > 0) {
      mmss(t, sizeof t, s);
      Serial.printf("剩余 %s\n", t);
    }
    if (s == 0) {
      state = RING;
      left_ms = 0;
      beeps = 0;
      next_beep = millis();
      Serial.println("时间到");
    }
  }
  if (state == RING && (int32_t)(millis() - next_beep) >= 0) {
    if (beeps < BEEPS) {
      M5.Speaker.tone(BEEP_HZ, BEEP_MS);
      Serial.printf("嘀 %d/%d %d Hz\n", ++beeps, BEEPS, BEEP_HZ);
      next_beep += BEEP_GAP_MS;
    } else {
      to_set("回到设定");
    }
  }
  int s = secs_left();
  if (s != shown) {
    shown = s;
    draw();
  }
  delay(10);
}
