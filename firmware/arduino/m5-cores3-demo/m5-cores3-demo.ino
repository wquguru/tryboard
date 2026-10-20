// M5-07 CoreS3 demo: PSRAM size, battery level, IMU, touch point and a speaker tone on the 320x240 screen and Serial.
// M5Unified only; the speaker is the AW88298 amp on I2S1 (BCK G34, WS G33, DOUT G13), enabled through AW9523 / I2C.
#include <M5Unified.h>

static int tx = -1, ty = -1;

static void draw(int bat) {
  auto &d = M5.Display;
  d.startWrite();
  d.fillScreen(TFT_NAVY);
  d.setTextColor(TFT_WHITE);
  d.setTextSize(2);
  d.setCursor(8, 8);
  d.printf("CoreS3 bat %d%%", bat);
  d.setCursor(8, 36);
  d.printf("touch x%d y%d", tx, ty);
  if (tx >= 0) d.fillCircle(tx, ty, 10, TFT_YELLOW);
  d.endWrite();
}

void setup() {
  Serial.begin(115200);
  auto cfg = M5.config();
  M5.begin(cfg);
  int bat = M5.Power.getBatteryLevel();
  Serial.printf("CS3 ready board=%d display=%dx%d psram=%u touch=%d imu=%d\n", (int)M5.getBoard(), (int)M5.Display.width(),
                (int)M5.Display.height(), (unsigned)ESP.getPsramSize(), (int)M5.Touch.isEnabled(), (int)M5.Imu.getType());
  Serial.printf("CS3 bat=%d\n", bat);
  M5.Imu.update();
  delay(20);
  M5.Imu.update();
  auto d = M5.Imu.getImuData();
  float m = sqrtf(d.mag.x * d.mag.x + d.mag.y * d.mag.y + d.mag.z * d.mag.z);
  Serial.printf("CS3 accel z=%.2f mag=%d\n", d.accel.z, (int)(m > 0.0f));
  draw(bat);
  M5.Speaker.setVolume(255);
  M5.Speaker.tone(1000, 1500);
  delay(50);
  Serial.printf("CS3 tone 1000 speaker=%d playing=%d\n", (int)M5.Speaker.isEnabled(), (int)M5.Speaker.isPlaying());
  Serial.println("TRYBOARD_OK m5-cores3-demo");
}

void loop() {
  M5.update();
  auto t = M5.Touch.getDetail();
  if (t.wasPressed()) {
    tx = t.x;
    ty = t.y;
    Serial.printf("CS3 touch x=%d y=%d\n", tx, ty);
    draw(M5.Power.getBatteryLevel());
  }
  delay(10);
}
