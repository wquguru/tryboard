// Mic source and voice-server boot inputs, split out of createSession (F-09b-2) to keep it within the size guardrail.
import type { LiveSim } from '../live';
import { fetchBuf } from '../assets';
import { MicInput } from '../micinput';
import { t } from '../i18n';

interface MicHost {
  sim: LiveSim | null;
  micSource: string;
}

/** Switch the mic between the browser microphone, silence and a bundled WAV; resolves to a user-facing error or '' */
export function micSwitcher(s: MicHost) {
  const mic = new MicInput();
  const set = async (src: string): Promise<string> => {
    s.micSource = src;
    mic.stop();
    if (src === 'live') {
      const err = await mic.start((rate, data) => s.sim?.micPush(rate, data));
      if (!err) {
        s.sim?.setMic('live');
        return '';
      }
      // No permission / device: fall back to the test tone.
      await set('sine1k.wav');
      return t('{err}; switched back to the 1 kHz test tone', { err });
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
