// 「真实网络」（C-03）：芯片发往 tryboard.local 以外的 HTTP 请求，由浏览器 fetch 真发出去，
// 回复写成一条脚本动作 netreply=…（进输入日志）再施加给内核：网页实时运行、检查点验收、命令行重放都只认这条动作，
// 所以回放 / 重放逐字节相同，不会再去联网。只放行 HTTP（HTTPS 内核直接拒绝，见 DECISIONS 2026-10-19 C-03）。

/** 内核发件箱里的一条请求（tb_net_outbox 的 JSON） */
export interface RealReq {
  id: number;
  method: string;
  url: string;
  ctype?: string;
  /** 请求体 base64（POST 才有） */
  body?: string;
}

export interface RealReply {
  /** 脚本动作：netreply=id,状态,毫秒,内容类型或原因代号,base64 正文 */
  action: string;
  status: number;
  ms: number;
  bytes: number;
  reason?: string;
}

/** 回复正文上限：再大也只给芯片前 64KB（输入日志一行放得下，芯片的缓冲区也远小于这个） */
export const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 10_000;

function b64(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s: string) {
  const t = atob(s);
  const b = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
  return b;
}

/** 内容类型只留媒体类型、去掉逗号分号空白：脚本用 `; ` 分隔动作、netreply 用逗号分字段 */
const cleanType = (t: string | null) => (t ?? 'application/octet-stream').split(';')[0].replace(/[\s,;]/g, '') || 'application/octet-stream';

export async function realFetch(r: RealReq): Promise<RealReply> {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const ms = () => Math.round(performance.now() - t0);
  const fail = (reason: string): RealReply => ({ action: `netreply=${r.id},0,${ms()},${reason},`, status: 0, ms: ms(), bytes: 0, reason });
  try {
    const res = await fetch(r.url, {
      method: r.method,
      body: r.body && r.method !== 'GET' && r.method !== 'HEAD' ? unb64(r.body) : undefined,
      // 只带内容类型：其余请求头会触发预检，也多半是浏览器不许页面设置的
      headers: r.ctype ? { 'Content-Type': r.ctype } : undefined,
      credentials: 'omit',
      cache: 'no-store',
      signal: ac.signal,
    });
    const body = new Uint8Array(await res.arrayBuffer()).subarray(0, MAX_BODY);
    return { action: `netreply=${r.id},${res.status},${ms()},${cleanType(res.headers.get('content-type'))},${b64(body)}`, status: res.status, ms: ms(), bytes: body.length };
  } catch {
    if (ac.signal.aborted) return fail('timeout');
    // https 页面里发 http 请求：浏览器按混合内容直接拦下，与跨域无关
    if (typeof location !== 'undefined' && location.protocol === 'https:' && r.url.startsWith('http:')) return fail('mixed');
    // 分清跨域和连不上：no-cors 再试一次，能拿到不透明回复说明对方在线、只是没给跨域头。
    // 只对 GET 重试——POST 再发一次会让对方真的再收一遍
    if (r.method !== 'GET') return fail('blocked');
    try {
      await fetch(r.url, { mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: ac.signal });
      return fail('cors');
    } catch {
      return fail(ac.signal.aborted ? 'timeout' : 'net');
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 原因代号 → 给人看的一句话（与内核网络页签那一行的说明同一套） */
export const REASON: Record<string, string> = {
  cors: '对方网站不允许跨域（CORS），浏览器拦下了',
  net: '连不上（域名不存在、断网或被拦）',
  timeout: '10 秒没有回应',
  mixed: '页面是 https，浏览器不许发 http 请求（混合内容）',
  blocked: '浏览器拦下了（跨域或网络错误）',
};
