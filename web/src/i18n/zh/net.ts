// Network area (C-02 / C-03): Network tab, real-network switch, needs-internet notes.
import type { Dict } from '../index.ts';

const d: Dict = {
  "Network": "网络",
  " · needs internet": " · 需联网",
  "Needs internet · ": "需联网 · ",
  "Needs internet · no run ID; replays use the recorded replies (Network tab: Save replies, replay offline).": "需联网 · 没有运行 ID；回放用录下的回复（网络页：保存回复，离线回放）。",
  "Reference firmware passed (needs internet; your record is kept)": "参考固件通过了（需联网，你的记录保留）",
  "Reference firmware did not pass (needs internet; your record is kept)": "参考固件没通过（需联网，你的记录保留）",
  "Real network: on": "真实网络：开",
  "Real network: off": "真实网络：关",
  "Tap to go back to the virtual network": "点一下回到虚拟网络",
  "The chip's HTTP requests really go out through the browser": "芯片的 HTTP 请求真的经浏览器发出去",
  "Replies saved: tryboard run --inputs replays them offline, no network needed": "回复已保存：tryboard run --inputs 可离线回放，不用联网",
};
export default d;
