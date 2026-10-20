// F-04a bench parts (F-04d tutorial models: core soc/devices/gpio_parts.rs and rc522.rs), spread into PARTS.
import { GND, P, pin, VCC } from './partdraft.ts';
import type { Part } from './parts.ts';

export const BENCH_PARTS: Part[] = [
  P({
    id: 'hc-sr501',
    name: 'HC-SR501 PIR motion sensor module',
    kind: 'sensor',
    model: 'HC-SR501 (BISS0001)',
    pins: [VCC('VCC'), pin('OUT', 'digital-out', 3.3, { dir: 'out', note: '3.3 V high while motion is seen, held for the delay pot time' }), GND()],
    voltage: { supply: [4.5, 20], logic: 3.3 },
    currentMa: { typ: 0.065, peak: 0.065, est: false, source: 'HC-SR501 module notes: quiescent current under 65 µA' },
    sizeMm: [32, 24, 25],
    sim: { level: 'verified', model: 'pir' },
    price: [3, 8],
    keywords: 'HC-SR501 人体红外感应模块', // lint: allow-cjk
    supplyNet: '5V',
    sources: ['HC-SR501 module manual'],
    todo: ['sizeMm[2]: height with the Fresnel dome varies by seller'],
    note: 'Needs 5 V on VCC; OUT is 3.3 V, safe for any GPIO. After power-up it settles for about a minute (not simulated). The jumper picks repeatable (H) or single (L) triggering; the simulator models H.',
  }),
  P({
    id: 'relay-1ch',
    name: '1-channel 5 V relay module',
    kind: 'actuator',
    model: 'SRD-05VDC-SL-C relay module with optocoupler',
    pins: [VCC('VCC'), GND(), pin('IN', 'digital-in', null, { dir: 'in', note: 'High-level trigger by default; some boards have an H / L jumper' })],
    voltage: { supply: [5, 5], logic: null },
    currentMa: { typ: 70, peak: 75, est: true, source: 'SRD-05VDC coil about 70 mA at 5 V (estimate, module LED included)' },
    sizeMm: [50, 26, 19],
    sim: { level: 'verified', model: 'relay' },
    price: [3, 8],
    keywords: '5V 一路继电器模块 光耦隔离 高低电平触发', // lint: allow-cjk
    supplyNet: '5V',
    sources: ['Songle SRD-05VDC-SL-C datasheet'],
    todo: ['voltage.logic: input threshold depends on the module (optocoupler or transistor)'],
    note: 'The coil runs on 5 V; 3.3 V GPIO is enough for the input on most modules. Mains wiring on the contacts is dangerous: keep the simulation to low-voltage loads.',
  }),
  P({
    id: 'ldr-module',
    name: 'Photoresistor light sensor module (analog)',
    kind: 'sensor',
    model: 'GL5528 photoresistor + 10 kΩ divider',
    pins: [VCC('VCC'), GND(), pin('AO', 'analog', null, { dir: 'out', note: 'Divider output: brighter = higher voltage' })],
    voltage: { supply: [3.3, 5], logic: null },
    currentMa: { typ: 0.3, peak: 0.33, est: true, source: '3.3 V across 10 kΩ + LDR (estimate)' },
    sizeMm: [32, 14, 8],
    sim: { level: 'verified', model: 'ldr' },
    price: [1, 5],
    keywords: '光敏电阻模块 GL5528 模拟输出', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['GL5528 photoresistor datasheet'],
    todo: ['voltage.logic: analog output', 'sizeMm: outline varies by seller'],
    note: 'Power it from 3V3, not 5 V, so AO never exceeds the ADC range. The reading is a rough light level, not a calibrated lux meter.',
  }),
  P({
    id: 'rc522',
    name: 'RC522 RFID reader module (13.56 MHz)',
    kind: 'module',
    model: 'NXP MFRC522',
    pins: [pin('SDA', 'spi-cs', 3.3, { dir: 'in' }), pin('SCK', 'spi-sclk', 3.3, { dir: 'in' }), pin('MOSI', 'spi-mosi', 3.3, { dir: 'in' }), pin('MISO', 'spi-miso', 3.3, { dir: 'out' }), pin('IRQ', 'nc', null), GND(), pin('RST', 'rst', 3.3, { dir: 'in' }), pin('3.3V', 'power', 3.3)],
    voltage: { supply: [3.3, 3.3], logic: 3.3 },
    currentMa: { typ: 13, peak: 26, est: false, source: 'MFRC522 datasheet: 13–26 mA with the antenna driver on' },
    sizeMm: [60, 39, null],
    sim: { level: 'verified', model: 'rc522' },
    price: [5, 12],
    keywords: 'RC522 RFID 射频模块 IC卡 13.56MHz', // lint: allow-cjk
    supplyNet: '3V3',
    sources: ['NXP MFRC522 datasheet'],
    todo: ['sizeMm[2]: depends on the header'],
    note: '3.3 V only. The simulator reads card UIDs; MIFARE authentication and block reads are not modelled.',
  }),
];
