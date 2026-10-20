// F-08a: Adafruit MPU6050 (BSD), after the library's basic_readings example (accel / gyro / temperature).
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>

Adafruit_MPU6050 mpu;

void setup() {
  Serial.begin(115200);
  delay(100);
  if (!mpu.begin()) {
    Serial.println("Failed to find MPU6050 chip");
    return;
  }
  Serial.println("MPU6050 Found!");
  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  Serial.printf("accel range %d gyro range %d\n", mpu.getAccelerometerRange(), mpu.getGyroRange());
}

void loop() {
  static int n = 0;
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);
  Serial.printf("mpu accel x %.2f y %.2f z %.2f m/s2\n", a.acceleration.x, a.acceleration.y, a.acceleration.z);
  Serial.printf("mpu gyro x %.2f y %.2f z %.2f rad/s temp %.1f C\n", g.gyro.x, g.gyro.y, g.gyro.z, temp.temperature);
  if (++n == 3) Serial.println("TRYBOARD_OK lib-mpu6050");
  delay(300);
}
