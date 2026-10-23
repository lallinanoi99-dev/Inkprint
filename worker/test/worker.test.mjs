// Exercises the Worker's fetch handler in Node with the detector API and web pages stubbed out.
// Usage: npm test (from worker/)
import assert from 'node:assert/strict';
import worker, { blockedHost, extractArticle, tidyResult } from '../src/core.js';

const ORIGIN = 'https://inkprint.test';
const env = { ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:4609`, DETECTOR_API_KEY: 'test-key' };

// Stub every outbound fetch: the detectors and "web pages".
let detectorAnswer, detectorStatus = 200, lastDetector;
const pages = new Map();
const outbound = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  outbound.push(url);
  if (url.startsWith('https://api.sapling.ai/') || url.startsWith('https://api.gptzero.me/')) {
    lastDetector = { url, body: JSON.parse(init.body), headers: new Headers(init.headers) };
    return new Response(JSON.stringify(detectorAnswer), { status: detectorStatus, headers: { 'content-type': 'application/json' } });
  }
  const page = pages.get(url);
  if (!page) return new Response('nope', { status: 404 });
  return new Response(page.body ?? '', { status: page.status ?? 200, headers: page.headers ?? { 'content-type': 'text/html; charset=utf-8' } });
};

let ipCounter = 0;
const call = (path, body, { origin = ORIGIN, method = 'POST', ip = `10.0.0.${++ipCounter}`, e = env } = {}) =>
  worker.fetch(
    new Request(`https://worker.test${path}`, {
      method,
      headers: { ...(origin ? { Origin: origin } : {}), 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    }),
    e,
  );

const essay = 'Moreover, it is important to note that technology shapes how we learn. In conclusion, schools should adapt. '.repeat(4);

// --- /detect: Sapling happy path ------------------------------------
detectorAnswer = { score: 0.7234, sentence_scores: [{ sentence: 'Moreover, it is important to note that technology shapes how we learn.', score: 0.91 }, { sentence: 'In conclusion, schools should adapt.', score: 0.4 }, { sentence: '  ', score: 0.5 }, { sentence: 'Bad', score: 'x' }] };
let res = await call('/detect', { text: essay });
assert.equal(res.status, 200);
assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
assert.equal(res.headers.get('Cache-Control'), 'no-store');
let out = await res.json();
assert.equal(out.detector, 'Sapling AI Detector');
assert.equal(out.score, 0.723);
assert.deepEqual(out.sentences.map((s) => s.score), [0.91, 0.4], 'empty and non-numeric sentences are dropped');
assert.equal(lastDetector.body.key, 'test-key');
assert.equal(lastDetector.body.sent_scores, true);
assert.equal(lastDetector.body.text, essay.trim());

// --- GPTZero adapter ------------------------------------------------
detectorAnswer = { documents: [{ completely_generated_prob: 0.12, sentences: [{ sentence: 'One.', generated_prob: 0.1 }] }] };
out = await (await call('/detect', { text: essay }, { e: { ...env, DETECTOR: 'gptzero' } })).json();
assert.deepEqual(out, { detector: 'GPTZero', score: 0.12, sentences: [{ text: 'One.', score: 0.1 }] });
assert.equal(lastDetector.headers.get('x-api-key'), 'test-key');
assert.equal(lastDetector.body.document, essay.trim());

// --- /detect failures: the site falls back to "signals only" --------
detectorAnswer = { score: 'not a number' };
assert.equal((await call('/detect', { text: essay })).status, 502);
detectorStatus = 429; detectorAnswer = {};
assert.deepEqual(await (await call('/detect', { text: essay })).json(), { error: 'upstream_busy' });
detectorStatus = 500;
assert.equal((await call('/detect', { text: essay })).status, 502);
detectorStatus = 200;
assert.equal((await call('/detect', { text: essay }, { e: { ALLOWED_ORIGINS: ORIGIN } })).status, 503, 'no key → not_configured');
assert.equal((await call('/detect', { text: 'too short' })).status, 400);
assert.equal((await call('/detect', { text: 'x'.repeat(10_001) })).status, 413);
assert.equal((await call('/detect', { nope: 1 })).status, 400);
assert.deepEqual(tidyResult({ score: 1.4, sentences: [{ text: 'a', score: -2 }] }), { score: 1, sentences: [{ text: 'a', score: 0 }] });

// --- CORS + methods -------------------------------------------------
assert.equal((await call('/detect', { text: essay }, { origin: 'https://evil.test' })).status, 403);
assert.equal((await call('/detect', { text: essay }, { origin: null })).status, 403);
assert.equal((await call('/detect', null, { method: 'GET' })).status, 405);
assert.equal((await call('/nope', {})).status, 404);
res = await call('/detect', null, { method: 'OPTIONS' });
assert.equal(res.status, 204);
assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
assert.equal((await call('/detect', null, { method: 'OPTIONS', origin: 'https://evil.test' })).status, 403);

// --- rate limit: 10 per IP per hour, per route ----------------------
detectorAnswer = { score: 0.5, sentence_scores: [] };
for (let i = 0; i < 10; i++) assert.equal((await call('/detect', { text: essay }, { ip: '9.9.9.9' })).status, 200);
assert.equal((await call('/detect', { text: essay }, { ip: '9.9.9.9' })).status, 429);
assert.equal((await call('/detect', { text: essay }, { ip: '9.9.9.10' })).status, 200, 'other IPs are unaffected');

// --- blocked hosts --------------------------------------------------
const blocked = ['http://localhost/', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://192.168.0.1/', 'http://172.16.0.1/', 'http://169.254.169.254/latest/meta-data',
  'http://0x7f.1/', 'http://2130706433/', 'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://printer.local/', 'http://intranet/',
  'ftp://example.com/', 'file:///etc/passwd', 'http://example.com:8080/', 'http://user:pw@example.com/', 'http://100.64.0.1/', 'http://0.0.0.0/'];
for (const u of blocked) assert.ok(blockedHost(new URL(u)), `${u} should be blocked`);
for (const u of ['https://example.com/post', 'http://8.8.8.8/', 'https://blog.example.co.uk:443/a']) assert.equal(blockedHost(new URL(u)), null, `${u} should be allowed`);

// --- /extract-url ---------------------------------------------------
const para = (n) => `<p>This is paragraph ${n} of a real article about learning to write with patience and care.</p>`;
pages.set('https://example.com/post', {
  body: `<html><head><title>My essay &amp; notes</title><style>p{}</style></head><body><nav><p>Home About Contact links for the whole site nav bar</p></nav>
  <article><h1>Learning to write</h1>${[1, 2, 3, 4, 5, 6].map(para).join('')}<script>alert(1)</script></article><footer><p>Copyright footer text that should not appear here.</p></footer></body></html>`,
});
res = await call('/extract-url', { url: 'https://example.com/post' });
assert.equal(res.status, 200);
out = await res.json();
assert.equal(out.title, 'My essay & notes');
assert.match(out.text, /^This is paragraph 1/, 'h1 is short and has no full stop, so it is skipped; article paragraphs kept');
assert.doesNotMatch(out.text, /nav bar|Copyright|alert/);
assert.equal(out.text.split('\n\n').length, 6);

// redirects are re-checked against the block list
pages.set('https://example.com/r', { status: 302, headers: { Location: 'http://169.254.169.254/' } });
outbound.length = 0;
assert.deepEqual(await (await call('/extract-url', { url: 'https://example.com/r' })).json(), { error: 'blocked' });
assert.ok(!outbound.some((u) => u.includes('169.254')), 'never fetches the blocked redirect target');
pages.set('https://example.com/r2', { status: 301, headers: { Location: '/post' } });
assert.equal((await call('/extract-url', { url: 'https://example.com/r2' })).status, 200);

assert.deepEqual(await (await call('/extract-url', { url: 'http://localhost:8787/' })).json(), { error: 'blocked' });
assert.equal((await call('/extract-url', { url: 'not a url' })).status, 400);
pages.set('https://example.com/paywall', { status: 403 });
assert.deepEqual(await (await call('/extract-url', { url: 'https://example.com/paywall' })).json(), { error: 'paywalled' });
pages.set('https://example.com/spa', { body: '<html><body><div id="root"></div><script src="app.js"></script></body></html>' });
assert.deepEqual(await (await call('/extract-url', { url: 'https://example.com/spa' })).json(), { error: 'no_text' });
pages.set('https://example.com/file.pdf', { body: '%PDF', headers: { 'content-type': 'application/pdf' } });
assert.equal((await call('/extract-url', { url: 'https://example.com/file.pdf' })).status, 415);
pages.set('https://example.com/huge', { body: 'x'.repeat(2 * 1024 * 1024 + 10) });
assert.deepEqual(await (await call('/extract-url', { url: 'https://example.com/huge' })).json(), { error: 'too_large' });

// main falls back when there is no <article>
assert.match(extractArticle(`<main>${para(1)}</main><p>outside main but long enough to count as text.</p>`).text, /^This is paragraph 1[^]*care\.$/);

console.log('worker: all checks passed');
