// F-08a: TFT_eSPI (licence unverified: local accept only) on a GC9A01 240x240, after the library's TFT_Print_Test.
// Panel setup comes from flags.txt (USER_SETUP_LOADED); pins match the CLI's C3 gc9a01 wiring.
#include <SPI.h>
#include <TFT_eSPI.h>

TFT_eSPI tft;

void setup() {
  Serial.begin(115200);
  delay(100);
  tft.init();
  Serial.printf("tft_espi %dx%d\n", tft.width(), tft.height());
  tft.fillScreen(TFT_BLACK);
  tft.fillRect(40, 40, 160, 60, TFT_RED);
  tft.fillCircle(120, 160, 40, TFT_BLUE);
  tft.setTextColor(TFT_WHITE, TFT_RED);
  tft.setTextSize(2);
  tft.drawString("TryBoard", 70, 62);
  Serial.println("tft_espi drawn");
  Serial.println("TRYBOARD_OK lib-tft-espi");
}

void loop() { delay(1000); }
