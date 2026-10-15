// Arduino 示例：GPIO5 LED 闪烁 + Serial 打印。用 Arduino-ESP32 3.x 核心编译。
#define LED 5
void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
  Serial.println("Arduino blink start");
}
int n = 0;
void loop() {
  digitalWrite(LED, n % 2);
  Serial.printf("LED %s (%d)\n", n % 2 ? "ON" : "OFF", n);
  if (n == 3) Serial.println("TRYBOARD_OK arduino-blink");
  n++;
  delay(500);
}
