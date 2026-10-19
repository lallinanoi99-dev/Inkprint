// Checks the in-browser analysis: fingerprints, sentence splitting, score alignment, signals and the report.
// Usage (from the project root): node tools/test-signals.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  normalise, fingerprint, wordCount, fitLength, splitSentences, alignScores, buildReport, burstiness, repetition, vocabulary, labelFor, confidenceFor, MAX_CHARS,
} from '../analysis.js';
import { SAMPLES, sampleDetection } from '../samples.js';

// --- fingerprint ------------------------------------------------------
assert.equal(normalise('  Hello,\r\n\n  world\t!  '), 'Hello, world !');
assert.equal(normalise('Café'), 'Café', 'NFC');
const fp = await fingerprint('Hello,\n\nworld.');
assert.equal(fp, '0x' + createHash('sha256').update('Hello, world.').digest('hex'));
assert.equal(await fingerprint('  Hello, world. '), fp, 'spacing and line breaks do not change the fingerprint');
assert.notEqual(await fingerprint('Hello, world!'), fp, 'one changed character does');
assert.match(fp, /^0x[0-9a-f]{64}$/);

// --- words + length ---------------------------------------------------
assert.equal(wordCount("It's a well-known fact — 42 times."), 6);
const long = ('This is a sentence that repeats. ').repeat(400);
const fit = fitLength(long);
assert.ok(fit.trimmed && fit.text.length <= MAX_CHARS && fit.text.endsWith('.'));
assert.deepEqual(fitLength(' short '), { text: 'short', trimmed: false });

// --- sentences --------------------------------------------------------
const text = 'Dr. Smith arrived at 9 a.m. on Monday. He said "Hello!" Then he left… Was it J. R. R. Tolkien? Yes.\n\nNew paragraph here.\nA PDF line\nbreak keeps going. e.g. this stays.';
const ss = splitSentences(text);
assert.deepEqual(ss.map((s) => s.text), [
  'Dr. Smith arrived at 9 a.m. on Monday.', 'He said "Hello!"', 'Then he left…', 'Was it J. R. R. Tolkien?', 'Yes.',
  'New paragraph here.', 'A PDF line\nbreak keeps going. e.g. this stays.',
]);
ss.forEach((s) => assert.equal(text.slice(s.start, s.end), s.text, 'offsets point at the original text'));
assert.deepEqual(ss.map((s) => s.para), [0, 0, 0, 0, 0, 1, 1]);

// --- alignment: the detector splits differently and changes spacing ---
const aText = 'One short line. Two short lines here.\n\nThree is the last one.';
const aSent = splitSentences(aText);
const aligned = alignScores(aText, aSent, [{ text: 'One short line.  Two short', score: 0.9 }, { text: 'lines here.', score: 0.1 }, { text: 'Three is the  last one.', score: 0.5 }]);
assert.equal(aligned[0], 0.9);
assert.ok(aligned[1] > 0.1 && aligned[1] < 0.9, 'a sentence spanning two detector pieces gets a weighted mix');
assert.equal(aligned[2], 0.5);
assert.deepEqual(alignScores(aText, aSent, []), [null, null, null]);
assert.deepEqual(alignScores(aText, aSent, [{ text: 'totally different words', score: 0.7 }]), [0.7, 0.7, 0.7], 'no match at all falls back by position');

// --- signals ----------------------------------------------------------
const flat = splitSentences('This sentence has exactly six words. '.repeat(8));
assert.ok(burstiness(flat).value >= 90 && burstiness(flat).direction === 'up');
const bursty = splitSentences('Short. This one is a good deal longer than the one before it, by a lot. Tiny one. Then another long sentence that wanders about for quite a while before ending. Ok. Fine then.');
assert.equal(burstiness(bursty).direction, 'down');
assert.equal(burstiness(splitSentences('One. Two.')).direction, 'na');
const rep = repetition('Moreover, it is important to note this. Furthermore, in conclusion, we must delve deeper. Moreover, it is important to note that.');
assert.equal(rep.direction, 'up');
assert.ok(rep.phrases.find((p) => p.phrase === 'moreover').count === 2);
assert.equal(repetition('The cat sat by the door and watched the rain fall on the old red car.').direction, 'down');
assert.equal(vocabulary('too short').direction, 'na');

// --- labels + confidence ----------------------------------------------
assert.deepEqual([labelFor(10), labelFor(35), labelFor(65), labelFor(66), labelFor(null)], ['Likely human', 'Mixed', 'Mixed', 'Likely AI', 'Signals only']);
assert.equal(confidenceFor(90, 100), 0, 'short texts are always Low');
assert.equal(confidenceFor(90, 400), 2);
assert.equal(confidenceFor(70, 200), 1);
assert.equal(confidenceFor(52, 400), 0);

// --- reports for the three samples ------------------------------------
for (const key of Object.keys(SAMPLES)) {
  const { text: t, detection } = sampleDetection(key);
  const r = buildReport(t, detection);
  assert.equal(r.sentences.length, SAMPLES[key].paragraphs.flat().length, `${key}: every sample sentence is found`);
  r.sentences.forEach((s, i) => assert.equal(s.score, SAMPLES[key].paragraphs.flat()[i][1], `${key}: sentence ${i} keeps its score`));
  assert.equal(r.why.length, 3);
  assert.equal(r.signals.length, 4);
  console.log(`${key}: ${r.score}% ${r.label} · ${r.confidenceLabel} · ${r.verdict}\n  ${r.signals.map((s) => `${s.name} ${s.value ?? '—'} ${s.direction}`).join(' · ')}\n  - ${r.why.join('\n  - ')}`);
}
const human = buildReport(...Object.values(sampleDetection('human')));
assert.equal(human.label, 'Likely human');
const ai = buildReport(...Object.values(sampleDetection('ai')));
assert.equal(ai.label, 'Likely AI');
assert.equal(ai.verdict, 'This reads like AI — across the whole text.');
assert.equal(ai.signals.find((s) => s.key === 'repetition').direction, 'up');
const mixed = buildReport(...Object.values(sampleDetection('mixed')));
assert.equal(mixed.label, 'Mixed');
assert.equal(mixed.verdict, 'Parts of this read like AI — mostly the intro and conclusion.');

// --- signals only: no detector, no score, and the report says so ------
const only = buildReport(sampleDetection('ai').text, null);
assert.equal(only.score, null);
assert.equal(only.label, 'Signals only');
assert.match(only.verdict, /No AI score/);
assert.equal(only.signals.find((s) => s.key === 'predictability').direction, 'na');
assert.ok(only.sentences.every((s) => s.score === null));
assert.ok(only.short && only.words < 150);

console.log('analysis: all checks passed');
