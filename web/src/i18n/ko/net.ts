// Network area (C-02 / C-03): Network tab, real-network switch, needs-internet notes.
import type { Dict } from '../index.ts';

const d: Dict = {
  "Network": "네트워크",
  " · needs internet": " · 인터넷 필요",
  "Needs internet · ": "인터넷 필요 · ",
  "Needs internet · no run ID; replays use the recorded replies (Network tab: Save replies, replay offline).": "인터넷 필요 · 실행 ID가 없어 재생 시 기록된 응답을 사용합니다(네트워크 탭: 응답 저장, 오프라인 재생).",
  "Reference firmware passed (needs internet; your record is kept)": "참조 펌웨어 통과(인터넷 필요, 기록은 유지됨)",
  "Reference firmware did not pass (needs internet; your record is kept)": "참조 펌웨어 미통과(인터넷 필요, 기록은 유지됨)",
  "Real network: on": "실제 네트워크: 켜짐",
  "Real network: off": "실제 네트워크: 꺼짐",
  "Tap to go back to the virtual network": "탭하면 가상 네트워크로 돌아갑니다",
  "The chip's HTTP requests really go out through the browser": "칩의 HTTP 요청이 실제로 브라우저를 통해 나갑니다",
  "Replies saved: tryboard run --inputs replays them offline, no network needed": "응답 저장됨: tryboard run --inputs로 오프라인 재생 가능, 인터넷 불필요",
};
export default d;
