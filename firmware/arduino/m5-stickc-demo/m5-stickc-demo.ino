// M5-13 classic-ESP32 M5 demo (StickC Plus2, Core2, Atom Lite): buttons, battery mV, IMU tilt and RTC on the
// screen and on Serial. BtnA beeps, toggles the power LED and steps the RGB LED; BtnB records 0.1 s from the mic.
#include <M5Unified.h>
#include <math.h>

static int presses_a = 0, presses_b = 0, pwr = 0, led = 0;
static float pitch = 0, roll = 0;
static int bat_mv = 0, bat_level = 0;
static char clock_text[24] = "";
// Atom Lite RGB LED steps through these on each BtnA press (index 0 at boot)
static const uint8_t kRgb[][3] = {{0x10, 0x20, 0x30}, {0xff, 0, 0}, {0, 0xff, 0}, {0, 0, 0xff}};

static void read_clock() {
  auto dt = M5.Rtc.getDateTime();
  snprintf(clock_text, sizeof clock_text, "%04d-%02d-%02d %02d:%02d:%02d", dt.date.year, dt.date.month,
           dt.date.date, dt.time.hours, dt.time.minutes, dt.time.seconds);
}

static void sample() {
  bat_mv = M5.Power.getBatteryVoltage();
  bat_level = M5.Power.getBatteryLevel();
  float ax = 0, ay = 0, az = 0;
  if (M5.Imu.isEnabled()) {
    M5.Imu.update();
    M5.Imu.getAccel(&ax, &ay, &az);
  }
  roll = atan2f(ay, az) * 180 / M_PI;
  pitch = atan2f(-ax, sqrtf(ay * ay + az * az)) * 180 / M_PI;
  if (M5.Rtc.isEnabled()) read_clock();
}

static void set_rgb() {
  auto &c = kRgb[presses_a % 4];
  M5.Led.setAllColor(c[0], c[1], c[2]);
  M5.Led.display();
}

static void draw() {
  auto &d = M5.Display;
  if (d.width() == 0) return;
  int w = d.width(), cx0 = w / 2;
  d.startWrite();
  d.fillScreen(TFT_BLACK);
  d.fillRect(0, 0, w, 24, led ? TFT_RED : TFT_DARKGREY);
  d.setTextColor(TFT_WHITE);
  d.setTextSize(2);
  d.setCursor(4, 4);
  d.print("TryBoard");
  d.setCursor(4, 36);
  d.printf("A:%d B:%d", presses_a, presses_b);
  d.setCursor(4, 64);
  d.printf("%d mV", bat_mv);
  d.setCursor(4, 92);
  d.printf("P%+.0f R%+.0f", pitch, roll);
  d.setCursor(4, 120);
  d.print(clock_text + 11);
  // Bubble level: the dot moves with the tilt
  int cy0 = d.height() > 200 ? 190 : 170;
  d.drawCircle(cx0, cy0, 36, TFT_WHITE);
  d.fillCircle(cx0 + (int)(roll * 0.8f), cy0 - (int)(pitch * 0.8f), 8, TFT_YELLOW);
  d.endWrite();
}

static void record_mic() {
  if (!M5.Mic.isEnabled()) return;
  M5.Speaker.end();
  M5.Mic.begin();
  static int16_t buf[1600];
  M5.Mic.record(buf, 1600, 16000);
  while (M5.Mic.isRecording()) delay(1);
  M5.Mic.end();
  int peak = 0, cross = 0;
  for (int i = 0; i < 1600; i++) {
    peak = max(peak, abs((int)buf[i]));
    if (i && (buf[i - 1] < 0) != (buf[i] < 0)) cross++;
  }
  // 1600 samples = 0.1 s: two zero crossings per period
  Serial.printf("DEMO mic peak=%d freq=%d Hz\n", peak, cross * 5);
  M5.Speaker.begin();
}

void setup() {
  Serial.begin(115200);
  auto cfg = M5.config();
  M5.begin(cfg);
  // Unity gain: the default x16 clips a half-scale test tone and wraps in the int16 mix
  auto mc = M5.Mic.config();
  mc.magnification = 1;
  M5.Mic.config(mc);
  sample();
  Serial.printf("DEMO ready board=%d display=%dx%d imu=%d rtc=%d pmic=%d led=%d\n", (int)M5.getBoard(),
                (int)M5.Display.width(), (int)M5.Display.height(), (int)M5.Imu.getType(), (int)M5.Rtc.isEnabled(),
                (int)M5.Power.getType(), (int)M5.Led.isEnabled());
  if (M5.Rtc.isEnabled()) Serial.printf("DEMO rtc=%s\n", clock_text);
  set_rgb();
  draw();
}

void loop() {
  static uint32_t next = 0;
  M5.update();
  bool changed = false;
  if (M5.BtnA.wasPressed()) {
    presses_a++;
    led = !led;
    M5.Power.setLed(led ? 255 : 0);
    M5.Speaker.tone(2000, 200);
    set_rgb();
    Serial.printf("DEMO btnA presses=%d led=%d\n", presses_a, led);
    changed = true;
  }
  if (M5.BtnB.wasPressed()) {
    presses_b++;
    Serial.printf("DEMO btnB presses=%d\n", presses_b);
    record_mic();
    changed = true;
  }
  if (M5.BtnC.wasPressed()) Serial.println("DEMO btnC");
  if (M5.BtnPWR.wasClicked()) {
    pwr++;
    Serial.printf("DEMO btnPWR clicks=%d\n", pwr);
  }
  if (millis() >= next) {
    next = millis() + 500;
    sample();
    Serial.printf("DEMO bat=%dmV level=%d pitch=%.1f roll=%.1f rtc=%s\n", bat_mv, bat_level, pitch, roll,
                  clock_text);
    changed = true;
  }
  if (changed) draw();
  delay(10);
}
