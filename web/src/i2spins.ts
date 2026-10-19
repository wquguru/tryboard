// 单独成文件：app/wiring.ts 等纯函数模块（node --test 直接跑）要用，不能把 three.js 一起拉进来
import type { ChipId } from './board3d';

/** I2S 音频器件在各芯片上的固定接线（内核按这个接线判断喇叭 / 麦克风接没接上，见 core 的 i2s_pin）。
 *  C3 只有一个 I2S，喇叭和麦克风共用 BCK / WS */
export const I2S_WIRING: Record<ChipId, { spk: { bclk: number; lrc: number; din: number }; mic: { sck: number; ws: number; sd: number } }> = {
  esp32s3: { spk: { bclk: 16, lrc: 17, din: 18 }, mic: { sck: 39, ws: 40, sd: 41 } },
  esp32c3: { spk: { bclk: 0, lrc: 1, din: 2 }, mic: { sck: 0, ws: 1, sd: 3 } },
  // 内核还没给 ESP32 接 I2S（C-05 范围外），常用接法占位
  esp32: { spk: { bclk: 26, lrc: 25, din: 22 }, mic: { sck: 32, ws: 25, sd: 33 } },
};
