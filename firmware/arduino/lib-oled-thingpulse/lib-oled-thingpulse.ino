// F-08a: ThingPulse esp8266-oled-ssd1306 (MIT), after the library's SSD1306SimpleDemo (fonts, shapes, progress bar).
#include <Wire.h>
#include "SSD1306Wire.h"

SSD1306Wire display(0x3c, 8, 9);

void setup() {
  Serial.begin(115200);
  delay(100);
  bool ok = display.init();
  Serial.printf("thingpulse init %d\n", ok);
  display.flipScreenVertically();
  display.clear();
  display.setFont(ArialMT_Plain_16);
  display.setTextAlignment(TEXT_ALIGN_LEFT);
  display.drawString(0, 0, "Hello world");
  display.setFont(ArialMT_Plain_10);
  display.drawString(0, 20, "ThingPulse OLED");
  display.drawProgressBar(0, 40, 120, 12, 60);
  display.fillRect(100, 0, 20, 16);
  display.display();
  Serial.println("thingpulse drawn");
  Serial.println("TRYBOARD_OK lib-oled-thingpulse");
}

void loop() { delay(1000); }
