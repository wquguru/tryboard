// M5-06 AtomS3 family IMU demo: one binary (FQBN m5stack_atoms3) for AtomS3 / AtomS3 Lite / AtomS3R, board told apart at run time.
// Serial prints accel / gyro (and the BMM150 field on AtomS3R) twice a second; the screen draws a level bubble, Lite tints its WS2812.
#include <M5Unified.h>

static const char *tilt_name(float ax, float ay, float az) {
  if (az > 0.8f) return "flat";
  if (az < -0.8f) return "upside_down";
  if (fabsf(ax) >= fabsf(ay)) return ax > 0 ? "x_up" : "x_down";
  return ay > 0 ? "y_up" : "y_down";
}

static void draw_bubble(float ax, float ay) {
  auto &d = M5.Display;
  int cx = d.width() / 2, cy = d.height() / 2, r = d.width() / 2 - 4;
  // Bubble floats against gravity: it moves towards the raised side
  int bx = cx - (int)(ax * r), by = cy + (int)(ay * r);
  d.startWrite();
  d.fillScreen(TFT_BLACK);
  d.drawCircle(cx, cy, r, TFT_WHITE);
  d.drawCircle(cx, cy, 10, TFT_DARKGREY);
  d.fillCircle(bx, by, 8, TFT_GREEN);
  d.endWrite();
}

void setup() {
  Serial.begin(115200);
  auto cfg = M5.config();
  M5.begin(cfg);
  Serial.printf("IMU ready board=%d imu=%d display=%dx%d\n", (int)M5.getBoard(), (int)M5.Imu.getType(),
                (int)M5.Display.width(), (int)M5.Display.height());
  M5.Led.setBrightness(64);
}

void loop() {
  static uint32_t n = 0;
  static const char *last = "";
  M5.update();
  M5.Imu.update();
  auto data = M5.Imu.getImuData();
  float ax = data.accel.x, ay = data.accel.y, az = data.accel.z;
  const char *t = tilt_name(ax, ay, az);
  Serial.printf("IMU n=%u a=%.2f,%.2f,%.2f g=%.1f,%.1f,%.1f", (unsigned)n++, ax, ay, az, data.gyro.x, data.gyro.y,
                data.gyro.z);
  if (M5.Imu.getType() == m5::imu_t::imu_bmi270) Serial.printf(" m=%.1f,%.1f,%.1f", data.mag.x, data.mag.y, data.mag.z);
  Serial.printf(" tilt=%s\n", t);
  if (strcmp(t, last) != 0) {
    Serial.printf("IMU tilt change %s\n", t);
    last = t;
  }
  if (M5.Display.width() > 0) draw_bubble(ax, ay);
  // RGB LED (Lite only): red / green / blue by the axis carrying gravity; no IMU there, so it steps R, G, B
  uint8_t rgb[3] = {(uint8_t)(fabsf(ax) * 255), (uint8_t)(fabsf(ay) * 255), (uint8_t)(fabsf(az) * 255)};
  if (M5.Imu.getType() == m5::imu_t::imu_none) {
    rgb[0] = rgb[1] = rgb[2] = 0;
    rgb[n % 3] = 255;
  }
  if (M5.Led.getCount()) {
    M5.Led.setColor(0, rgb[0], rgb[1], rgb[2]);
    M5.Led.display();
    Serial.printf("IMU led=%02x%02x%02x\n", rgb[0], rgb[1], rgb[2]);
  }
  delay(500);
}
