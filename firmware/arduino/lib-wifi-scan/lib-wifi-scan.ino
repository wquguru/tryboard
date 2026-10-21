// F-08b: arduino-esp32 core WiFi library, after its WiFiScan example.
#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  int n = WiFi.scanNetworks();
  Serial.printf("scan done, %d networks\n", n);
  for (int i = 0; i < n; i++) {
    Serial.printf("%d: %s ch=%ld rssi=%ld %s\n", i + 1, WiFi.SSID(i).c_str(), (long)WiFi.channel(i), (long)WiFi.RSSI(i),
                  WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "open" : "secured");
  }
  WiFi.scanDelete();
  if (n > 0) Serial.println("TRYBOARD_OK lib-wifi-scan");
}

void loop() { delay(1000); }
