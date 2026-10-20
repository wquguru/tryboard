// F-08a: U8g2 (BSD-2) full-buffer hardware I2C SSD1306, after the library's HelloWorld example. C3 Wire default SDA 8 / SCL 9.
#include <U8g2lib.h>
#include <Wire.h>

U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

void setup() {
  Serial.begin(115200);
  delay(100);
  bool ok = u8g2.begin();
  Serial.printf("u8g2 begin %d, %dx%d\n", ok, u8g2.getDisplayWidth(), u8g2.getDisplayHeight());
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB14_tr);
  u8g2.drawStr(0, 20, "Hello World!");
  u8g2.drawFrame(0, 30, 128, 34);
  u8g2.drawBox(8, 38, 40, 18);
  u8g2.drawDisc(96, 47, 12);
  u8g2.sendBuffer();
  Serial.println("u8g2 drawn");
  Serial.println("TRYBOARD_OK lib-u8g2");
}

void loop() { delay(1000); }
