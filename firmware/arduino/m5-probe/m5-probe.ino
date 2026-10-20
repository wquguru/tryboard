// M5-00 probe: what M5Unified detects on each M5 board, plus a known display test pattern.
// Lines go to Serial (board default: USB CDC on S3 boards) and to UART0 through the ROM printf,
// which is the only console the simulator shows today; M5-03 makes USB-Serial-JTAG visible.
#include <M5Unified.h>
#include <stdarg.h>
#include "esp_rom_sys.h"

static void say(const char *fmt, ...) {
  char buf[256];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  Serial.print(buf);
  esp_rom_printf("%s", buf);
}

void setup() {
  Serial.begin(115200);
  auto cfg = M5.config();
  M5.begin(cfg);

  auto &d = M5.Display;
  say("M5PROBE board=%d dispboard=%d display=%dx%d imu=%d rtc=%d touch=%d pmic=%d bat=%d\n",
      (int)M5.getBoard(), (int)d.getBoard(), (int)d.width(), (int)d.height(), (int)M5.Imu.getType(),
      (int)M5.Rtc.isEnabled(), (int)M5.Touch.isEnabled(), (int)M5.Power.getType(), (int)M5.Power.getBatteryLevel());

  const uint32_t bands[] = {TFT_RED, TFT_GREEN, TFT_BLUE, TFT_WHITE};
  int h = d.height() / 4;
  for (int i = 0; i < 4; i++) d.fillRect(0, i * h, d.width(), h, bands[i]);
  d.setTextColor(TFT_BLACK, TFT_WHITE);
  d.setTextSize(2);
  d.setCursor(4, 4);
  d.print("TryBoard");
  say("M5PROBE_DRAWN\n");
  say("TRYBOARD_OK m5-probe\n");
}

void loop() { delay(1000); }
