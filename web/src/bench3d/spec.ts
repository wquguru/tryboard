// Scene description types: the add-on parts an example declares and the initial camera.
import type { BoardId } from './boarddevs';

/** Grove units the core models (core/crates/machine/src/boards.rs GROVE_UNITS) */
export type GroveId = 'env3' | 'env4';



/** Add-on parts declared by an example (scene.parts in examples.json). */
export type PartSpec =
  | { type: 'led'; pin: number; color?: number; col?: number; label?: string }
  | { type: 'oled'; addr: number; sda: number; scl: number; label?: string }
  /** 1.28″ GC9A01 round LCD (SPI2): pins fixed per chip, see LCD_WIRING (S3: SCLK=12, MOSI=11, CS=10, DC=14, RST=13, BL=15; C3: 6, 7, 10, 5, 4, 3) */
  | { type: 'gc9a01'; spi?: number; label?: string }
  | { type: 'bme280'; addr: number; sda: number; scl: number; label?: string }
  /** SG90 servo: signal on pin; horn angle follows PWM pulse width (0.5–2.5 ms → 0–180°) */
  | { type: 'servo'; pin: number; freq?: number; label?: string }
  /** 10 kΩ potentiometer: ends on 3V3 / GND, wiper on pin (ADC); the knob is draggable */
  | { type: 'pot'; pin: number; label?: string }
  /** Passive 3-pin buzzer module: I/O on pin, LEDC square wave; sound in audio.ts, in 3D the diaphragm moves and emits waves */
  | { type: 'buzzer'; pin: number; label?: string }
  /** 6×6 mm tactile key across the centre groove: pin to GND, firmware enables pull-up; holding the cap pulls the pin low. cap = keycap text */
  | { type: 'key'; pin: number; cap?: string; label?: string }
  /** EC11 rotary encoder module (KY-040 style, P2-01): CLK = a, DT = b, push switch sw; 3V3 powered. Drag / wheel / click the knob */
  | { type: 'encoder'; a: number; b: number; sw?: number; label?: string }
  /** HC-SR04 ultrasonic (P2-04): 5 V supply; Echo enters GPIO via a 1 kΩ / 2 kΩ divider (divider: false = direct, wiring check flags 5 V on GPIO).
   *  cm = initial distance to a draggable obstacle in front; distance is measured by a raycast */
  | { type: 'hcsr04'; trig: number; echo: number; divider?: boolean; cm?: number; label?: string }
  /** MPU6050 6-axis module (GY-521, 8 pins, laid flat): I2C; INT optional (P2-03) */
  | { type: 'mpu6050'; addr: number; sda: number; scl: number; int?: number; label?: string }
  /** QMI8658 6-axis module (6 pins, laid flat): I2C (P2-03) */
  | { type: 'qmi8658'; addr: number; sda: number; scl: number; label?: string }
  /** CST816S touch layer on the round LCD (P2-02): with gc9a01 the LCD becomes the 12-pin touch version; clicking the screen = touch */
  | { type: 'cst816s'; addr: number; sda: number; scl: number; int: number; rst?: number; label?: string }
  /** MAX98357A I2S amp module + 4 Ω speaker: pins fixed per chip (I2S_WIRING); sound in pcm.ts, the 3D cone follows the volume */
  | { type: 'max98357a'; label?: string }
  /** INMP441 I2S digital mic module (L/R to GND = left channel): pins fixed per chip, see I2S_WIRING */
  | { type: 'inmp441'; label?: string }
  /** 8-LED WS2812 stick (P2-09 knob lamp): DIN on pin (via 74AHCT125 to 5 V, illustrative), 5V supply; lies on the desk in front, colours from core-decoded frames */
  | { type: 'ws2812'; pin: number; n?: number; label?: string }
  /** DHT11 temperature / humidity module (D-03): 3 pins (VCC 3V3, DATA open drain with 10 kΩ pull-up on the module, GND); single-wire protocol */
  | { type: 'dht11'; pin: number; label?: string }
  /** DS18B20 waterproof probe(s) (F-04c): VDD 3V3, DQ on pin with a 4.7 kΩ pull-up to 3V3, GND; n probes share the wire (= CLI --ds18b20 pin,n) */
  | { type: 'ds18b20'; pin: number; n?: number; label?: string }
  /** HC-SR501 PIR module (F-04d): 5 V supply, 3.3 V push-pull OUT on pin; hold = delay pot seconds (= CLI --pir pin,hold) */
  | { type: 'pir'; pin: number; hold?: number; label?: string }
  /** 1-channel 5 V relay module (F-04d): IN on pin; low = low-level trigger jumper (= CLI --relay pin[,low]) */
  | { type: 'relay'; pin: number; low?: boolean; label?: string }
  /** Photoresistor module (GL5528 + 10 kΩ, F-04d): AO on an ADC pin; lux = initial light (= CLI --ldr pin,lux) */
  | { type: 'ldr'; pin: number; lux?: number; label?: string }
  /** RC522 RFID reader (F-04d, SPI2): SDA (CS) is the only pin the model watches; the other wires are drawn as placed (= CLI --spi rc522[@cs=N]) */
  | { type: 'rc522'; cs?: number; sck?: number; mosi?: number; miso?: number; rst?: number; label?: string };


/** The scene's IMU (bench tilt / drag only works when there is one) */
export const imuPart = (s: SceneSpec) => s.parts.find((p): p is Extract<PartSpec, { type: 'mpu6050' | 'qmi8658' }> => p.type === 'mpu6050' || p.type === 'qmi8658');

export interface SceneSpec {
  parts: PartSpec[];
  /** All-in-one board replacing the devboard + breadboard (E-03); its onboard devices come from BOARD_DEVS (M5 ids: a core preset, M5-09b) */
  board?: BoardId;
  /** Grove unit on the preset board's Port A (M5-09d, = CLI --grove); ignored without an M5 preset */
  grove?: GroveId;
  /** Initial camera (mm, world coordinates) */
  view?: { position: [number, number, number]; target: [number, number, number] };
}

export const DEFAULT_VIEW: Required<SceneSpec>['view'] = { position: [-40, 95, 105], target: [0, 6, 4] };
