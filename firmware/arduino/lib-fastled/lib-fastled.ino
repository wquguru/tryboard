// F-08b: FastLED (MIT), after the library's Blink / FirstLight examples; 8 WS2812 LEDs on GPIO8.
#include <FastLED.h>

#define NUM_LEDS 8
#define DATA_PIN 8
CRGB leds[NUM_LEDS];

void show(const char *what) {
  FastLED.show();
  Serial.printf("fastled frame %s\n", what);
  delay(200);
}

void setup() {
  Serial.begin(115200);
  delay(100);
  // Full brightness and no dithering so every frame carries exact colours
  FastLED.addLeds<WS2812, DATA_PIN, GRB>(leds, NUM_LEDS);
  FastLED.setBrightness(255);
  FastLED.setDither(0);
  fill_solid(leds, NUM_LEDS, CRGB::Red);
  show("red");
  for (int i = 0; i < NUM_LEDS; i++) leds[i] = CRGB(i * 32, 255 - i * 32, i);
  show("gradient");
  fill_solid(leds, NUM_LEDS, CRGB::Black);
  leds[3] = CRGB::White;
  show("dot");
  FastLED.clear(true);
  Serial.println("fastled frames 4");
  Serial.println("TRYBOARD_OK lib-fastled");
}

void loop() { delay(1000); }
