// M5-00 probe: what M5Unified detects on each M5 board, plus a known display test pattern.
// One "key=value" line per result on Serial only (USB CDC on S3 boards is visible since M5-03;
// a second copy through the ROM printf interleaved with it byte by byte).
#include <M5Unified.h>

struct BoardName {
  m5::board_t id;
  const char *name;
};

// Names as in M5GFX boards.hpp without the "board_" prefix
static const BoardName kBoards[] = {
    {m5::board_t::board_M5Stack, "M5Stack"},
    {m5::board_t::board_M5StackCore2, "M5StackCore2"},
    {m5::board_t::board_M5StickC, "M5StickC"},
    {m5::board_t::board_M5StickCPlus, "M5StickCPlus"},
    {m5::board_t::board_M5StickCPlus2, "M5StickCPlus2"},
    {m5::board_t::board_M5StackCoreInk, "M5StackCoreInk"},
    {m5::board_t::board_M5Paper, "M5Paper"},
    {m5::board_t::board_M5Tough, "M5Tough"},
    {m5::board_t::board_M5Station, "M5Station"},
    {m5::board_t::board_M5StackCoreS3, "M5StackCoreS3"},
    {m5::board_t::board_M5AtomS3, "M5AtomS3"},
    {m5::board_t::board_M5Dial, "M5Dial"},
    {m5::board_t::board_M5DinMeter, "M5DinMeter"},
    {m5::board_t::board_M5Cardputer, "M5Cardputer"},
    {m5::board_t::board_M5AirQ, "M5AirQ"},
    {m5::board_t::board_M5VAMeter, "M5VAMeter"},
    {m5::board_t::board_M5StackCoreS3SE, "M5StackCoreS3SE"},
    {m5::board_t::board_M5AtomS3R, "M5AtomS3R"},
    {m5::board_t::board_M5PaperS3, "M5PaperS3"},
    {m5::board_t::board_M5StampPLC, "M5StampPLC"},
    {m5::board_t::board_M5CardputerADV, "M5CardputerADV"},
    {m5::board_t::board_M5StickS3, "M5StickS3"},
    {m5::board_t::board_M5AtomLite, "M5AtomLite"},
    {m5::board_t::board_M5AtomPsram, "M5AtomPsram"},
    {m5::board_t::board_M5AtomU, "M5AtomU"},
    {m5::board_t::board_M5StampS3, "M5StampS3"},
    {m5::board_t::board_M5AtomS3Lite, "M5AtomS3Lite"},
    {m5::board_t::board_M5AtomS3U, "M5AtomS3U"},
    {m5::board_t::board_M5Capsule, "M5Capsule"},
    {m5::board_t::board_M5AtomMatrix, "M5AtomMatrix"},
    {m5::board_t::board_M5AtomS3RExt, "M5AtomS3RExt"},
    {m5::board_t::board_M5StampS3Mini, "M5StampS3Mini"},
};

static const char *board_name(m5::board_t b) {
  for (auto &e : kBoards)
    if (e.id == b) return e.name;
  return b == m5::board_t::board_unknown ? "unknown" : "other";
}

void setup() {
  Serial.begin(115200);
  auto cfg = M5.config();
  M5.begin(cfg);

  auto &d = M5.Display;
  Serial.printf("M5PROBE board=%s board_id=%d dispboard=%s display=%dx%d imu=%d rtc=%d touch=%d pmic=%d bat=%d\n",
                board_name(M5.getBoard()), (int)M5.getBoard(), board_name(d.getBoard()), (int)d.width(),
                (int)d.height(), (int)M5.Imu.getType(), (int)M5.Rtc.isEnabled(), (int)M5.Touch.isEnabled(),
                (int)M5.Power.getType(), (int)M5.Power.getBatteryLevel());

  // RGB565 constants: a uint32_t would be read as RGB888 (0xF800 = green)
  const uint16_t bands[] = {TFT_RED, TFT_GREEN, TFT_BLUE, TFT_WHITE};
  int h = d.height() / 4;
  for (int i = 0; i < 4; i++) d.fillRect(0, i * h, d.width(), h, bands[i]);
  d.setTextColor(TFT_BLACK, TFT_WHITE);
  d.setTextSize(2);
  d.setCursor(d.width() / 2 - 48, d.height() / 8);
  d.print("TryBoard");
  Serial.println("M5PROBE_DRAWN");
  Serial.println("TRYBOARD_OK m5-probe");
  Serial.flush();
}

void loop() { delay(1000); }
