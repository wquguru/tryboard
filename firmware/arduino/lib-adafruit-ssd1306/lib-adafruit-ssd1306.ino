// F-08a: Adafruit SSD1306 + Adafruit GFX (BSD), after the library's ssd1306_128x64_i2c example (text, shapes, invert).
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);

void setup() {
  Serial.begin(115200);
  delay(100);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 allocation failed");
    return;
  }
  Serial.println("ssd1306 begin ok");
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("TryBoard");
  display.setTextSize(1);
  display.println("Adafruit SSD1306");
  display.drawRect(0, 28, 128, 36, SSD1306_WHITE);
  display.fillCircle(30, 46, 12, SSD1306_WHITE);
  display.fillTriangle(70, 58, 90, 32, 110, 58, SSD1306_WHITE);
  display.display();
  Serial.println("ssd1306 drawn");
  delay(300);
  display.invertDisplay(true);
  delay(300);
  display.invertDisplay(false);
  Serial.println("TRYBOARD_OK lib-adafruit-ssd1306");
}

void loop() { delay(1000); }
