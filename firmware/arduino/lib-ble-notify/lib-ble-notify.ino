// F-08b: arduino-esp32 core BLE library (NimBLE host on C3 in core 3.3.x), after its Notify example.
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define SERVICE_UUID "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

BLECharacteristic *chr;
bool connected = false;
uint32_t value = 0;

class ServerCb : public BLEServerCallbacks {
  void onConnect(BLEServer *s) { connected = true; Serial.println("ble connected"); }
  void onDisconnect(BLEServer *s) { connected = false; Serial.println("ble disconnected"); }
};

void setup() {
  Serial.begin(115200);
  delay(100);
  BLEDevice::init("TryBoard-BLE");
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCb());
  BLEService *svc = server->createService(SERVICE_UUID);
  chr = svc->createCharacteristic(CHARACTERISTIC_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  chr->addDescriptor(new BLE2902());
  chr->setValue((uint8_t *)&value, 4);
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("ble advertising TryBoard-BLE");
}

void loop() {
  if (connected && value < 5) {
    value++;
    chr->setValue((uint8_t *)&value, 4);
    chr->notify();
    Serial.printf("ble notify %lu\n", (unsigned long)value);
    if (value == 5) Serial.println("TRYBOARD_OK lib-ble-notify");
  }
  delay(500);
}
