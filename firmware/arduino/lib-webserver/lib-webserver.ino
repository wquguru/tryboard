// F-08b: arduino-esp32 core WebServer + DNSServer libraries, after the HelloServer and CaptivePortal examples, on the firmware's own SoftAP.
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>

WebServer server(80);
DNSServer dns;

void setup() {
  Serial.begin(115200);
  delay(100);
  WiFi.softAP("TryBoard-Setup");
  Serial.printf("softap up ip=%s\n", WiFi.softAPIP().toString().c_str());
  // Captive portal: every name resolves to the AP, so a phone probing connectivity lands here
  dns.start(53, "*", WiFi.softAPIP());
  server.on("/", []() {
    server.send(200, "text/plain", "hello from esp32!");
    Serial.println("http GET / -> 200");
  });
  server.on("/led", []() {
    String s = server.arg("on");
    server.send(200, "text/plain", "led=" + s);
    Serial.printf("http GET /led on=%s\n", s.c_str());
    if (s == "1") Serial.println("TRYBOARD_OK lib-webserver");
  });
  server.onNotFound([]() {
    server.send(404, "text/plain", "not found");
    Serial.printf("http 404 %s\n", server.uri().c_str());
  });
  server.begin();
  Serial.println("http server started");
}

void loop() {
  dns.processNextRequest();
  server.handleClient();
  delay(2);
}
