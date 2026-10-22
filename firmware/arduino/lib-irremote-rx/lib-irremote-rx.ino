// F-08i: IRremote (MIT) receive, trimmed from the library's ReceiveDemo; receiver module output on GPIO5, NEC only.
#define DECODE_NEC
#include <Arduino.h>
#include <IRremote.hpp>

void setup() {
  Serial.begin(115200);
  delay(100);
  IrReceiver.begin(5, DISABLE_LED_FEEDBACK);
  Serial.println("TRYBOARD_OK lib-irremote-rx ready");
}

void loop() {
  if (IrReceiver.decode()) {
    IRData &d = IrReceiver.decodedIRData;
    if (d.protocol == NEC) {
      bool rep = d.flags & IRDATA_FLAGS_IS_REPEAT;
      Serial.printf("ir NEC addr=0x%02X cmd=0x%02X%s\n", d.address, d.command, rep ? " repeat" : "");
    } else {
      Serial.printf("ir unknown (%d marks)\n", d.rawlen / 2);
    }
    IrReceiver.resume();
  }
}
