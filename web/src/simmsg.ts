// Worker <-> main-thread message types (R-07): the one place both sides import them from
import type { InputLog, InputEvent, InputAction } from './inputlog';
import type { Locale } from './i18n';
import type { PartsDevs } from './partsdev.ts';
import type { TftPanel } from './lcdspec.ts';

/** Power source (P1-02): usb = servo also draws from USB 5 V; ext = servo on an external 5 V 2 A supply. */
export type PowerMode = 'usb' | 'ext';
/** Screen model attached at power-up (E-03) */
export type LcdKind = 'gc9a01' | 'co5300' | TftPanel;
/** AXP2101 battery state: percent and whether USB is plugged (E-03) */
export type Battery = { pct: number; usb: boolean };

/** Supply network readings now (tryboard-elec, V and A); min / peak / resets are since this power-up. */
export interface ElecFrame {
  v5: number;
  v3v3: number;
  vServo: number;
  vExt: number;
  iUsb: number;
  iExt: number;
  iServo: number;
  i3v3: number;
  /** Amp (MAX98357A) current on the 5 V rail; 0 when absent. */
  iAmp: number;
  min5: number;
  min3v3: number;
  peakUsb: number;
  peakServo: number;
  resets: number;
  /** Chip held in brown-out reset (does not run until the voltage recovers). */
  held: boolean;
  /** Servo angle from the second-order dynamics (degrees); null without a servo. */
  servoAngle: number | null;
  power: PowerMode;
}

export interface Env {
  temp: number;
  humidity: number;
  pressure: number;
}

/** Rotary encoder (P2-01): A / B phases and an optional switch pin. */
export interface EncoderSpec {
  a: number;
  b: number;
  sw?: number;
}
/** HC-SR04 (P2-04): Trig / Echo GPIOs; cm = distance to the obstacle at power-up (negative = nothing ahead). */
export interface SonarSpec {
  trig: number;
  echo: number;
  cm: number;
}

/** Pin-device state per tick: encoder detents and PCNT unit 0 count; ultrasonic trigger count and last Echo width. */
export interface PinDevFrame {
  encPos: number | null;
  pcnt: number | null;
  pings: number | null;
  echoUs: number | null;
  /** DHT11 frames sent / host start pulses too short (null = no DHT11) */
  dhtReads: number | null;
  dhtShort: number | null;
}

/** Timing-sensitive code report (D-03); line is the CLI's stderr line verbatim */
export interface TimingReport {
  line: string;
  items: { pin: number; kind: 'delay' | 'spin' | 'toggle' | 'poll'; n: number }[];
}

/** Fine capture (D-04) state: window in cycles (null while waiting for the trigger), edges kept / dropped */
export interface VcdState {
  t0: number | null;
  t1: number | null;
  edges: number;
  dropped: number;
}

export type ToWorker =
  | {
      type: 'boot';
      /** Compiled once on the main thread (R-23); structured clone shares the code, no recompile. */
      wasm: WebAssembly.Module;
      /** ROM / firmware bytes, omitted when the worker already holds that id (cached per worker). */
      rom?: ArrayBuffer;
      romId: number;
      flash?: ArrayBuffer;
      flashId: number;
      i2c?: { kind: string; addr: number }[];
      env?: Env;
      /** Attach a screen: true / 'gc9a01' = GC9A01 round LCD (SPI2), 'co5300' = CO5300 QSPI AMOLED (E-03). */
      lcd?: boolean | LcdKind;
      /** AXP2101 battery at power-up (percent, USB plugged); needs axp2101 in i2c. */
      battery?: Battery;
      /** Servo signal GPIO (servo current enters the supply network). */
      servo?: number;
      power?: PowerMode;
      encoder?: EncoderSpec;
      sonar?: SonarSpec;
      /** DHT11 data GPIO (open drain; readings follow env) */
      dht11?: number;
      /** Touch controller INT GPIO (held low while touched). */
      touchInt?: number;
      /** Core board preset (M5-09b, = CLI --board), applied right after power-up before other devices */
      board?: string;
      /** Grove unit on the preset's Port A (M5-09d, = CLI --grove: env3 / env4), right after the preset */
      grove?: string;
      /** F-04a parts (DS18B20 / PIR / relay / LDR / RC522), = CLI --ds18b20 / --pir / --relay / --ldr / --spi rc522 */
      parts?: PartsDevs;
      /** I2S audio devices: 'max98357a' (speaker) / 'inmp441' (mic); pins fixed per chip (board3d I2S_WIRING). */
      i2s?: string[];
      /** WAV the mic hears at power-up (silent if absent) and its file name (logged; replay uses --mic tools/audio/<name>). */
      micWav?: ArrayBuffer;
      micName?: string;
      /** Harness (P2-11, estimate): I2C cable length (cm), antenna loss (dB); logged at power-up. */
      harness?: Harness;
      /** "Real network" toggle (C-03): on at boot logs realnet=1 at time 0 */
      realnet?: boolean;
      /** Network preset (D-01): other than normal, logged as net=<preset> at time 0 */
      net?: string;
      /** Page locale, so human text the worker makes matches the page (I18N workers). */
      locale?: Locale;
    }
  | ({ type: 'env' } & Env)
  /** Change the harness live (logged: i2cwire=cm / antenna=dB). */
  | ({ type: 'harness' } & Harness)
  /** Encoder steps (positive = clockwise) / switch; ultrasonic distance (logged: enc= / encsw= / dist=). */
  | { type: 'enc'; steps: number }
  | { type: 'encsw'; down: boolean }
  | { type: 'dist'; cm: number }
  /** Fine capture (D-04): absolute window [from, from + len] s, or armed: the first edge at or after `from` opens it */
  | { type: 'vcdStart'; pins: number[]; from: number; len: number; trigger: boolean }
  /** Ask for the VCD text, answered with vcdText */
  | { type: 'vcdGet' }
  /** Inputs without a dedicated message (imu, touch...): applied as is and logged. */
  | { type: 'input'; act: Extract<InputAction, { kind: 'imu' | 'touch' | 'bat' | 'pwrkey' | 'key' | 'pir' | 'lux' | 'card' }> }
  /** Mic source: WAV (looped, sampled on sim time, reproducible) / silent / live (micPush browser samples placed on sim time; not logged, micRecGet exports them for --mic). */
  | { type: 'mic'; source: 'wav' | 'silence' | 'live'; wav?: ArrayBuffer }
  | { type: 'micPush'; rate: number; data: Float32Array }
  /** Ask for the live mic recording as a 16-bit WAV, answered with micRec (F-09c) */
  | { type: 'micRecGet' }
  /** USB <-> external 5 V (logged: power=usb|ext). */
  | { type: 'power'; mode: PowerMode }
  | { type: 'analog'; pin: number; mv: number }
  /** ADC model toggle (D-02, logged: adc=ideal|real) */
  | { type: 'adcMode'; ideal: boolean }
  /** Pins whose recent ADC conversions go into tick.adc */
  | { type: 'watchAdc'; pins: number[] }
  | { type: 'run' }
  | { type: 'pause' }
  /** Test hook (R-04): make the core panic, to exercise the crash card. */
  | { type: 'debugPanic' }
  | { type: 'speed'; factor: number }
  | { type: 'hidden'; hidden: boolean }
  | { type: 'gpio'; pin: number; level: number }
  | { type: 'uart'; text: string }
  | { type: 'usbcdc'; text: string }
  /** Virtual phone action (C-01, logged: ble=<cmd>). */
  | { type: 'ble'; cmd: string }
  /** Virtual voice server action (F-09b-2, logged as xz=…): on / off / script,<name> / say,<text> / min,N / voice,demo|noise */
  | { type: 'xz'; cmd: string }
  /** One virtual-phone step (C-02, logged as phone=…): on / join,ssid[,pass] / leave / open / get,url / post,url,body */
  | { type: 'phone'; cmd: string }
  /** "Real network" toggle (C-03): chip HTTP to the internet goes through browser fetch; replies are logged as netreply=… */
  | { type: 'realnet'; on: boolean }
  /** Network conditions (D-01): preset (logged net=…) / one fault starting now (logged netfault=…) */
  | { type: 'netPreset'; preset: string }
  | { type: 'netFault'; fault: string; dur?: number }
  /** Sample PWM on these pins each slice; changes go into tick pwmEvents with sim time (for the buzzer). */
  | { type: 'watchPwm'; pins: number[] }
  /** Request the input log since power-up; answered with an inputlog message. */
  | { type: 'getInputLog' }
  /** F-11 environment scenario: stamped events applied at their sim times; fresh = right after a power-up / seek, else only future ones replace the queue */
  | { type: 'scenario'; events: InputEvent[]; fresh: boolean }
  /** Input log + full serial + observations since power-up (for the run fingerprint), answered with snapshot; does not interrupt. */
  | { type: 'snapshot' }
  /** Timeline rewind (P0-03): power up, apply the log at original sim times, fast-forward to untilMs and stop (not wall clock); answers seeked. */
  | {
      type: 'seek';
      /** Compiled once on the main thread (R-23); structured clone shares the code, no recompile. */
      wasm: WebAssembly.Module;
      /** ROM / firmware bytes, omitted when the worker already holds that id (cached per worker). */
      rom?: ArrayBuffer;
      romId: number;
      flash?: ArrayBuffer;
      flashId: number;
      i2c?: { kind: string; addr: number }[];
      env?: Env;
      lcd?: boolean | LcdKind;
      battery?: Battery;
      servo?: number;
      power?: PowerMode;
      encoder?: EncoderSpec;
      sonar?: SonarSpec;
      /** DHT11 data GPIO (open drain; readings follow env) */
      dht11?: number;
      touchInt?: number;
      board?: string;
      /** Grove unit on the preset's Port A (M5-09d, = CLI --grove: env3 / env4), right after the preset */
      grove?: string;
      /** F-04a parts (DS18B20 / PIR / relay / LDR / RC522), = CLI --ds18b20 / --pir / --relay / --ldr / --spi rc522 */
      parts?: PartsDevs;
      i2s?: string[];
      micWav?: ArrayBuffer;
      micName?: string;
      /** Inputs applied after power-up (excluding boot and boot env); time = sim time they were applied. */
      events: InputEvent[];
      untilMs: number;
      realnet?: boolean;
      net?: string;
      /** F-03b paced replay: power up and stop at 0 (answers seeked); the next run applies events at their sim time, answers replayed at untilMs */
      paced?: boolean;
    }
  /** Mark a point in time: answered with mark (which sim millisecond this step happened at). */
  | { type: 'mark'; id: number }
  /** GPIOs the logic analyser watches (bitmask, lo = GPIO0..31, hi = GPIO32..); kept for later power-ups. */
  | { type: 'ioWatch'; lo: number; hi: number };

/** Recent conversions on one pin: raw codes and what calibrated firmware would report (mV). */
export interface AdcSamples {
  raw: number[];
  mv: number[];
}

/** Harness (P2-11): negative i2cWire = ideal bus. */
export interface Harness {
  i2cWire?: number;
  antenna?: number;
}

/** One PWM change on a pin (sim time t in s; duty < 0 means PWM stopped). */
export interface PwmEvent {
  pin: number;
  t: number;
  duty: number;
  freq: number;
}

/** A chunk of speaker (MAX98357A) output: t = sim time of the first sample (s), mono 16-bit. */
export interface PcmBlock {
  t: number;
  rate: number;
  data: Int16Array;
}

/** Audio readings (sim side, last second): rate, RMS and pitch of PCM the speaker got; frames the mic sent. */
export interface AudioFrame {
  rate: number;
  frames: number;
  rms: number;
  freq: number;
  peak: number;
  micFrames: number;
}

export type FromWorker =
  | { type: 'booted'; chip: 'esp32' | 'esp32c3' | 'esp32s3'; bootPin: number }
  | { type: 'error'; message: string }
  | {
      type: 'tick';
      console: string;
      gpio: number;
      enable: number;
      /** Levels / enables of GPIO32 and up (S3). */
      gpioHi: number;
      enableHi: number;
      pwm: number[];
      /** PWM frequency per pin (Hz, 0 without PWM). */
      pwmFreq: number[];
      /** Changes on watchPwm pins since the last tick (in time order). */
      pwmEvents?: PwmEvent[];
      simSeconds: number;
      ratio: number;
      running: boolean;
      leds?: number[][];
      /** External WS2812 strips (pins other than the on-board LED) with a new frame: pin -> [r,g,b] per LED. */
      strips?: Record<number, number[][]>;
      elec?: ElecFrame;
      /** Brown-out resets since the last tick (sim time, s). */
      brownouts?: number[];
      /** Encoder / ultrasonic (only when attached). */
      pins?: PinDevFrame;
      /** Readings when an I2S audio device is attached. */
      audio?: AudioFrame;
      /** Recent ADC conversions on watchAdc pins (oldest first, at most 48). */
      adc?: Record<number, AdcSamples>;
    }
  /** Speaker sound (only with MAX98357A), scheduled into Web Audio on sim time. */
  | { type: 'pcm'; blocks: PcmBlock[] }
  | { type: 'oled'; pixels: Uint8Array }
  /** Screen frame w×h RGBA (GC9A01 240×240, CO5300 480×480), sent only when the picture changes. */
  | { type: 'lcd'; pixels: Uint8Array; w: number; h: number }
  /** Native USB virtual host state (JSON, shape in usb3d.ts UsbView), sent on change. */
  | { type: 'usb'; json: string }
  /** BLE (C-01): state 0 = firmware does not use BLE, 1 = controller running, 2 = VHCI boundary not found (json is {"error"}).
   *  json is {"view", "log"} with new air-log lines only; reset = new power-up / rewind; cmdError = why the last phone command was refused. */
  | { type: 'ble'; state: number; json: string; reset?: boolean; cmdError?: string }
  /** Voice server (F-09b-2): json is {"script","sessions","turns","up","down","log":[[us,line]]} with new log lines only ("" = server off);
   *  reset = new power-up / rewind */
  | { type: 'xz'; json: string; reset?: boolean }
  /** Harness verdict (same text as the CLI: I2C rise time, RSSI after antenna loss), sent on change. */
  | { type: 'harness'; text: string }
  /** Timing-sensitive code report (D-03): JSON {"line","items":[{pin,kind,n}]} or {}; sent on change */
  | { type: 'timing'; json: string }
  /** Fine capture state, sent on change; vcdText answers vcdGet (byte-identical to CLI --vcd) */
  | { type: 'vcd'; state: VcdState | null }
  | { type: 'vcdText'; text: string; state: VcdState | null }
  /** Network tab (C-02): whether the firmware used Wi-Fi, what the virtual phone sees (JSON, shape in app/netfeed.ts), the chip's request log; sent only when changed */
  | { type: 'net'; used: boolean; phone?: string; rows?: string; replies?: number; replyBytes?: number }
  | { type: 'inputlog'; log: InputLog }
  | { type: 'snapshot'; snap: Snapshot | null }
  | { type: 'seekProgress'; simSeconds: number }
  | { type: 'seeked'; snap: Snapshot; bootPin: number }
  /** Paced replay (F-03b) reached untilMs: same cycle and snapshot as seek's; the run keeps going live */
  | { type: 'replayed'; snap: Snapshot }
  | { type: 'mark'; id: number; tMs: number }
  /** Live mic recording since power-up (null = nothing live heard, or over the length cap: full) */
  | { type: 'micRec'; wav: ArrayBuffer | null; full: boolean }
  /** Logic analyser events (raw tb_io_take records, 16 bytes each); reset = new power-up, earlier ones void. */
  | { type: 'io'; reset: boolean; data: Uint8Array; dropped: number }
  /** FreeRTOS task switches (raw tb_tasks_take records, 16 bytes each) + task table JSON; reset = new power-up. */
  | { type: 'tasks'; reset: boolean; data: Uint8Array; table: string; chip: string }
  | { type: 'stopped'; reason: string }
  /** The core trapped (Rust panic or wasm fault): simulator bug, not firmware behaviour; the instance is dead until the next boot. */
  | { type: 'crash'; message: string };

/** Full record of a power-up so far: fingerprint = fingerprint(stdout, report), same algorithm as the acceptance worker / CLI. */
export interface Snapshot {
  log: InputLog;
  stdout: string;
  report: string;
  simSeconds: number;
  /** Serial output too long to keep in full (fingerprint unavailable). */
  truncated: boolean;
}
