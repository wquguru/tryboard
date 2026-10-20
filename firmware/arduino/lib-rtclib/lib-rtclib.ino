// F-08a: Adafruit RTClib (MIT) on a DS3231, after the library's ds3231 example; needs the F-04e DS3231 model before it can be accepted.
#include <RTClib.h>

RTC_DS3231 rtc;

void setup() {
  Serial.begin(115200);
  delay(100);
  if (!rtc.begin()) {
    Serial.println("Couldn't find RTC");
    return;
  }
  Serial.printf("ds3231 lost power %d\n", rtc.lostPower());
  rtc.adjust(DateTime(2026, 10, 20, 12, 34, 56));
  delay(2100);
  DateTime now = rtc.now();
  Serial.printf("ds3231 now %04d-%02d-%02d %02d:%02d:%02d\n", now.year(), now.month(), now.day(), now.hour(), now.minute(), now.second());
  Serial.printf("ds3231 temp %.2f C\n", rtc.getTemperature());
  Serial.println("TRYBOARD_OK lib-rtclib");
}

void loop() { delay(1000); }
