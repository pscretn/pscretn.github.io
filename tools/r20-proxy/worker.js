/* R20 Personality Generator: photo reading proxy (Cloudflare Worker).

   The TrilitLabs page sends the chart photo here; this Worker adds the Gemini
   API key and asks Google. The key never reaches the browser: it lives only in
   the Worker's settings as the secret GEMINI_KEY.

   Set up (free Cloudflare account):
     1. dash.cloudflare.com → Workers & Pages → Create → Worker → Deploy,
        then Edit code, replace everything with this file, Deploy.
     2. The Worker → Settings → Variables and Secrets → Add → type Secret,
        name GEMINI_KEY, value: your key from aistudio.google.com/app/apikey.
     3. Copy the Worker's URL (https://<name>.<you>.workers.dev) into
        R20_AI_PROXY in trilitlabs.html.

   Use a key from a Google project with no billing, so it can only ever use the
   free tier. When every model's free quota is used up this answers 429, and the
   page switches the visitor to typing the channel list in. */

const ALLOWED = ['https://pscretn.com', 'https://www.pscretn.com', 'https://pscretn.github.io'];
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const MAX_BYTES = 12 * 1024 * 1024;   // a few phone photos, already shrunk by the page
const API = 'https://generativelanguage.googleapis.com/v1beta';

/* Timing. Flash models are often busy, so if one hasn't answered after
   HEDGE_MS the next is asked as well, and the first good answer wins. */
const HEDGE_MS = 15000;               // start the next model after this long
const PER_MODEL_MS = 60000;           // give up on one model after this long
const TOTAL_MS = 95000;               // the visitor never waits longer than this

/* Models that failed are left out for a while: retired ones for a day, ones
   out of free quota for 10 minutes, busy ones for 2 minutes. */
const resting = new Map();            // model → time it may be tried again
const rest = (model, ms) => resting.set(model, Date.now() + ms);

/* Google renames and retires models often, so ask which ones this key can
   use (cached for an hour): the newest plain Flash models first, then the
   faster Flash-Lite ones as a backstop. */
let modelCache = { at: 0, list: null };
const version = (n) => parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
const usable = (n) => /^gemini-/.test(n) && !/image|tts|live|audio|embed|robotics|native|computer|thinking|learnlm|preview|exp/.test(n);
async function models(key) {
  if (modelCache.list && Date.now() - modelCache.at < 3600e3) return modelCache.list;
  try {
    const r = await fetch(`${API}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
    const j = await r.json();
    const names = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter(usable);
    const newest = (re) => names.filter((n) => re.test(n)).sort((a, b) => version(b) - version(a));
    const list = [...new Set([
      ...newest(/^gemini-[\d.]+-flash$/).slice(0, 3),
      ...newest(/^gemini-[\d.]+-flash-lite$/).slice(0, 2),
      ...names.filter((n) => FALLBACK_MODELS.includes(n)),
    ])];
    if (list.length) { modelCache = { at: Date.now(), list }; return list; }
  } catch {}
  return FALLBACK_MODELS;
}

/* One model, one try. Newer models are asked to think briefly, which makes
   reading a chart much faster; if a model rejects that setting, ask plainly. */
async function ask(model, key, contents, cancel) {
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const base = { responseMimeType: 'application/json', temperature: 0 };
  let config = version(model) >= 3 ? { ...base, thinkingConfig: { thinkingLevel: 'low' } } : base;
  for (;;) {
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    cancel.addEventListener('abort', stop);
    const timer = setTimeout(stop, PER_MODEL_MS);
    let r, j;
    try {
      r = await fetch(`${API}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents, generationConfig: config }),
        signal: ctl.signal,
      });
      j = await r.json().catch(() => ({}));
    } catch {
      return { model, status: 0, note: cancel.aborted ? 'cancelled' : `no answer in ${secs()}` };
    } finally {
      clearTimeout(timer);
      cancel.removeEventListener('abort', stop);
    }
    if (r.ok) {
      const text = (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
      return text ? { model, text, secs: secs() } : { model, status: 200, note: 'empty answer' };
    }
    const msg = j?.error?.message || '';
    if (r.status === 400 && config.thinkingConfig && /thinking/i.test(msg)) { config = base; continue; }
    return { model, status: r.status, note: `${r.status} after ${secs()}`, msg };
  }
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Vary': 'Origin',
    };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'content-type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
    if (!ALLOWED.includes(origin)) return json({ error: 'Not allowed from this site' }, 403);
    if (!env.GEMINI_KEY) return json({ error: 'Photo reading is not set up yet' }, 503);

    const raw = await req.text();
    if (raw.length > MAX_BYTES) return json({ error: 'Photos are too large' }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: 'Bad request' }, 400); }
    if (!Array.isArray(body.contents)) return json({ error: 'Bad request' }, 400);

    const all = await models(env.GEMINI_KEY);
    let order = all.filter((m) => !(resting.get(m) > Date.now()));
    if (!order.length) order = all;   // everything resting: try them all anyway

    const cancel = new AbortController();
    const deadline = Date.now() + TOTAL_MS;
    const running = new Set();
    const skipped = [];               // which models didn't answer, and why: in the reply for debugging
    let next = 0, limited = false, last = '';
    const launch = () => {
      if (next >= order.length) return;
      const p = ask(order[next++], env.GEMINI_KEY, body.contents, cancel.signal).then((res) => ({ p, res }));
      running.add(p);
    };

    launch();
    while (running.size) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const tick = new Promise((res) => setTimeout(() => res(null), next < order.length ? Math.min(HEDGE_MS, left) : left));
      const done = await Promise.race([...running, tick]);
      if (!done) { launch(); continue; }               // still waiting: ask the next model too
      running.delete(done.p);
      const r = done.res;
      if (r.text) {
        cancel.abort();
        return json({ text: r.text, model: r.model, secs: r.secs, skipped });
      }
      skipped.push(`${r.model}: ${r.note}`);
      if (r.status === 429) { limited = true; rest(r.model, 10 * 60e3); }
      else if (r.status === 404 || /no longer available|not found|not supported/i.test(r.msg || '')) { rest(r.model, 24 * 3600e3); last = r.msg; }
      else { rest(r.model, 2 * 60e3); if (r.msg) last = r.msg; }
      launch();                                        // replace the one that failed
    }
    cancel.abort();
    if (running.size) skipped.push(`${running.size} still waiting when time ran out`);
    return limited ? json({ error: 'Free limit reached', skipped }, 429) : json({ error: last || 'No model answered in time', skipped }, 502);
  },
};
