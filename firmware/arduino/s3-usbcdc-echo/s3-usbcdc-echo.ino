// Arduino example: ESP32-S3 with "USB CDC On Boot" (M5 S3 default), so Serial is the USB-Serial-JTAG port.
// Prints a banner, then echoes each received line; "ping" answers "pong".
String line;
void setup() {
  Serial.begin(115200);
  Serial.println("USB CDC console start");
  Serial.printf("Serial is HWCDC, connected=%d\n", (bool)Serial);
}
void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      line.trim();
      if (line == "ping") {
        Serial.println("pong");
        Serial.println("TRYBOARD_OK s3-usbcdc-echo");
      } else {
        Serial.printf("ECHO: %s\n", line.c_str());
      }
      line = "";
    } else {
      line += c;
    }
  }
  delay(10);
}
