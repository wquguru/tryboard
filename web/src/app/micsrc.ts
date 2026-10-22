// Mic source and voice-server boot inputs, split out of createSession (F-09b-2) to keep it within the size guardrail.
import type { LiveSim } from '../live';
import { fetchBuf } from '../assets';
import { MicInput } from '../micinput';
import { t } from '../i18n';
import type { actions } from './chrome';
import type { Session } from './types';

interface MicHost {
  sim: LiveSim | null;
  micSource: string;
}

let current: MicInput | null = null;
/** Browser mic input level (RMS, full scale 1) while the live source is on, else 0 */
export const micLevel = () => (current?.state.on ? current.state.level : 0);

/** Switch the mic between the browser microphone, silence and a bundled WAV ('sample' = the work's own clip, `fallback`);
 *  resolves to a user-facing error or '' */
export function micSwitcher(s: MicHost, fallback: string) {
  const mic = (current = new MicInput());
  const set = async (src: string): Promise<string> => {
    if (src === 'sample') src = fallback;
    s.micSource = src;
    mic.stop();
    if (src === 'live') {
      const err = await mic.start((rate, data) => s.sim?.micPush(rate, data));
      if (!err) {
        s.sim?.setMic('live');
        return '';
      }
      // No permission / device: fall back to the work's sample clip.
      await set(fallback);
      return t('{err}; switched back to the sample clip', { err });
    }
    if (src === 'silence') s.sim?.setMic('silence');
    else s.sim?.setMic('wav', await fetchBuf(`./audio/${src}`), src);
    return '';
  };
  return set;
}

/** Attach the WAV before boot (browser mic waits until onBoot); LiveSim.prepare awaits the returned promise */
export function preloadMic(sim: LiveSim, src: string, fallback: string): Promise<unknown> {
  const wav = src.endsWith('.wav') ? src : fallback;
  return fetchBuf(`./audio/${wav}`)
    .then((b) => (src === 'silence' ? sim.setMic('silence') : sim.setMic('wav', b, wav)))
    .catch(() => {});
}

/** Voice server inputs at power-up: logged like any input so --inputs replays them; the demo voice matches the accept cases */
export function xzBoot(sim: LiveSim, script: string | null) {
  if (!script) return;
  sim.xz('on');
  sim.xz('voice,demo');
  if (script !== 'hello') sim.xz(`script,${script}`);
}

/** Voice tab mic actions (F-09c): sample clip / my microphone, and the live recording as a `--mic` WAV download */
export function bindVoiceMic(acts: typeof actions, session: Session) {
  acts.mic = async (which) => {
    const msg = await session.setMicSource(which);
    const sel = document.getElementById('micSource') as HTMLSelectElement | null;
    if (sel) sel.value = session.micSource;
    return msg;
  };
  acts.micNow = () => ({ live: session.micSource === 'live', level: micLevel() });
  acts.micExport = async () => {
    const r = await session.sim?.micRecording();
    if (!r?.wav) return r?.full ? t('The live recording passed 10 minutes; reboot to start a new one') : t('Nothing heard from your microphone since power-up yet');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([r.wav], { type: 'audio/wav' }));
    a.download = `${(session.fwName || 'tryboard').replace(/\/flash\.bin$|\.bin$/, '').replaceAll('/', '-')}-mic.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return '';
  };
}
