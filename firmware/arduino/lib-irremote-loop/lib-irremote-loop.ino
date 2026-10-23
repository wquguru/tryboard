// G-15: IRremote (MIT) send + receive on one C3: IR LED on GPIO4 (LEDC 38 kHz carrier), receiver module on GPIO5.
// Merged from lib-irremote and lib-irremote-rx; the bench points the LED at the receiver, so every frame comes back.
#define DECODE_NEC
#include <Arduino.h>
#include <IRremote.hpp>

const uint8_t ADDR = 0x10;
int got = 0;

void setup() {
  Serial.begin(115200);
  delay(100);
  IrReceiver.begin(5, DISABLE_LED_FEEDBACK);
  IrSender.begin(4);
  // IRremote drops a mark within 5 ms of begin() and calls a frame after < 70 ms of quiet an NEC2 repeat
  delay(100);
  Serial.println("TRYBOARD_OK lib-irremote-loop ready");
  for (int i = 0; i < 3; i++) {
    uint8_t cmd = 0x41 + i;
    IrSender.sendNEC(ADDR, cmd, 0);
    Serial.printf("ir sent NEC addr=0x%02X cmd=0x%02X\n", ADDR, cmd);
    IrReceiver.restartAfterSend();
    // The receiver reports a frame once the line has been idle for its record gap
    uint32_t t0 = millis();
    while (millis() - t0 < 100) {
      if (IrReceiver.decode()) {
        IRData &d = IrReceiver.decodedIRData;
        if (d.protocol == NEC) {
          bool ok = d.address == ADDR && d.command == cmd;
          got += ok;
          Serial.printf("ir got NEC addr=0x%02X cmd=0x%02X%s\n", d.address, d.command, ok ? "" : " (mismatch)");
        } else {
          Serial.printf("ir got unknown (%d marks)\n", d.rawlen / 2);
        }
        IrReceiver.resume();
      }
    }
  }
  Serial.printf("ir loopback %d/3\n", got);
  if (got == 3) Serial.println("TRYBOARD_OK lib-irremote-loop");
}

void loop() { delay(1000); }
