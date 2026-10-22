// F-08b: IRremote (MIT, shipped with notices since F-08e), after the library's SimpleSender example; IR LED on GPIO4.
#include <Arduino.h>
#include <IRremote.hpp>

void setup() {
  Serial.begin(115200);
  delay(100);
  IrSender.begin(4);
  for (int i = 0; i < 3; i++) {
    IrSender.sendNEC(0x00, 0x34 + i, 0);
    Serial.printf("ir sent NEC addr=0x00 cmd=0x%02X\n", 0x34 + i);
    delay(100);
  }
  Serial.println("TRYBOARD_OK lib-irremote");
}

void loop() { delay(1000); }
