// F-08b: arduino-esp32 core HTTPClient library, after its BasicHttpClient example (WPA2 network).
#include <WiFi.h>
#include <HTTPClient.h>

int get(const char *url) {
  HTTPClient http;
  http.begin(url);
  int code = http.GET();
  String body = code > 0 ? http.getString() : http.errorToString(code);
  body.trim();
  Serial.printf("GET %s -> %d %s\n", url, code, body.c_str());
  http.end();
  return code;
}

void setup() {
  Serial.begin(115200);
  delay(100);
  WiFi.begin("TryBoard-WPA2", "tryboard123");
  while (WiFi.status() != WL_CONNECTED) delay(100);
  Serial.printf("wifi connected ip=%s rssi=%ld\n", WiFi.localIP().toString().c_str(), (long)WiFi.RSSI());
  int a = get("http://tryboard.local/hello.txt");
  int b = get("http://example.com/api/time");
  if (a == 200 && b == 200) Serial.println("TRYBOARD_OK lib-httpclient");
}

void loop() { delay(1000); }
