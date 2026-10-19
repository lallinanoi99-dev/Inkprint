// Inkprint analysis — everything that runs in the browser, with no network.
// Fingerprints (normalise + SHA-256), sentence splitting, aligning the detector's per-sentence scores to the
// text, the four signals, and the plain-English report. Shared by index.html and tools/test-signals.mjs.

export const MIN_WORDS = 150; // below this the result is flagged Low confidence
export const MAX_CHARS = 10_000;
export const AI_SENTENCE = 0.65; // sentence score at or above this is "likely AI"
export const MIXED_SENTENCE = 0.35; // at or above this is "mixed"
export const CONFIDENCE = ['Low', 'Medium', 'High'];
export const NO_SCORE = 255;

// ------------------------------------------------------------------
// Fingerprint
// ------------------------------------------------------------------
// Unicode NFC, every run of whitespace (spaces, tabs, line breaks, non-breaking spaces) becomes one space,
// and the ends are trimmed. Everything else — every letter, quote and full stop — counts.
export const normalise = (text) => String(text ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();

export async function fingerprint(text) {
  const bytes = new TextEncoder().encode(normalise(text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return '0x' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const words = (text) => String(text ?? '').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
export const wordCount = (text) => words(text).length;

// Trim to MAX_CHARS at the last sentence end (or space) so the cut is clean.
export function fitLength(text) {
  const clean = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (clean.length <= MAX_CHARS) return { text: clean, trimmed: false };
  const head = clean.slice(0, MAX_CHARS);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'), head.lastIndexOf('? '), head.lastIndexOf('! '));
  const cut = end > MAX_CHARS * 0.8 ? end + 1 : head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : MAX_CHARS;
  return { text: head.slice(0, cut).trim(), trimmed: true };
}

// ------------------------------------------------------------------
// Sentences: [{ text, start, end, para }] with offsets into the original text
// ------------------------------------------------------------------
const ABBREV = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'eg', 'ie', 'e.g', 'i.e', 'no', 'fig', 'inc', 'ltd', 'co', 'approx', 'dept', 'est', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'u.s', 'a.m', 'p.m']);

export function splitSentences(text) {
  const out = [];
  // Paragraphs are separated by a blank line; a single line break (as in PDF text) is just a space.
  const paragraphs = /(?:(?!\n[ \t]*\n)[\s\S])+/g;
  let para = -1;
  for (let m; (m = paragraphs.exec(text)); ) {
    if (!m[0].trim()) continue;
    para++;
    const block = m[0];
    const base = m.index;
    let from = 0;
    const boundary = /[.!?…]+["'”’)\]]*\s+/g;
    for (let b; (b = boundary.exec(block)); ) {
      const next = block[b.index + b[0].length];
      if (!next || !/[\p{Lu}\p{N}"'“‘(\[]/u.test(next)) continue;
      const before = block.slice(from, b.index).match(/([\p{L}.]+)$/u)?.[1]?.toLowerCase() || '';
      if (block[b.index] === '.' && (ABBREV.has(before) || /^\p{L}$/u.test(before))) continue;
      push(block.slice(from, b.index + b[0].length), base + from);
      from = b.index + b[0].length;
    }
    push(block.slice(from), base + from);
  }
  return out;

  function push(chunk, at) {
    const lead = chunk.length - chunk.trimStart().length;
    const t = chunk.trim();
    if (!t) return;
    out.push({ text: t, start: at + lead, end: at + lead + t.length, para });
  }
}

// ------------------------------------------------------------------
// Align the detector's sentences (its own split) to ours, by matching letters and digits only.
// ------------------------------------------------------------------
const keyOf = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function alignScores(text, sentences, detected) {
  if (!detected?.length) return sentences.map(() => null);
  const map = [];
  let key = '';
  for (let i = 0; i < text.length; i++) {
    const k = keyOf(text[i]);
    for (const ch of k) { key += ch; map.push(i); }
  }
  const ranges = [];
  let cursor = 0;
  for (const d of detected) {
    const k = keyOf(d.text);
    if (!k) continue;
    let pos = key.indexOf(k, cursor);
    let len = k.length;
    if (pos < 0 && k.length > 24) { pos = key.indexOf(k.slice(0, 24), cursor); len = Math.min(k.length, key.length - pos); }
    if (pos < 0) continue;
    ranges.push({ start: map[pos], end: map[pos + len - 1] + 1, score: d.score });
    cursor = pos + len;
  }
  return sentences.map((s, i) => {
    let weight = 0, sum = 0;
    for (const r of ranges) {
      const overlap = Math.min(s.end, r.end) - Math.max(s.start, r.start);
      if (overlap > 0) { weight += overlap; sum += overlap * r.score; }
    }
    if (weight) return Math.round((sum / weight) * 1000) / 1000;
    if (ranges.length) return null;
    // Nothing matched at all (the detector rewrote the text): fall back to the same position in its list.
    return detected[Math.min(detected.length - 1, Math.floor((i / sentences.length) * detected.length))].score;
  });
}

// ------------------------------------------------------------------
// Signals. Each: { key, name, value (0–100, how AI-like), direction: up|down|neutral|na, metric, line, detail }
// ------------------------------------------------------------------
const clamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const direction = (v) => (v >= 60 ? 'up' : v <= 35 ? 'down' : 'neutral');

export const STOCK_PHRASES = [
  'moreover', 'furthermore', 'additionally', 'in conclusion', 'in summary', 'to summarize', 'overall,', 'ultimately',
  "it's important to note", 'it is important to note', "it's worth noting", 'it is worth noting', 'it is essential to', 'it is crucial to',
  'plays a crucial role', 'plays a vital role', 'plays a pivotal role', 'a testament to', 'in today\'s', 'in the realm of', 'delve', 'navigate the',
  'tapestry', 'multifaceted', 'nuanced', 'foster', 'leverage', 'not only', 'on the other hand', 'by doing so', 'when it comes to',
  'a wide range of', 'a variety of', 'in this essay', 'serves as', 'paving the way', 'ever-evolving', 'landscape', 'underscores', 'holistic',
];

export function burstiness(sentences) {
  const lengths = sentences.map((s) => wordCount(s.text)).filter((n) => n > 0);
  if (lengths.length < 5) return { key: 'burstiness', name: 'Burstiness', value: null, direction: 'na', lengths, metric: '—', line: 'Too few sentences to measure how much their length varies.' };
  const cv = sd(lengths) / mean(lengths);
  const value = Math.round(clamp(((0.65 - cv) / 0.45) * 100));
  const dir = direction(value);
  const line = dir === 'up' ? 'Sentences are similar in length — a steady rhythm that AI text often has.'
    : dir === 'down' ? 'Sentence lengths vary a lot — short and long mixed, as people tend to write.'
    : 'Sentence lengths vary a little — not a strong hint either way.';
  return { key: 'burstiness', name: 'Burstiness', value, direction: dir, lengths, metric: `variation ${cv.toFixed(2)}`, line };
}

export function repetition(text) {
  const lower = ' ' + normalise(text).toLowerCase().replace(/’/g, "'") + ' ';
  const ws = words(lower).map((w) => w.toLowerCase());
  const n = ws.length || 1;
  const found = [];
  for (const p of STOCK_PHRASES) {
    const re = new RegExp(`(^|[^\\p{L}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gu');
    const count = (lower.match(re) || []).length;
    if (count) found.push({ phrase: p.replace(/,$/, ''), count });
  }
  const stock = found.reduce((a, f) => a + f.count, 0);
  const grams = new Map();
  for (let i = 0; i + 2 < ws.length; i++) {
    const g = ws.slice(i, i + 3).join(' ');
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  const repeated = [...grams.entries()].filter(([, c]) => c > 1);
  const repeatShare = repeated.reduce((a, [, c]) => a + c, 0) / Math.max(1, ws.length - 2);
  const per100 = (stock / n) * 100;
  const value = Math.round(clamp(per100 * 28 + repeatShare * 150));
  const dir = direction(value);
  found.sort((a, b) => b.count - a.count);
  const top = found.slice(0, 3).map((f) => `“${f.phrase[0].toUpperCase()}${f.phrase.slice(1)}”${f.count > 1 ? ` ×${f.count}` : ''}`);
  const line = dir === 'up' ? `Lots of stock transitions${top.length ? ` (${top.join(', ')})` : ''} and repeated phrasing.`
    : dir === 'down' ? 'Few stock transitions or repeated phrases.'
    : `Some stock transitions${top.length ? ` (${top.join(', ')})` : ''} — common in formal writing too.`;
  return {
    key: 'repetition', name: 'Repetition', value, direction: dir, metric: `${per100.toFixed(1)} stock phrases / 100 words`, line,
    phrases: found, repeated: repeated.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g, c]) => ({ phrase: g, count: c })),
  };
}

// Moving-average type-token ratio: the unique-word share in a sliding 50-word window, so long texts aren't penalised.
export function vocabulary(text) {
  const ws = words(text).map((w) => w.toLowerCase());
  if (ws.length < 40) return { key: 'vocabulary', name: 'Vocabulary', value: null, direction: 'na', metric: '—', line: 'Too few words to measure vocabulary variety.' };
  const win = Math.min(50, ws.length);
  let total = 0, windows = 0;
  const counts = new Map();
  for (let i = 0; i < ws.length; i++) {
    counts.set(ws[i], (counts.get(ws[i]) || 0) + 1);
    if (i >= win) { const out = ws[i - win]; const c = counts.get(out) - 1; c ? counts.set(out, c) : counts.delete(out); }
    if (i >= win - 1) { total += counts.size / win; windows++; }
  }
  const mattr = total / windows;
  const value = Math.round(clamp(((0.88 - mattr) / 0.2) * 100));
  const dir = direction(value);
  const line = dir === 'up' ? 'A narrower, safer word choice than usual for this length.'
    : dir === 'down' ? 'A wide, varied vocabulary for this length.'
    : 'Vocabulary variety is about average for this length — a weak signal on its own.';
  return { key: 'vocabulary', name: 'Vocabulary', value, direction: dir, metric: `${Math.round(mattr * 100)}% unique per 50 words`, line, mattr };
}

export function predictability(scores) {
  const xs = scores.filter((s) => s !== null && Number.isFinite(s));
  if (!xs.length) return { key: 'predictability', name: 'Predictability', value: null, direction: 'na', metric: 'needs the detector', line: 'Comes from the detector’s per-sentence scores, which aren’t available for this scan.' };
  const value = Math.round(clamp(mean(xs) * 100));
  const high = xs.filter((s) => s >= AI_SENTENCE).length;
  const dir = direction(value);
  const line = dir === 'up' ? `${high} of ${xs.length} sentences read as highly expected — the words a model would most likely pick.`
    : dir === 'down' ? 'Most sentences take turns a model wouldn’t expect.'
    : `A mix: ${high} of ${xs.length} sentences read as highly expected.`;
  return { key: 'predictability', name: 'Predictability', value, direction: dir, metric: `average ${value}%`, line };
}

// ------------------------------------------------------------------
// The report
// ------------------------------------------------------------------
export const labelFor = (score) => (score === null ? 'Signals only' : score < 35 ? 'Likely human' : score <= 65 ? 'Mixed' : 'Likely AI');
export const tintFor = (s) => (s === null || s === undefined ? 'none' : s >= AI_SENTENCE ? 'ai' : s >= MIXED_SENTENCE ? 'mixed' : 'none');

export function confidenceFor(score, wordTotal) {
  if (score === null) return 0;
  if (wordTotal < MIN_WORDS) return 0;
  const distance = Math.abs(score - 50);
  if (wordTotal >= 300 && distance >= 30) return 2;
  if (distance >= 15) return 1;
  return 0;
}

const ZONES = ['intro', 'middle', 'conclusion'];
function where(sentences) {
  const n = sentences.length;
  const ai = sentences.map((s, i) => ({ i, s })).filter(({ s }) => s.score !== null && s.score >= AI_SENTENCE);
  if (!ai.length || n < 5) return { ai: ai.length, phrase: '' };
  if (ai.length / n >= 0.7) return { ai: ai.length, phrase: 'across the whole text' };
  const edge = Math.max(1, Math.round(n * 0.2));
  const zone = { intro: 0, middle: 0, conclusion: 0 };
  ai.forEach(({ i }) => { zone[i < edge ? 'intro' : i >= n - edge ? 'conclusion' : 'middle']++; });
  const ranked = ZONES.filter((z) => zone[z]).sort((a, b) => zone[b] - zone[a]);
  if (zone[ranked[0]] >= ai.length * 0.7) return { ai: ai.length, phrase: `mostly the ${ranked[0]}` };
  if (ranked.length === 2 || zone[ranked[0]] + zone[ranked[1]] >= ai.length * 0.8) {
    const [a, b] = ranked.slice(0, 2).sort((x, y) => ZONES.indexOf(x) - ZONES.indexOf(y));
    return { ai: ai.length, phrase: `mostly the ${a} and ${b}` };
  }
  return { ai: ai.length, phrase: 'spread through the text' };
}

/**
 * @param {string} rawText
 * @param {{ detector: string, score: number, sentences: {text: string, score: number}[] } | null} detection
 */
export function buildReport(rawText, detection = null) {
  const { text, trimmed } = fitLength(rawText);
  const wordTotal = wordCount(text);
  const split = splitSentences(text);
  const aligned = alignScores(text, split, detection?.sentences);
  const sentences = split.map((s, i) => ({ ...s, score: aligned[i] }));
  const score = detection && Number.isFinite(detection.score) ? Math.round(detection.score * 100) : null;
  const confidence = confidenceFor(score, wordTotal);
  const label = labelFor(score);

  const signals = [burstiness(split), repetition(text), vocabulary(text), predictability(aligned)];
  const loc = where(sentences);

  let verdict;
  if (score === null) verdict = 'No AI score this time — the detector wasn’t available. These are the signals Inkprint measured on its own.';
  else if (label === 'Likely human') verdict = loc.ai ? `This mostly reads like human writing — only ${loc.ai === 1 ? 'one sentence stands' : `${loc.ai} sentences stand`} out as AI-like.` : 'This reads like human writing — no sentence stood out as AI-like.';
  else if (label === 'Mixed') verdict = loc.phrase ? `Parts of this read like AI — ${loc.phrase}.` : 'Parts of this read like AI, but no section stands out.';
  else verdict = loc.phrase ? `This reads like AI — ${loc.phrase}.` : 'This reads like AI overall.';

  const why = [];
  const scored = sentences.filter((s) => s.score !== null);
  if (score !== null && scored.length) why.push(`${loc.ai} of ${scored.length} sentences scored as likely AI${loc.phrase ? ` (${loc.phrase})` : ''}.`);
  else if (score !== null) why.push(`The detector rated the text ${score}% likely AI overall.`);
  const measured = signals.filter((s) => s.value !== null && s.key !== 'predictability');
  const up = measured.filter((s) => s.direction === 'up').sort((a, b) => b.value - a.value);
  const down = measured.filter((s) => s.direction === 'down').sort((a, b) => a.value - b.value);
  const effect = { up: 'pushed it up', down: 'pulled it down', neutral: 'about neutral' };
  for (const s of [up[0], down[0], ...up.slice(1), ...down.slice(1), ...measured.filter((m) => m.direction === 'neutral')]) {
    if (!s || why.length >= 3) continue;
    why.push(`${s.name} ${effect[s.direction]}: ${lower(s.line)}`);
  }
  if (wordTotal < MIN_WORDS && why.length < 3) why.push(`Only ${wordTotal} words — short texts are hard to judge.`);
  while (why.length < 3) why.push('Formal or non-native English can look AI-like to detectors — read the highlights, not just the number.');

  return {
    text, trimmed, words: wordTotal, short: wordTotal < MIN_WORDS, sentences, score, confidence, confidenceLabel: CONFIDENCE[confidence],
    label, verdict, signals, why: why.slice(0, 3), detector: detection?.detector || null,
  };
}

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
