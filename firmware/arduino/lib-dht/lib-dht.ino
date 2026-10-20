// F-08a: Adafruit DHT sensor library (MIT), after the library's DHTtester example; DHT11 data on GPIO5.
#include "DHT.h"

DHT dht(5, DHT11);
int ok = 0;

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("DHT11 test");
  dht.begin();
}

void loop() {
  static int n = 0;
  delay(2100);
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) {
    Serial.println("Failed to read from DHT sensor!");
  } else {
    ok++;
    Serial.printf("DHT11 humidity %.1f %% temperature %.1f C heat index %.2f C\n", h, t, dht.computeHeatIndex(t, h, false));
  }
  if (++n == 3) Serial.printf("dht reads ok %d/3\n%s\n", ok, ok == 3 ? "TRYBOARD_OK lib-dht" : "dht failed");
}
