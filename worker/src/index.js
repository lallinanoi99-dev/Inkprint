// Inkprint Worker — POST /detect and POST /extract-url.
// Holds the detector API key as a Worker secret so it never reaches the browser.
// Submitted text is never logged or stored: it goes to the detector and the answer comes straight back.
// Both routes are self-contained, so they can be merged into the shared Week 1 Worker.

export const MIN_CHARS = 40;
export const MAX_CHARS = 10_000;
const MAX_BODY_BYTES = 64_000;
const RATE_LIMIT = 10; // scans (and URL fetches) per IP per window
const RATE_WINDOW_MS = 60 * 60 * 1000;
const DETECT_TIMEOUT_MS = 12_000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

// ------------------------------------------------------------------
// Detectors. Each adapter returns { score: 0..1, sentences: [{ text, score: 0..1 }] }.
// ------------------------------------------------------------------
export const DETECTORS = {
  // https://sapling.ai/docs/api/detector — key in the body, score 0..1 (1 = AI), per-sentence scores.
  sapling: {
    name: 'Sapling AI Detector',
    async run(text, key, signal) {
      const res = await fetch('https://api.sapling.ai/api/v1/aidetect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, text, sent_scores: true }),
        signal,
      });
      if (!res.ok) throw upstream(res.status);
      const data = await res.json();
      return {
        score: Number(data.score),
        sentences: (data.sentence_scores || []).map((s) => ({ text: String(s.sentence ?? ''), score: Number(s.score) })),
      };
    },
  },
  // https://gptzero.me/docs — key in a header, document-level and per-sentence probabilities.
  gptzero: {
    name: 'GPTZero',
    async run(text, key, signal) {
      const res = await fetch('https://api.gptzero.me/v2/predict/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ document: text }),
        signal,
      });
      if (!res.ok) throw upstream(res.status);
      const doc = (await res.json())?.documents?.[0] || {};
      return {
        score: Number(doc.completely_generated_prob ?? doc.average_generated_prob),
        sentences: (doc.sentences || []).map((s) => ({ text: String(s.sentence ?? ''), score: Number(s.generated_prob) })),
      };
    },
  },
};

const upstream = (status) => Object.assign(new Error(`detector ${status}`), { status });
const clamp01 = (n) => Math.min(1, Math.max(0, n));

// Keep only well-formed numbers; drop the rest rather than invent anything.
export function tidyResult(raw) {
  if (!raw || !Number.isFinite(raw.score)) return null;
  const sentences = (raw.sentences || [])
    .filter((s) => s.text.trim() && Number.isFinite(s.score))
    .map((s) => ({ text: s.text.replace(/\s+/g, ' ').trim().slice(0, 2000), score: Math.round(clamp01(s.score) * 1000) / 1000 }));
  return { score: Math.round(clamp01(raw.score) * 1000) / 1000, sentences };
}

// ------------------------------------------------------------------
// Rate limit + CORS (same pattern as the other Build Week Workers)
// ------------------------------------------------------------------
const memoryHits = new Map(); // per-isolate fallback when no KV namespace is bound as RATE_KV

async function overLimit(env, ip, route) {
  const bucket = Math.floor(Date.now() / RATE_WINDOW_MS);
  const key = `rl:${route}:${ip}:${bucket}`;
  const limit = Number(env.RATE_LIMIT) || RATE_LIMIT;
  if (env.RATE_KV) {
    const count = Number(await env.RATE_KV.get(key)) || 0;
    if (count >= limit) return true;
    await env.RATE_KV.put(key, String(count + 1), { expirationTtl: 2 * 60 * 60 });
    return false;
  }
  for (const k of memoryHits.keys()) if (!k.endsWith(`:${bucket}`)) memoryHits.delete(k);
  const count = memoryHits.get(key) || 0;
  if (count >= limit) return true;
  memoryHits.set(key, count + 1);
  return false;
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return origin && allowed.includes(origin) ? origin : null;
}

function json(body, status, origin) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}

async function readJson(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return { tooLarge: true };
  try { return { body: JSON.parse(raw) }; } catch { return { body: null }; }
}

// ------------------------------------------------------------------
// POST /detect  { text } → { detector, score, sentences }
// ------------------------------------------------------------------
async function detect(request, env, origin) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await overLimit(env, ip, 'detect')) return json({ error: 'rate_limited' }, 429, origin);
  const { body, tooLarge } = await readJson(request);
  if (tooLarge) return json({ error: 'too_large' }, 413, origin);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (text.length < MIN_CHARS) return json({ error: 'too_short' }, 400, origin);
  if (text.length > MAX_CHARS) return json({ error: 'too_long' }, 413, origin);

  const detector = DETECTORS[env.DETECTOR || 'sapling'];
  if (!detector || !env.DETECTOR_API_KEY) return json({ error: 'not_configured' }, 503, origin);
  try {
    const result = tidyResult(await detector.run(text, env.DETECTOR_API_KEY, AbortSignal.timeout(DETECT_TIMEOUT_MS)));
    if (!result) return json({ error: 'invalid_result' }, 502, origin);
    return json({ detector: detector.name, ...result }, 200, origin);
  } catch (error) {
    // Log the status only, never the text.
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return json({ error: 'upstream_timeout' }, 504, origin);
    if (error?.status === 429) return json({ error: 'upstream_busy' }, 503, origin);
    console.error('detector error', error?.status || error?.name);
    return json({ error: 'upstream_error' }, 502, origin);
  }
}

// ------------------------------------------------------------------
// POST /extract-url  { url } → { title, text, url }
// ------------------------------------------------------------------
// Only public http(s) hosts on the default ports. Cloudflare Workers cannot reach private networks anyway,
// but literal private / internal addresses are refused up front so the answer is clear.
export function blockedHost(url) {
  if (!['http:', 'https:'].includes(url.protocol)) return 'scheme';
  if (url.username || url.password) return 'credentials';
  if (url.port && url.port !== '80' && url.port !== '443') return 'port';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(host) || !host.includes('.') && !host.includes(':')) return 'private';
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return 'private';
    if (a === 169 && b === 254) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return 'private';
    return null;
  }
  // The URL parser already turns hex, octal and single-integer IPv4 into dotted form; refuse any that slip through.
  if (/^(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+)){0,3}$/i.test(host)) return 'private';
  if (host.includes(':')) {
    if (host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:')) return 'private';
  }
  return null;
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PAGE_BYTES) { await reader.cancel(); throw Object.assign(new Error('too large'), { code: 'too_large' }); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder('utf-8', { fatal: false }).decode(all);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decode = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
const strip = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// A small readability-style pass: drop chrome, prefer <article> or <main>, keep headings, paragraphs and list items.
export function extractArticle(html) {
  const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').slice(0, 200);
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|form|button|select)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  const pick = (tag) => {
    const parts = [...body.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map((m) => m[1]);
    return parts.sort((a, b) => b.length - a.length)[0];
  };
  body = pick('article') || pick('main') || body;
  const blocks = [...body.matchAll(/<(h[1-3]|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => strip(m[2]))
    .filter((t) => t.length >= 25 || /[.!?]$/.test(t));
  const text = blocks.join('\n\n').slice(0, MAX_CHARS);
  return { title, text };
}

async function extractUrl(request, env, origin) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await overLimit(env, ip, 'extract')) return json({ error: 'rate_limited' }, 429, origin);
  const { body, tooLarge } = await readJson(request);
  if (tooLarge) return json({ error: 'too_large' }, 413, origin);
  let url;
  try { url = new URL(String(body?.url || '').trim()); } catch { return json({ error: 'bad_url' }, 400, origin); }

  try {
    let res;
    for (let hop = 0; ; hop++) {
      if (blockedHost(url)) return json({ error: 'blocked' }, 400, origin);
      res = await fetch(url.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'InkprintBot/1.0 (+article text for an AI-writing check)', Accept: 'text/html,application/xhtml+xml' },
      });
      if (res.status < 300 || res.status >= 400) break;
      const next = res.headers.get('Location');
      if (!next || hop >= MAX_REDIRECTS) return json({ error: 'fetch_failed' }, 502, origin);
      url = new URL(next, url);
    }
    if (res.status === 401 || res.status === 402 || res.status === 403) return json({ error: 'paywalled' }, 422, origin);
    if (!res.ok) return json({ error: 'fetch_failed', status: res.status }, 502, origin);
    const type = res.headers.get('Content-Type') || '';
    if (!/text\/html|application\/xhtml|text\/plain/i.test(type)) return json({ error: 'not_html' }, 415, origin);
    if (Number(res.headers.get('Content-Length')) > MAX_PAGE_BYTES) return json({ error: 'too_large' }, 413, origin);
    const page = await readCapped(res);
    const out = /text\/plain/i.test(type) ? { title: '', text: page.replace(/\r\n?/g, '\n').trim().slice(0, MAX_CHARS) } : extractArticle(page);
    // Paywalled and JavaScript-only pages tend to come back nearly empty.
    if (out.text.split(/\s+/).filter(Boolean).length < 40) return json({ error: 'no_text' }, 422, origin);
    return json({ ...out, url: url.toString() }, 200, origin);
  } catch (error) {
    if (error?.code === 'too_large') return json({ error: 'too_large' }, 413, origin);
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return json({ error: 'timeout' }, 504, origin);
    return json({ error: 'fetch_failed' }, 502, origin);
  }
}

const ROUTES = { '/detect': detect, '/extract-url': extractUrl };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);
    const route = ROUTES[url.pathname];
    if (!route) return json({ error: 'not_found' }, 404, origin);
    if (request.method === 'OPTIONS') {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
    if (!origin) return json({ error: 'origin_not_allowed' }, 403, null);
    return route(request, env, origin);
  },
};
