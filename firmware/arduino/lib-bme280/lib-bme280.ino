// F-08a: Adafruit BME280 (BSD), after the library's bme280test example (I2C 0x76, forced readings).
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>

Adafruit_BME280 bme;

void setup() {
  Serial.begin(115200);
  delay(100);
  if (!bme.begin(0x76)) {
    Serial.printf("no BME280, sensor id 0x%x\n", bme.sensorID());
    return;
  }
  Serial.printf("bme280 id 0x%x\n", bme.sensorID());
  for (int i = 0; i < 3; i++) {
    delay(200);
    Serial.printf("bme280 temp %.2f C\n", bme.readTemperature());
    Serial.printf("bme280 hum %.2f %%\n", bme.readHumidity());
    Serial.printf("bme280 press %.2f hPa\n", bme.readPressure() / 100.0f);
  }
  Serial.println("TRYBOARD_OK lib-bme280");
}

void loop() { delay(1000); }
