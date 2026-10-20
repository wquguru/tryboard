// F-08a: DallasTemperature (MIT) + OneWire (licence unverified: local accept only), after the library's Multiple example; bus on GPIO4.
#include <OneWire.h>
#include <DallasTemperature.h>

OneWire oneWire(4);
DallasTemperature sensors(&oneWire);

void setup() {
  Serial.begin(115200);
  delay(100);
  sensors.begin();
  int n = sensors.getDeviceCount();
  Serial.printf("dallas devices %d parasite %d\n", n, sensors.isParasitePowerMode());
  for (int i = 0; i < n; i++) {
    DeviceAddress a;
    if (!sensors.getAddress(a, i)) continue;
    Serial.printf("dallas rom %d:", i);
    for (int k = 0; k < 8; k++) Serial.printf("%02X", a[k]);
    Serial.println();
  }
  sensors.requestTemperatures();
  for (int i = 0; i < n; i++) Serial.printf("dallas temp %d %.2f C\n", i, sensors.getTempCByIndex(i));
  Serial.println("TRYBOARD_OK lib-dallas");
}

void loop() { delay(1000); }
