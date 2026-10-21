// F-08b: WiFiManager (MIT), after the library's Basic / AutoConnect example.
// The portal AP is the open TryBoard-Setup; the virtual phone posts MyHome credentials to /wifisave.
#include <WiFi.h>
#include <WiFiManager.h>

void setup() {
  Serial.begin(115200);
  delay(100);
  WiFiManager wm;
  wm.setAPCallback([](WiFiManager *m) { Serial.printf("portal started ssid=%s ip=%s\n", m->getConfigPortalSSID().c_str(), WiFi.softAPIP().toString().c_str()); });
  wm.setSaveConfigCallback([]() { Serial.println("credentials saved"); });
  wm.setConfigPortalTimeout(60);
  if (!wm.autoConnect("TryBoard-Setup")) {
    Serial.println("wifimanager failed to connect");
    return;
  }
  Serial.printf("connected ssid=%s ip=%s\n", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
  Serial.println("TRYBOARD_OK lib-wifimanager");
}

void loop() { delay(1000); }
