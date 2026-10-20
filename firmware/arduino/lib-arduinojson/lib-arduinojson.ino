// F-08a: ArduinoJson (MIT) parse + build, after the library's JsonParserExample / JsonGeneratorExample; pure software.
#include <ArduinoJson.h>

void setup() {
  Serial.begin(115200);
  delay(100);
  const char *in = "{\"sensor\":\"gps\",\"time\":1351824120,\"data\":[48.756080,2.302038]}";
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, in);
  if (err) {
    Serial.printf("deserializeJson failed: %s\n", err.c_str());
    return;
  }
  Serial.printf("json parse sensor=%s time=%ld\n", doc["sensor"].as<const char *>(), doc["time"].as<long>());
  Serial.printf("json parse lat=%.6f lon=%.6f\n", doc["data"][0].as<double>(), doc["data"][1].as<double>());
  JsonDocument out;
  out["sensor"] = "bme280";
  out["temp"] = 23.5;
  JsonArray a = out["history"].to<JsonArray>();
  for (int i = 0; i < 3; i++) a.add(i * 10);
  String s;
  serializeJson(out, s);
  Serial.printf("json build %s (%u bytes)\n", s.c_str(), (unsigned)measureJson(out));
  Serial.println("TRYBOARD_OK lib-arduinojson");
}

void loop() { delay(1000); }
