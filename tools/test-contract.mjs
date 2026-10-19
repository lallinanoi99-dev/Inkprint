// Runs the compiled contract on an in-memory chain: certificates, pieces and drafts, plus every rule in the PRD.
// Usage (from the project root): node tools/compile.mjs && node tools/test-contract.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory } from 'ethers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { abi, bytecode } = JSON.parse(readFileSync(join(root, 'build/Inkprint.json'), 'utf8'));

const provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'merge', chainId: 677 }, wallet: { totalAccounts: 3 } }));
const [writer, reader, other] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
const GAS = { gasLimit: 1_000_000 };

const ink = await (await new ContractFactory(abi, bytecode, writer).deploy()).waitForDeployment();
const as = (signer) => ink.connect(signer);
const events = (receipt) => receipt.logs.map((l) => ink.interface.parseLog(l)).filter(Boolean);
const reverts = (call, name) => assert.rejects(call, (e) => e.revert?.name === name, `expected ${name}`);
const sha = (text) => '0x' + createHash('sha256').update(text).digest('hex');
const ZERO = '0x' + '00'.repeat(32);

const H1 = sha('The first essay.');
const H2 = sha('The second essay.');

// --- empty state ----------------------------------------------------
assert.equal(await ink.certificateCount(), 0n);
assert.equal(await ink.pieceCount(), 0n);
assert.equal(await ink.draftCount(), 0n);
assert.equal(await ink.NO_SCORE(), 255n);
assert.deepEqual([...(await ink.certificatesForHash(H1))], []);
await reverts(ink.getCertificate(0), 'NotFound');
await reverts(ink.getPiece(0), 'NotFound');
await reverts(ink.getDrafts(0), 'NotFound');

// --- certificate validation -----------------------------------------
await reverts(as(writer).stampCertificate.staticCall(ZERO, 50, 1, 'Sapling'), 'EmptyHash');
await reverts(as(writer).stampCertificate.staticCall(H1, 101, 1, 'Sapling'), 'BadScore');
await reverts(as(writer).stampCertificate.staticCall(H1, 254, 1, 'Sapling'), 'BadScore');
await reverts(as(writer).stampCertificate.staticCall(H1, 50, 3, 'Sapling'), 'BadConfidence');
await reverts(as(writer).stampCertificate.staticCall(H1, 50, 1, ''), 'EmptyDetector');
await reverts(as(writer).stampCertificate.staticCall(H1, 50, 1, 'x'.repeat(65)), 'DetectorTooLong');
await as(writer).stampCertificate.staticCall(H1, 0, 0, 'x'.repeat(64)); // edges are fine
await as(writer).stampCertificate.staticCall(H1, 100, 2, 'Sapling');
await as(writer).stampCertificate.staticCall(H1, 255, 0, 'signals only'); // no score: allowed, clearly marked

// --- stamp + read ---------------------------------------------------
let r = await (await as(writer).stampCertificate(H1, 72, 1, 'Sapling AI Detector', GAS)).wait();
console.log(`stampCertificate gas: ${r.gasUsed}`);
let [ev] = events(r);
assert.equal(ev.name, 'CertificateStamped');
assert.deepEqual([ev.args.id, ev.args.owner, ev.args.textHash, ev.args.score, ev.args.confidence, ev.args.detector], [0n, writer.address, H1, 72n, 1n, 'Sapling AI Detector']);

const c0 = await ink.getCertificate(0);
assert.equal(c0.owner, writer.address);
assert.equal(c0.textHash, H1);
assert.equal(c0.score, 72n);
assert.equal(c0.confidence, 1n);
assert.equal(c0.detector, 'Sapling AI Detector');
assert.ok(c0.toObject().at > 0n, 'Result.at is Array.prototype.at, so read the field via toObject() or by index');
assert.equal(c0[5], c0.toObject().at);

// same text scanned again by someone else: both certificates come back for the hash
await (await as(reader).stampCertificate(H1, 70, 2, 'Sapling AI Detector', GAS)).wait();
await (await as(reader).stampCertificate(H2, 255, 0, 'signals only', GAS)).wait();
assert.deepEqual([...(await ink.certificatesForHash(H1))].map(Number), [0, 1]);
assert.deepEqual([...(await ink.certificatesForHash(H2))].map(Number), [2]);
assert.deepEqual([...(await ink.certificatesOf(reader.address))].map(Number), [1, 2]);
assert.equal(await ink.certificateCount(), 3n);
await reverts(ink.getCertificate(3), 'NotFound');

// --- pieces ---------------------------------------------------------
await reverts(as(writer).createPiece.staticCall(''), 'EmptyTitle');
await reverts(as(writer).createPiece.staticCall('x'.repeat(121)), 'TitleTooLong');
await as(writer).createPiece.staticCall('x'.repeat(120));
// titles are bytes on-chain: 40 three-byte characters = 120 bytes, 41 = too long
await as(writer).createPiece.staticCall('—'.repeat(40));
await reverts(as(writer).createPiece.staticCall('—'.repeat(41)), 'TitleTooLong');

r = await (await as(writer).createPiece('On walking to school', GAS)).wait();
console.log(`createPiece gas: ${r.gasUsed}`);
[ev] = events(r);
assert.deepEqual([ev.name, ev.args.id, ev.args.author, ev.args.title], ['PieceCreated', 0n, writer.address, 'On walking to school']);
const p0 = await ink.getPiece(0);
assert.equal(p0.author, writer.address);
assert.equal(p0.title, 'On walking to school');
assert.ok(p0.createdAt > 0n);
assert.deepEqual([...(await ink.getDrafts(0))], []);

// --- drafts ---------------------------------------------------------
await reverts(as(other).stampDraft.staticCall(0, H1, 320), 'NotAuthor');
await reverts(as(writer).stampDraft.staticCall(5, H1, 320), 'NotFound');
await reverts(as(writer).stampDraft.staticCall(0, ZERO, 320), 'EmptyHash');
await reverts(as(writer).stampDraft.staticCall(0, H1, 0), 'NoWords');

const trail = [[sha('draft one'), 320], [sha('draft two'), 810], [H1, 1240]];
for (const [i, [hash, words]] of trail.entries()) {
  r = await (await as(writer).stampDraft(0, hash, words, GAS)).wait();
  if (i === 0) console.log(`stampDraft gas: ${r.gasUsed}`);
  [ev] = events(r);
  assert.deepEqual([ev.name, ev.args.pieceId, ev.args.index, ev.args.textHash, ev.args.words], ['DraftStamped', 0n, BigInt(i), hash, BigInt(words)]);
  await provider.send('evm_increaseTime', [3600]);
}
const ds = await ink.getDrafts(0);
assert.equal(ds.length, 3);
assert.deepEqual(ds.map((d) => [d.textHash, Number(d.words)]), trail);
assert.ok(ds[0][2] < ds[1][2] && ds[1][2] < ds[2][2], 'drafts are timestamped in order');
assert.equal(await ink.draftCount(), 3n);

// a second author's piece is separate
await (await as(reader).createPiece('Lab report', GAS)).wait();
await reverts(as(writer).stampDraft.staticCall(1, H2, 10), 'NotAuthor');
assert.deepEqual([...(await ink.piecesOf(writer.address))].map(Number), [0]);
assert.deepEqual([...(await ink.piecesOf(reader.address))].map(Number), [1]);
assert.equal(await ink.pieceCount(), 2n);

// the final draft's hash finds the certificate for that same text ("attached" scan, no extra storage)
assert.deepEqual([...(await ink.certificatesForHash(ds[2].textHash))].map(Number), [0, 1]);

console.log('contract: all checks passed');
