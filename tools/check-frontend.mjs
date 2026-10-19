// Checks that the ABI written into app.js matches the compiled contract, then drives the site's exact
// read and write calls (with the site's own fingerprint function) against an in-memory chain with chain ID 677.
// Usage (from the project root): node tools/compile.mjs && node tools/check-frontend.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { BrowserProvider, Contract, ContractFactory, Interface } from 'ethers';
import { buildReport, fingerprint, wordCount, NO_SCORE } from '../analysis.js';
import { sampleDetection } from '../samples.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(root, 'app.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const artifact = JSON.parse(readFileSync(join(root, 'build/Inkprint.json'), 'utf8'));

// 1) Pull the ABI array out of app.js and evaluate it as plain JS.
const tuples = app.match(/const (CERT|PIECE|DRAFT)_TUPLE = '[^']+';/g);
assert.equal(tuples.length, 3, 'tuple constants not found in app.js');
const start = app.indexOf('const ABI = [');
assert.ok(start >= 0, 'ABI not found in app.js');
const ABI = new Function(`${tuples.join('\n')}\n${app.slice(start, app.indexOf('];', start) + 2)}\nreturn ABI;`)();
const site = new Interface(ABI);
const real = new Interface(artifact.abi);
for (const f of site.fragments) {
  const match = real.fragments.find((r) => r.type === f.type && r.format('minimal') === f.format('minimal'));
  assert.ok(match, `app.js ${f.type} does not match the contract: ${f.format('full')}`);
}
console.log(`ABI: ${site.fragments.length} fragments match the compiled contract`);

// 2) Page wiring the PRD requires.
assert.match(app, /mainnet: \{ chainId: 677, name: 'BOT Chain', rpc: 'https:\/\/rpc\.botchain\.ai', explorer: 'https:\/\/scan\.botchain\.ai', contract: '[^']*' \}/);
assert.match(app, /href: 'https:\/\/botchain\.ai', target: '_blank'/, 'footer BOT Chain bookmark → botchain.ai');
assert.match(app, /View on explorer ↗/);
for (const id of ['analysis', 'sample', 'proof', 'formats', 'verify', 'faq', 'footer']) assert.ok(html.includes(`id="${id}"`), `missing section #${id}`);
const home = html.slice(html.indexOf('data-view="home"'), html.indexOf('data-view="app"'));
assert.equal((home.match(/<section class="band/g) || []).length, 9, 'home page has 9 sections');
console.log('page: 9 home sections, footer links and mainnet config present');

// 3) Run the site's calls on a chain.
const provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'merge', chainId: 677 } }));
const [writer, author] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
const GAS = { gasLimit: 1_000_000 };
const deployed = await (await new ContractFactory(real, artifact.bytecode, writer).deploy()).waitForDeployment();
const address = await deployed.getAddress();
const asWriter = new Contract(address, ABI, writer);
const reader = new Contract(address, ABI, provider);
const parse = (c, receipt, name) => receipt.logs.map((l) => { try { return c.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === name);

// scan → stamp, exactly like stampFlow: fingerprint the analysed text, staticCall, send, parse the event
const { text, detection } = sampleDetection('mixed');
const report = buildReport(text, detection);
const hash = await fingerprint(report.text);
const args = [hash, report.score, report.confidence, report.detector];
await asWriter.stampCertificate.staticCall(...args);
let receipt = await (await asWriter.stampCertificate(...args, GAS)).wait();
const id = Number(parse(asWriter, receipt, 'CertificateStamped').args.id);
assert.equal(id, 0);

// a signals-only report stamps with NO_SCORE
const only = buildReport(sampleDetection('ai').text, null);
await asWriter.stampCertificate.staticCall(await fingerprint(only.text), only.score ?? NO_SCORE, only.confidence, 'signals only');

// verify: same text with different spacing → same certificate; read like normCert (timestamp by index)
const again = await fingerprint('  ' + text.replace(/ /g, '   ') + '\n\n');
assert.deepEqual([...(await reader.certificatesForHash(again))].map(Number), [0]);
assert.deepEqual([...(await reader.certificatesForHash(await fingerprint(text.replace('Beans go left.', 'Beans go right.'))))], []);
const c = await reader.getCertificate(0);
assert.equal(typeof c.at, 'function', 'Result.at shadows the field, so the site must read c[5]');
assert.ok(Number(c[5]) > 0);
assert.deepEqual([Number(c.score), Number(c.confidence), c.detector, c.owner], [report.score, report.confidence, 'Example data', writer.address]);
await assert.rejects(reader.getCertificate(9), (e) => e.revert?.name === 'NotFound');
assert.deepEqual([...(await reader.certificatesOf(writer.address))].map(Number), [0]);

// writer's proof, like createPiece / stampDraft / renderPiece
const asAuthor = new Contract(address, ABI, author);
receipt = await (await asAuthor.createPiece('History coursework', GAS)).wait();
const pieceId = Number(parse(asAuthor, receipt, 'PieceCreated').args.id);
const draft = 'This is my first rough draft about the mills.';
await (await asAuthor.stampDraft(pieceId, await fingerprint(draft), wordCount(draft), GAS)).wait();
const [p, ds] = await Promise.all([reader.getPiece(pieceId), reader.getDrafts(pieceId)]);
assert.equal(p.title, 'History coursework');
assert.equal(p.author, author.address);
assert.equal(ds.length, 1);
assert.equal(Number(ds[0].words), 9);
assert.ok(Number(ds[0][2]) > 0, 'draft timestamp read by index');
await assert.rejects(asWriter.stampDraft.staticCall(pieceId, hash, 5), (e) => e.revert?.name === 'NotAuthor');
await assert.rejects(reader.getPiece(7), (e) => e.revert?.name === 'NotFound');

// footer counts
assert.deepEqual([Number(await reader.certificateCount()), Number(await reader.draftCount())], [1, 1]);

console.log('frontend calls work against the compiled contract');
