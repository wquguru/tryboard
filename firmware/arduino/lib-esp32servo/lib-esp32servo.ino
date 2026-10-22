// F-08b: ESP32Servo (LGPL-2.1+, shipped with LGPL notices since F-08e), after the library's Sweep example; SG90 on GPIO6.
#include <ESP32Servo.h>

Servo servo;

void setup() {
  Serial.begin(115200);
  delay(100);
  ESP32PWM::allocateTimer(0);
  servo.setPeriodHertz(50);
  // 500-2500 us: 0 deg = 2.5 % and 180 deg = 12.5 % duty at 50 Hz
  servo.attach(6, 500, 2500);
  for (int pos = 0; pos <= 180; pos += 45) {
    servo.write(pos);
    Serial.printf("servo -> %d deg (%d us)\n", pos, servo.readMicroseconds());
    delay(300);
  }
  Serial.println("TRYBOARD_OK lib-esp32servo");
}

void loop() { delay(1000); }
