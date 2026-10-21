// F-08b: NimBLE-Arduino (Apache-2.0), after the library's NimBLE_Server example.
// Battery service 180F / level 2A19 = 87 %, notified every 500 ms once a central subscribes.
#include <NimBLEDevice.h>

NimBLECharacteristic *level;
bool subscribed = false;
uint8_t pct = 87;

class ServerCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *s, NimBLEConnInfo &info) override { Serial.printf("nimble connected %s\n", info.getAddress().toString().c_str()); }
  void onDisconnect(NimBLEServer *s, NimBLEConnInfo &info, int reason) override {
    Serial.printf("nimble disconnected reason=%d\n", reason);
    NimBLEDevice::startAdvertising();
  }
};

class CharCb : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic *c, NimBLEConnInfo &info) override { Serial.printf("nimble read 2A19 = %d%%\n", c->getValue<uint8_t>()); }
  void onSubscribe(NimBLECharacteristic *c, NimBLEConnInfo &info, uint16_t sub) override {
    subscribed = sub & 1;
    Serial.printf("nimble subscribe notify=%d\n", sub & 1);
  }
};

void setup() {
  Serial.begin(115200);
  delay(100);
  NimBLEDevice::init("TryBoard-NimBLE");
  NimBLEServer *server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCb());
  NimBLEService *svc = server->createService("180F");
  level = svc->createCharacteristic("2A19", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  level->setCallbacks(new CharCb());
  level->setValue(&pct, 1);
  svc->start();
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->setName("TryBoard-NimBLE");
  adv->addServiceUUID("180F");
  adv->start();
  Serial.println("nimble advertising TryBoard-NimBLE");
}

void loop() {
  static int sent = 0;
  if (subscribed && sent < 3) {
    pct--;
    level->setValue(&pct, 1);
    bool ok = level->notify();
    Serial.printf("nimble notify %d%% ok=%d\n", pct, ok);
    if (++sent == 3) Serial.println("TRYBOARD_OK lib-nimble");
  }
  delay(500);
}
