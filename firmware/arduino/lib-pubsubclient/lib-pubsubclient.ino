// F-08b: PubSubClient (MIT), after the library's mqtt_esp8266 / mqtt_basic examples.
// The virtual broker on tryboard.local:1883 echoes our own publish; the script action mqtt=pub sends tryboard/in.
#include <WiFi.h>
#include <PubSubClient.h>

WiFiClient net;
PubSubClient client(net);
int got = 0;

void callback(char *topic, byte *payload, unsigned int len) {
  Serial.printf("mqtt message %s %.*s\n", topic, (int)len, (const char *)payload);
  if (++got == 2) Serial.println("TRYBOARD_OK lib-pubsubclient");
}

void setup() {
  Serial.begin(115200);
  delay(100);
  WiFi.begin("TryBoard-WiFi");
  while (WiFi.status() != WL_CONNECTED) delay(100);
  Serial.printf("wifi connected ip=%s\n", WiFi.localIP().toString().c_str());
  client.setServer("tryboard.local", 1883);
  client.setCallback(callback);
  if (client.connect("tryboard-c3")) {
    Serial.println("mqtt connected");
    client.subscribe("tryboard/#");
    client.publish("tryboard/hello", "hello world");
    Serial.println("mqtt subscribed tryboard/#, published tryboard/hello");
  } else {
    Serial.printf("mqtt connect failed rc=%d\n", client.state());
  }
}

void loop() { client.loop(); delay(10); }
