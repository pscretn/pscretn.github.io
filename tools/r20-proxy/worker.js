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
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];
const MAX_BYTES = 12 * 1024 * 1024;   // a few phone photos, already shrunk by the page
const API = 'https://generativelanguage.googleapis.com/v1beta';

/* Google renames and retires models often, so ask which ones this key can use
   (cached for an hour) and try the newest plain Flash first, then Flash-Lite. */
let modelCache = { at: 0, list: null };
function score(n) {
  if (!/^gemini-/.test(n) || /image|tts|live|audio|embed|robotics|native|computer|thinking|learnlm|preview|exp/.test(n)) return -1;
  const v = parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
  if (/^gemini-[\d.]+-flash$/.test(n)) return 3000 + v * 10;
  if (n === 'gemini-flash-latest') return 2500;
  if (/^gemini-[\d.]+-flash-lite$/.test(n)) return 2000 + v * 10;
  if (n === 'gemini-flash-lite-latest') return 1500;
  return -1;
}
async function models(key) {
  if (modelCache.list && Date.now() - modelCache.at < 3600e3) return modelCache.list;
  try {
    const r = await fetch(`${API}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
    const j = await r.json();
    const list = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => score(n) >= 0)
      .sort((a, b) => score(b) - score(a))
      .slice(0, 5);
    if (list.length) { modelCache = { at: Date.now(), list }; return list; }
  } catch {}
  return FALLBACK_MODELS;
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

    /* forward only the chart prompt and photos; the settings are fixed here */
    const upstream = JSON.stringify({ contents: body.contents, generationConfig: { responseMimeType: 'application/json', temperature: 0 } });

    let limited = false, last = '';
    const skipped = [];                    // which models refused, and why: shown in the reply for debugging
    for (const model of await models(env.GEMINI_KEY)) {
      const r = await fetch(`${API}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
        body: upstream,
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        const text = (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
        if (text) return json({ text, model, skipped });
        last = 'Empty answer';
        skipped.push(model + ': empty answer');
        continue;
      }
      skipped.push(model + ': ' + r.status);
      if (r.status === 429) { limited = true; continue; }   // each model has its own free quota
      last = j?.error?.message || 'HTTP ' + r.status;
    }
    return limited ? json({ error: 'Free limit reached', skipped }, 429) : json({ error: last || 'No model answered', skipped }, 502);
  },
};
