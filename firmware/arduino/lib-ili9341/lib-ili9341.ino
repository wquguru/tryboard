// F-08a: Adafruit ILI9341 (BSD), after the library's graphicstest; accept runs it with --spi ili9341@cs=10,dc=1,rst=0,bl=-1.
// C3 SPI default SCK 4 / MOSI 6 / MISO 5; CS 10, DC 1, RST 0.
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

Adafruit_ILI9341 tft(10, 1, 0);

void setup() {
  Serial.begin(115200);
  delay(100);
  tft.begin();
  Serial.printf("ili9341 selfdiag 0x%02X madctl 0x%02X\n", tft.readcommand8(ILI9341_RDSELFDIAG), tft.readcommand8(ILI9341_RDMADCTL));
  tft.fillScreen(ILI9341_BLACK);
  tft.fillRect(20, 20, 200, 80, ILI9341_RED);
  tft.fillCircle(120, 200, 50, ILI9341_BLUE);
  tft.setCursor(30, 50);
  tft.setTextColor(ILI9341_WHITE);
  tft.setTextSize(3);
  tft.println("TryBoard");
  Serial.println("ili9341 drawn");
  Serial.println("TRYBOARD_OK lib-ili9341");
}

void loop() { delay(1000); }
