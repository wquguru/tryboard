// F-08a: Adafruit SHT31 (BSD), after the library's SHT31test example (I2C 0x44, single-shot reads).
#include <Arduino.h>
#include <Wire.h>
#include "Adafruit_SHT31.h"

Adafruit_SHT31 sht31;

void setup() {
  Serial.begin(115200);
  delay(100);
  if (!sht31.begin(0x44)) {
    Serial.println("Couldn't find SHT31");
    return;
  }
  Serial.printf("sht31 heater %d\n", sht31.isHeaterEnabled());
  for (int i = 0; i < 3; i++) {
    float t = sht31.readTemperature();
    float h = sht31.readHumidity();
    Serial.printf("sht31 temp %.2f C\n", t);
    Serial.printf("sht31 hum %.2f %%\n", h);
    delay(200);
  }
  Serial.println("TRYBOARD_OK lib-sht31");
}

void loop() { delay(1000); }
