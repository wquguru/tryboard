// Network area (C-02 / C-03): Network tab, real-network switch, needs-internet notes.
import type { Dict } from '../index.ts';

const d: Dict = {
  "Network": "ネットワーク",
  " · needs internet": " · ネット接続が必要",
  "Needs internet · ": "ネット接続が必要 · ",
  "Needs internet · no run ID; replays use the recorded replies (Network tab: Save replies, replay offline).": "ネット接続が必要 · 実行 ID がないため、リプレイでは記録した応答を使います（ネットワークタブ：応答を保存してオフラインでリプレイ）。",
  "Reference firmware passed (needs internet; your record is kept)": "参照ファームウェアは合格（ネット接続が必要、記録は残ります）",
  "Reference firmware did not pass (needs internet; your record is kept)": "参照ファームウェアは不合格（ネット接続が必要、記録は残ります）",
  "Real network: on": "実ネットワーク：オン",
  "Real network: off": "実ネットワーク：オフ",
  "Tap to go back to the virtual network": "タップで仮想ネットワークに戻る",
  "The chip's HTTP requests really go out through the browser": "チップの HTTP リクエストが実際にブラウザ経由で送信されます",
  "Replies saved: tryboard run --inputs replays them offline, no network needed": "応答を保存しました：tryboard run --inputs でオフライン再生でき、ネット接続は不要です",
};
export default d;
