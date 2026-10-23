// Inkprint frontend. Plain ES module, no build step. ethers v6 is loaded from cdnjs in index.html.
import { buildReport, fingerprint, wordCount, fitLength, tintFor, CONFIDENCE, MIN_WORDS, MAX_CHARS, NO_SCORE, labelFor } from './analysis.js';
import { sampleDetection } from './samples.js';

// ============================================================
// Config — the only values to edit after deploying.
// ============================================================
const CONFIG = {
  networks: {
    // `contract` on mainnet is the single source for the app, the footer address and the explorer link.
    mainnet: { chainId: 677, name: 'BOT Chain', rpc: 'https://rpc.botchain.ai', explorer: 'https://scan.botchain.ai', contract: '0x2A1f419Bd59A7e86db55FCB370D1E8d6fDBDBE7a' },
    testnet: { chainId: 968, name: 'BOT Chain Testnet', rpc: 'https://rpc.bohr.life', explorer: 'https://scan.bohr.life', contract: '' },
  },
  // The Worker (worker/), e.g. 'https://inkprint.<account>.workers.dev'. Empty → signals only, no URL import.
  workerUrl: '', // set below for localhost
  detectTimeoutMs: 15000,
  extractTimeoutMs: 9000,
  github: 'https://github.com/lallinanoi99-dev/Inkprint',
};

const CERT_TUPLE = 'tuple(address owner, bytes32 textHash, uint8 score, uint8 confidence, string detector, uint64 at)';
const PIECE_TUPLE = 'tuple(address author, string title, uint64 createdAt)';
const DRAFT_TUPLE = 'tuple(bytes32 textHash, uint32 words, uint64 at)';
const ABI = [
  'function stampCertificate(bytes32 textHash, uint8 score, uint8 confidence, string detector) returns (uint256 id)',
  'function createPiece(string title) returns (uint256 id)',
  'function stampDraft(uint256 pieceId, bytes32 textHash, uint32 words)',
  `function getCertificate(uint256 id) view returns (${CERT_TUPLE})`,
  'function certificatesForHash(bytes32 textHash) view returns (uint256[])',
  'function certificatesOf(address owner) view returns (uint256[])',
  'function certificateCount() view returns (uint256)',
  `function getPiece(uint256 id) view returns (${PIECE_TUPLE})`,
  `function getDrafts(uint256 pieceId) view returns (${DRAFT_TUPLE}[])`,
  'function piecesOf(address author) view returns (uint256[])',
  'function pieceCount() view returns (uint256)',
  'function draftCount() view returns (uint256)',
  'event CertificateStamped(uint256 indexed id, address indexed owner, bytes32 indexed textHash, uint8 score, uint8 confidence, string detector)',
  'event PieceCreated(uint256 indexed id, address indexed author, string title)',
  'event DraftStamped(uint256 indexed pieceId, uint256 indexed index, bytes32 indexed textHash, uint32 words)',
  'error EmptyHash()', 'error BadScore()', 'error BadConfidence()', 'error EmptyDetector()', 'error DetectorTooLong()',
  'error EmptyTitle()', 'error TitleTooLong()', 'error NoWords()', 'error NotAuthor()', 'error NotFound()',
];
const REVERTS = {
  EmptyHash: 'There’s no text to fingerprint.',
  BadScore: 'That score is out of range.',
  BadConfidence: 'That confidence band is out of range.',
  EmptyDetector: 'The detector name is missing.',
  DetectorTooLong: 'The detector name is too long.',
  EmptyTitle: 'Give your piece a title.',
  TitleTooLong: 'That title is too long — keep it under 120 characters.',
  NoWords: 'This draft has no words.',
  NotAuthor: 'Only the piece’s author can stamp drafts on it.',
  NotFound: 'Not found.',
};

// ============================================================
// Network + mode
// ============================================================
function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch { return value === undefined ? null : false; }
}

const params = new URLSearchParams(location.search);
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const netKey = params.get('net') === 'testnet' ? 'testnet' : 'mainnet';
const NET = { ...CONFIG.networks[netKey] };
// On localhost, pick up an address deployed from deploy.html so it can be tried before editing CONFIG.
if (!NET.contract && isLocal) NET.contract = storage('inkprint.contract.' + NET.chainId) || '';
const MAINNET = { ...CONFIG.networks.mainnet };
if (!MAINNET.contract && isLocal) MAINNET.contract = storage('inkprint.contract.' + MAINNET.chainId) || '';
const PREVIEW = !NET.contract; // no contract yet: stamps are simulated in this browser
const CHAIN_HEX = '0x' + NET.chainId.toString(16);
const PREVIEW_WALLET = '0x1A4C000000000000000000000000000000000909';
// On localhost, use the Worker started with `npx wrangler dev --port 8787`.
const WORKER = (CONFIG.workerUrl || (isLocal ? 'http://localhost:8787' : '')).replace(/\/+$/, '');

const state = {
  account: null, chainId: null, previewWallet: false,
  input: '', source: null, // { kind: 'paste'|'file'|'url', name }
  report: null, scanning: false, scanNote: null, stamped: null, // stamped: { id, tx }
  counts: null,
};

// ============================================================
// Small helpers
// ============================================================
const $ = (id) => document.getElementById(id);
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const svgUse = (id) => h('span', { html: `<svg width="16" height="16"><use href="#${id}"/></svg>`, style: 'display:contents' });
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const shortHash = (x) => (x ? `${x.slice(0, 10)}…${x.slice(-6)}` : '');
const fmtDate = (sec) => new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDay = (sec) => new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const explorer = (path) => `${NET.explorer}/${path}`;
const contractUrl = () => (NET.contract ? explorer(`address/${NET.contract}`) : NET.explorer);
const ext = (href, text, cls = '') => h('a', { href, target: '_blank', rel: 'noopener', class: cls }, text);

let toastTimer;
function toast(...parts) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, ...parts);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 4200);
}
async function copy(text, what = 'Link copied') {
  try { await navigator.clipboard.writeText(text); toast(what); }
  catch { window.prompt('Copy this link:', text); }
}

const friendly = (message) => Object.assign(new Error(message), { friendly: true });
function parseRevert(e) {
  const iface = new ethers.Interface(ABI);
  for (const data of [e?.data, e?.info?.error?.data?.data, e?.info?.error?.data, e?.error?.data?.data, e?.error?.data]) {
    if (typeof data !== 'string' || !data.startsWith('0x')) continue;
    try { return iface.parseError(data)?.name; } catch { /* not ours */ }
  }
  return null;
}
const isCancel = (e) => e?.code === 4001 || e?.code === 'ACTION_REJECTED' || e?.info?.error?.code === 4001;
function explain(e) {
  if (e?.friendly) return e.message;
  if (isCancel(e)) return 'Cancelled in MetaMask. Nothing was stamped.';
  const name = e?.revert?.name || parseRevert(e);
  if (name && REVERTS[name]) return REVERTS[name];
  if (e?.code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(e?.message || '')) return 'Not enough BOT for the gas fee.';
  if (e?.code === -32002) return 'MetaMask is already asking. Open MetaMask to continue.';
  return e?.shortMessage || e?.message || 'Something went wrong. Please try again.';
}

function ring(pct, { size = 132, stroke = 10, label = 'likely AI', tone } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const color = tone || (pct === null ? '#BDBDBD' : pct > 65 ? '#2F6FEB' : pct >= 35 ? '#E5B53A' : '#22A06B');
  const el = h('div', { class: 'ring' + (size >= 150 ? ' big' : ''), style: `width:${size}px;height:${size}px` });
  el.innerHTML = `<svg width="${size}" height="${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#F0F0F0" stroke-width="${stroke}"/>` +
    `<circle class="arc" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c}"/></svg>`;
  el.append(h('div', { class: 'mid' }, h('div', { class: 'num' }, pct === null ? '—' : String(pct), pct === null ? '' : h('small', {}, '%')), h('div', { class: 'sub' }, pct === null ? 'no AI score' : label)));
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', pct === null ? 'No AI score' : `${pct}% ${label}`);
  requestAnimationFrame(() => requestAnimationFrame(() => { el.querySelector('.arc').style.strokeDashoffset = pct === null ? c : c * (1 - pct / 100); }));
  return el;
}
const labelChip = (label) => h('span', { class: 'chip ' + (label === 'Likely AI' ? 'blue' : label === 'Mixed' ? 'amber' : label === 'Likely human' ? 'green' : '') }, label);

// ============================================================
// Chain + preview stores
// ============================================================
// Result.at is Array.prototype.at in ethers, so the timestamp is read by index.
const normCert = (r, id) => ({ id: Number(id), owner: ethers.getAddress(r.owner), textHash: r.textHash, score: Number(r.score), confidence: Number(r.confidence), detector: r.detector, at: Number(r[5]) });
const normPiece = (p, drafts, id) => ({
  id: Number(id), author: ethers.getAddress(p.author), title: p.title, createdAt: Number(p.createdAt),
  drafts: [...drafts].map((d) => ({ textHash: d.textHash, words: Number(d.words), at: Number(d[2]) })),
});

// Lower-casing first accepts an address pasted with the wrong checksum casing.
const contractAddress = () => ethers.getAddress(NET.contract.trim().toLowerCase());
let readerCache = null;
const reader = () => (readerCache ||= new ethers.Contract(contractAddress(), ABI, new ethers.JsonRpcProvider(NET.rpc, NET.chainId, { staticNetwork: true })));
async function writer() {
  const signer = await new ethers.BrowserProvider(window.ethereum).getSigner();
  return new ethers.Contract(contractAddress(), ABI, signer);
}
const notFound = (e) => (e?.revert?.name || parseRevert(e)) === 'NotFound';

async function send(contract, method, args, eventName, onStep) {
  await contract[method].staticCall(...args); // surfaces reverts before MetaMask opens
  onStep('confirm');
  const tx = await contract[method](...args);
  onStep('mining', tx.hash);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw friendly('The transaction failed on-chain. Nothing was stamped.');
  const log = receipt.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === eventName);
  return { tx: tx.hash, log };
}

const chainStore = {
  async counts() {
    const [certs, drafts] = await Promise.all([reader().certificateCount(), reader().draftCount()]);
    return { certs: Number(certs), drafts: Number(drafts) };
  },
  async cert(id) {
    try { return normCert(await reader().getCertificate(id), id); } catch (e) { if (notFound(e)) return null; throw e; }
  },
  async certsForHash(hash) { return [...(await reader().certificatesForHash(hash))].map(Number); },
  async certsOf(addr) { return [...(await reader().certificatesOf(addr))].map(Number); },
  async piece(id) {
    try {
      const [p, d] = await Promise.all([reader().getPiece(id), reader().getDrafts(id)]);
      return normPiece(p, d, id);
    } catch (e) { if (notFound(e)) return null; throw e; }
  },
  async piecesOf(addr) { return [...(await reader().piecesOf(addr))].map(Number); },
  async stampCertificate(hash, score, confidence, detector, onStep) {
    const { tx, log } = await send(await writer(), 'stampCertificate', [hash, score, confidence, detector], 'CertificateStamped', onStep);
    return { tx, id: Number(log.args.id) };
  },
  async createPiece(title, onStep) {
    const { tx, log } = await send(await writer(), 'createPiece', [title], 'PieceCreated', onStep);
    return { tx, id: Number(log.args.id) };
  },
  async stampDraft(pieceId, hash, words, onStep) {
    const { tx, log } = await send(await writer(), 'stampDraft', [pieceId, hash, words], 'DraftStamped', onStep);
    return { tx, index: Number(log.args.index) };
  },
};

// Preview: the contract's rules, kept in this browser's localStorage, seeded with example data.
const previewStore = {
  key: 'inkprint.preview.v1',
  data: null,
  async load() {
    if (this.data) return this.data;
    try {
      const saved = JSON.parse(storage(this.key) || 'null');
      if (saved && Array.isArray(saved.certs)) return (this.data = saved);
    } catch { /* reseed */ }
    const demo = '0x5eE6000000000000000000000000000000000042';
    const now = Math.floor(Date.now() / 1000);
    const day = 86400;
    const certs = [];
    for (const [i, key] of ['human', 'mixed', 'ai'].entries()) {
      const { text, detection } = sampleDetection(key);
      const r = buildReport(text, detection);
      certs.push({ id: i, owner: demo, textHash: await fingerprint(r.text), score: r.score, confidence: r.confidence, detector: 'Example data', at: now - (3 - i) * day });
    }
    const randomHash = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const pieces = [{ id: 0, author: demo, title: 'On walking to school', createdAt: now - 7 * day,
      drafts: [[320, 7], [810, 4], [1240, 0]].map(([words, ago]) => ({ textHash: randomHash(), words, at: now - ago * day - 3600 })) }];
    this.data = { certs, pieces };
    this.save();
    return this.data;
  },
  save() { storage(this.key, JSON.stringify(this.data)); },
  async fakeTx(onStep) {
    onStep('confirm'); await sleep(600);
    const tx = '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    onStep('mining', tx); await sleep(1400);
    return tx;
  },
  async counts() { const d = await this.load(); return { certs: d.certs.length, drafts: d.pieces.reduce((a, p) => a + p.drafts.length, 0) }; },
  async cert(id) { return (await this.load()).certs[id] || null; },
  async certsForHash(hash) { return (await this.load()).certs.filter((c) => c.textHash === hash).map((c) => c.id); },
  async certsOf(addr) { return (await this.load()).certs.filter((c) => c.owner.toLowerCase() === addr.toLowerCase()).map((c) => c.id); },
  async piece(id) { return (await this.load()).pieces[id] || null; },
  async piecesOf(addr) { return (await this.load()).pieces.filter((p) => p.author.toLowerCase() === addr.toLowerCase()).map((p) => p.id); },
  async stampCertificate(textHash, score, confidence, detector, onStep) {
    const d = await this.load();
    const tx = await this.fakeTx(onStep);
    const id = d.certs.length;
    d.certs.push({ id, owner: state.account, textHash, score, confidence, detector, at: Math.floor(Date.now() / 1000) });
    this.save();
    return { tx, id };
  },
  async createPiece(title, onStep) {
    const d = await this.load();
    if (new TextEncoder().encode(title).length > 120) throw friendly(REVERTS.TitleTooLong);
    const tx = await this.fakeTx(onStep);
    const id = d.pieces.length;
    d.pieces.push({ id, author: state.account, title, createdAt: Math.floor(Date.now() / 1000), drafts: [] });
    this.save();
    return { tx, id };
  },
  async stampDraft(pieceId, textHash, words, onStep) {
    const d = await this.load();
    const p = d.pieces[pieceId];
    if (!p) throw friendly(REVERTS.NotFound);
    if (p.author.toLowerCase() !== state.account.toLowerCase()) throw friendly(REVERTS.NotAuthor);
    const tx = await this.fakeTx(onStep);
    p.drafts.push({ textHash, words, at: Math.floor(Date.now() / 1000) });
    this.save();
    return { tx, index: p.drafts.length - 1 };
  },
};
if (PREVIEW && params.has('reset')) storage(previewStore.key, null);
const store = PREVIEW ? previewStore : chainStore;
const txLink = (tx) => (PREVIEW ? null : ext(explorer(`tx/${tx}`), 'View transaction ↗'));

// ============================================================
// Wallet
// ============================================================
async function switchChain() {
  const eth = window.ethereum;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    const unknownChain = e.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized chain/i.test(e.message || '');
    if (!unknownChain) throw e;
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: CHAIN_HEX, chainName: NET.name, nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 }, rpcUrls: [NET.rpc], blockExplorerUrls: [NET.explorer] }],
    });
  }
  state.chainId = Number(await eth.request({ method: 'eth_chainId' }));
  if (state.chainId !== NET.chainId) throw friendly(`MetaMask is not on ${NET.name}.`);
  renderWallet();
}

async function setAccount(account, { preview = false } = {}) {
  const next = account ? ethers.getAddress(account) : null;
  if (next === state.account && preview === state.previewWallet) return;
  state.account = next;
  state.previewWallet = preview;
  renderWallet();
  rerenderForAccount();
}

// Scan and Verify don't depend on the wallet, so they keep their state (and any stamp in progress).
function rerenderForAccount() {
  const r = currentRoute();
  if (r.view === 'app' && !['scan', 'verify'].includes(r.tab)) renderPanel();
}

async function connect() {
  const eth = window.ethereum;
  if (!eth) {
    if (PREVIEW) { await setAccount(PREVIEW_WALLET, { preview: true }); storage('inkprint.previewWallet', '1'); toast('Preview wallet connected — nothing touches the chain.'); return true; }
    installModal();
    return false;
  }
  try {
    const [account] = await eth.request({ method: 'eth_requestAccounts' });
    state.chainId = Number(await eth.request({ method: 'eth_chainId' }));
    await setAccount(account);
    if (!PREVIEW && state.chainId !== NET.chainId) await switchChain();
    return !!state.account;
  } catch (e) {
    if (!isCancel(e)) toast(explain(e));
    renderWallet();
    return false;
  }
}

const wrongNetwork = () => !PREVIEW && !state.previewWallet && !!state.account && state.chainId !== NET.chainId;

// Connected and on BOT Chain, ready to send a transaction.
async function ensureReady() {
  if (!state.account) { if (!(await connect())) return false; }
  if (wrongNetwork()) {
    try { await switchChain(); } catch (e) { if (!isCancel(e)) toast(explain(e)); return false; }
  }
  return true;
}

async function initWallet() {
  const eth = window.ethereum;
  if (!eth) {
    if (PREVIEW && storage('inkprint.previewWallet')) await setAccount(PREVIEW_WALLET, { preview: true });
    return;
  }
  eth.on?.('accountsChanged', ([account]) => setAccount(account));
  eth.on?.('chainChanged', (id) => { state.chainId = Number(id); renderWallet(); rerenderForAccount(); });
  try {
    const [account] = await eth.request({ method: 'eth_accounts' });
    state.chainId = Number(await eth.request({ method: 'eth_chainId' }));
    if (account) await setAccount(account);
  } catch { /* stay signed out */ }
}

function walletButton({ small = true } = {}) {
  const cls = 'btn ' + (small ? 'small ' : '');
  if (!window.ethereum && !PREVIEW) return h('a', { class: cls + 'light', href: 'https://metamask.io/download/', target: '_blank', rel: 'noopener' }, 'Install MetaMask');
  if (!state.account) return h('button', { class: cls + 'light', type: 'button', onclick: connect }, 'Connect');
  if (wrongNetwork()) return h('button', { class: cls + 'light', type: 'button', onclick: () => switchChain().catch((e) => { if (!isCancel(e)) toast(explain(e)); }) }, 'Switch to BOT Chain');
  return h('a', { class: cls + 'light', href: '#/certs', title: state.account }, h('span', { class: 'dot' }), short(state.account));
}

function renderWallet() {
  const parts = [];
  if (netKey === 'testnet') parts.push(h('span', { class: 'badge' }, 'Testnet'));
  if (PREVIEW) parts.push(h('span', { class: 'badge', title: 'No contract configured yet: stamps are simulated in this browser.' }, 'Preview'));
  parts.push(walletButton());
  $('wallet-slot').replaceChildren(...parts);
}

function installModal() {
  openModal(
    h('h2', {}, 'Install MetaMask'),
    h('p', {}, 'Stamping a certificate or a draft writes to BOT Chain, so it needs a wallet. Scanning and verifying work without one.'),
    h('div', { class: 'row', style: 'margin-top:20px' },
      h('a', { class: 'btn black', href: 'https://metamask.io/download/', target: '_blank', rel: 'noopener' }, 'Get MetaMask ↗'),
      h('button', { class: 'btn light', type: 'button', onclick: closeModal }, 'Not now')));
}

let lastFocus = null;
function openModal(...content) {
  closeModal();
  lastFocus = document.activeElement;
  const card = h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true' }, ...content);
  const m = h('div', { class: 'modal', onclick: (e) => { if (e.target === m) closeModal(); } }, card);
  document.body.append(m);
  card.querySelector('a,button')?.focus();
}
function closeModal() { const m = document.querySelector('.modal'); if (m) { m.remove(); lastFocus?.focus?.(); } }

// ============================================================
// Reading input: paste, .txt, PDF, .docx, URL
// ============================================================
const loaded = {};
function loadScript(src) {
  return (loaded[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.crossOrigin = 'anonymous'; s.onload = resolve; s.onerror = () => { delete loaded[src]; reject(friendly('Couldn’t load the file reader. Check your connection and try again.')); };
    document.head.append(s);
  }));
}
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const MAMMOTH = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
const MAX_FILE = 15 * 1024 * 1024;

async function readFile(file) {
  const name = file.name.toLowerCase();
  if (file.size > MAX_FILE) throw friendly('That file is over 15 MB. Paste the text instead.');
  let text;
  if (name.endsWith('.txt') || file.type === 'text/plain' || name.endsWith('.md')) {
    text = await file.text();
  } else if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    await loadScript(PDFJS + 'pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
    let pdf;
    try { pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; }
    catch { throw friendly('Couldn’t open that PDF. It may be damaged or password-protected — paste the text instead.'); }
    const pages = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 60); i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      pages.push(content.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join(''));
      if (pages.join('').length > MAX_CHARS * 1.5) break;
    }
    text = pages.join('\n\n');
  } else if (name.endsWith('.docx')) {
    await loadScript(MAMMOTH);
    try { text = (await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value; }
    catch { throw friendly('Couldn’t read that Word file. Try saving it again as .docx, or paste the text.'); }
  } else if (name.endsWith('.doc')) {
    throw friendly('Older .doc files aren’t supported. Save it as .docx, or paste the text.');
  } else {
    throw friendly('Unsupported file. Use .txt, .pdf or .docx — or paste the text.');
  }
  text = tidyText(text);
  if (wordCount(text) < 5) throw friendly('No text found — paste it instead. (Scanned PDFs are images, so there’s no text to read.)');
  return text;
}

// Joins PDF line wraps back into paragraphs; keeps blank-line paragraph breaks.
function tidyText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
    .replace(/([^\n.!?:"”’)])\n(?=[\p{Ll}\p{N}(])/gu, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const isUrl = (s) => /^https?:\/\/[^\s]+$/i.test(s.trim());

async function workerPost(path, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(WORKER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e?.name === 'AbortError' ? 'timeout' : 'network' } };
  } finally { clearTimeout(timer); }
}

const URL_ERRORS = {
  blocked: 'That address isn’t allowed — only public web pages can be read.',
  bad_url: 'That doesn’t look like a web address.',
  paywalled: 'That page is behind a login or paywall.',
  no_text: 'Couldn’t find article text on that page — it may be paywalled or built with JavaScript.',
  not_html: 'That link isn’t a web page. For a PDF, download it and drop the file here.',
  too_large: 'That page is too large (over 2 MB).',
  timeout: 'That page took too long to load.',
  rate_limited: 'You’ve hit the hourly limit for reading links.',
};
async function readUrl(url) {
  if (!WORKER) throw friendly('Reading links needs the Inkprint Worker, which isn’t set up on this site yet. Paste the text instead.');
  const { ok, data } = await workerPost('/extract-url', { url }, CONFIG.extractTimeoutMs);
  if (!ok) throw friendly(`${URL_ERRORS[data.error] || 'Couldn’t read that page.'} Paste the text instead.`);
  return { text: tidyText(data.text), title: data.title };
}

const DETECT_ERRORS = {
  rate_limited: 'You’ve reached 10 scans this hour, so this report has signals only.',
  not_configured: 'The detector isn’t set up yet, so this report has signals only.',
  upstream_busy: 'The detector is busy right now, so this report has signals only.',
  upstream_timeout: 'The detector took too long, so this report has signals only.',
  timeout: 'The detector took too long, so this report has signals only.',
};
async function detect(text) {
  if (!WORKER) return { detection: null, note: 'No detector is connected on this site yet, so this report has signals only.' };
  const { ok, data } = await workerPost('/detect', { text }, CONFIG.detectTimeoutMs);
  if (ok && Number.isFinite(data.score)) return { detection: data, note: null };
  return { detection: null, note: DETECT_ERRORS[data.error] || 'The detector is unavailable right now, so this report has signals only.' };
}

// ============================================================
// Report rendering (shared by Scan and the home page samples)
// ============================================================
let tipEl = null;
function showTip(target) {
  const s = target.dataset.score;
  if (s === undefined) return;
  tipEl ||= document.body.appendChild(h('div', { class: 'tip', role: 'tooltip' }));
  tipEl.textContent = s === '' ? 'Not scored' : `${Math.round(Number(s) * 100)}% likely AI · ${tintFor(Number(s)) === 'ai' ? 'likely AI' : tintFor(Number(s)) === 'mixed' ? 'mixed' : 'likely human'}`;
  const r = target.getClientRects()[0] || target.getBoundingClientRect();
  tipEl.style.left = `${Math.min(window.innerWidth - 90, Math.max(90, r.left + r.width / 2))}px`;
  tipEl.style.top = `${r.top}px`;
  tipEl.hidden = false;
  document.querySelectorAll('.hl.on').forEach((x) => x.classList.remove('on'));
  target.classList.add('on');
}
function hideTip() { if (tipEl) tipEl.hidden = true; document.querySelectorAll('.hl.on').forEach((x) => x.classList.remove('on')); }

function highlighted(report) {
  const read = h('div', { class: 'read', tabindex: '0', 'aria-label': 'Your text, highlighted by sentence' });
  let para = null, current = -1;
  report.sentences.forEach((s, i) => {
    if (s.para !== current) { para = h('p'); read.append(para); current = s.para; }
    const tint = tintFor(s.score);
    para.append(h('span', { class: `hl ${tint}`, 'data-i': i, 'data-score': s.score === null ? '' : s.score, tabindex: tint === 'none' && s.score === null ? null : '-1' }, s.text), ' ');
  });
  read.addEventListener('mouseover', (e) => { const t = e.target.closest('.hl'); if (t) showTip(t); });
  read.addEventListener('mouseleave', hideTip);
  read.addEventListener('click', (e) => { const t = e.target.closest('.hl'); if (t) showTip(t); });
  read.addEventListener('scroll', hideTip, { passive: true });
  const total = report.sentences.reduce((a, s) => a + s.text.length, 0) || 1;
  const strip = h('div', { class: 'strip', 'aria-hidden': 'true', title: 'Where AI-like sentences cluster' },
    ...report.sentences.map((s, i) => h('i', {
      class: tintFor(s.score), style: `flex:${s.text.length / total}`,
      onclick: () => { const el = read.querySelector(`[data-i="${i}"]`); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (el) setTimeout(() => showTip(el), 350); },
    })));
  return h('div', { class: 'text-wrap' }, read, strip);
}

function signalCard(s) {
  const dirText = { up: '↑ pushed it up', down: '↓ pulled it down', neutral: '• about neutral', na: 'not measured' }[s.direction];
  const card = h('div', { class: 'sig' },
    h('div', { class: 'sig-head' }, h('h4', {}, s.name), h('span', { class: 'dir ' + s.direction }, dirText)),
    h('div', { class: 'bar', role: 'img', 'aria-label': s.value === null ? 'not measured' : `${s.value} out of 100 AI-like` }, h('i', { class: s.direction, style: 'width:0' })),
    h('p', {}, s.line),
    h('div', { class: 'metric' }, s.metric));
  if (s.key === 'burstiness' && s.lengths?.length) {
    const max = Math.max(...s.lengths);
    card.append(h('div', { class: 'lengths', title: 'Words per sentence' }, ...s.lengths.slice(0, 80).map((n) => h('i', { style: `height:${Math.max(6, (n / max) * 100)}%` }))));
  }
  requestAnimationFrame(() => requestAnimationFrame(() => { card.querySelector('.bar i').style.width = `${s.value ?? 0}%`; }));
  return card;
}

const HONEST = h('div', { class: 'honest' }, h('b', {}, 'AI detectors make mistakes'), ' — especially on short, formal or non-native English writing. Treat this as a signal, not proof. Don’t use it alone to accuse anyone.');

function reportView(report, { example = false, actions = null, notes = [] } = {}) {
  const top = h('div', { class: 'rep-top' },
    ring(report.score, { size: 150, stroke: 11 }),
    h('div', {},
      h('div', { class: 'rep-title' },
        h('h3', {}, report.label),
        report.score !== null ? h('span', { class: 'chip' }, `${report.confidenceLabel} confidence`) : h('span', { class: 'chip' }, 'signals only — no AI score'),
        example ? h('span', { class: 'example-tag' }, 'Example report') : null),
      h('p', { class: 'verdict' }, report.verdict),
      h('p', { class: 'cap', style: 'margin-top:8px' },
        `${report.words.toLocaleString()} words · ${report.sentences.length} sentences`,
        report.detector ? ` · ${example ? 'illustrative scores' : `scored by ${report.detector}`}` : ''),
      actions));
  return h('div', { class: 'report' },
    top,
    ...notes,
    h('div', { class: 'legend' }, h('span', {}, h('i'), 'Likely human'), h('span', {}, h('i', { class: 'mixed' }), 'Mixed'), h('span', {}, h('i', { class: 'ai' }), 'Likely AI'), h('span', {}, 'Hover or tap a sentence for its score')),
    highlighted(report),
    h('div', { class: 'signals' }, ...report.signals.map(signalCard)),
    h('div', { class: 'why' }, h('h4', {}, 'Why'), h('ul', {}, ...report.why.map((w) => h('li', {}, w)))),
    HONEST.cloneNode(true));
}

// ============================================================
// Routing
// ============================================================
function currentRoute() {
  const m = location.hash.match(/^#\/(scan|verify|drafts|certs|cert|piece)(?:\/([^/?#]*))?/);
  if (!m) return { view: 'home' };
  return { view: 'app', tab: m[1], arg: m[2] ? decodeURIComponent(m[2]) : null };
}
const TAB_FOR = { scan: 'scan', verify: 'verify', drafts: 'drafts', piece: 'drafts', certs: 'certs', cert: 'certs' };

function route() {
  hideTip();
  const r = currentRoute();
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === r.view));
  if (r.view === 'home') {
    const id = location.hash.slice(1);
    const target = id && id !== 'top' ? document.getElementById(id) : null;
    if (target) requestAnimationFrame(() => target.scrollIntoView());
    else if (id === 'top') scrollTo(0, 0);
    return;
  }
  document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === TAB_FOR[r.tab]));
  scrollTo(0, 0);
  renderPanel();
}

let panelToken = 0;
function renderPanel() {
  const r = currentRoute();
  const token = ++panelToken;
  const main = $('app-main');
  $('app-addr').textContent = `inkprint · ${r.tab}${r.arg ? ' #' + r.arg : ''}`;
  const render = { scan: renderScan, verify: renderVerify, drafts: renderDrafts, certs: renderCerts, cert: renderCert, piece: renderPiece }[r.tab];
  const stale = () => token !== panelToken;
  main.replaceChildren();
  render(main, r.arg, stale);
}

const head = (title, sub, ...extra) => h('div', { class: 'panel-head' }, h('h2', {}, title), ...extra, sub ? h('p', {}, sub) : null);
const loading = (text = 'Loading…') => h('div', { class: 'row grey' }, h('span', { class: 'spinner' }), text);
const note = (kind, ...parts) => h('div', { class: 'note ' + kind, role: kind === 'err' ? 'alert' : null }, h('div', {}, ...parts));

// ============================================================
// Scan
// ============================================================
function renderScan(main) {
  if (state.report && !state.scanning) return main.append(scanReport());
  const ta = h('textarea', { id: 'scan-input', placeholder: 'Paste text, drop a file or a URL', 'aria-label': 'Text to scan', spellcheck: 'false' });
  ta.value = state.input;
  const count = h('span', { class: 'count', 'aria-live': 'polite' });
  const fileInput = h('input', { type: 'file', accept: '.txt,.pdf,.docx,.md,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document', class: 'sr', id: 'scan-file' });
  const scanBtn = h('button', { class: 'btn black', type: 'button' }, svgUse('i-up'), 'Scan');
  const hint = h('div', { id: 'scan-hint' });
  const drop = h('div', { class: 'drop' }, ta, h('div', { class: 'drop-bar' }, count,
    h('label', { class: 'btn light small', for: 'scan-file', role: 'button', tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } } }, 'Upload file'), fileInput, scanBtn));

  function update() {
    state.input = ta.value;
    const v = ta.value.trim();
    if (isUrl(v)) {
      count.textContent = 'Web address';
      scanBtn.lastChild.textContent = 'Fetch & scan';
      hint.replaceChildren(note('info', 'Inkprint will fetch this page and scan its main article text. ', h('span', { class: 'chip blue' }, 'beta')));
      return;
    }
    scanBtn.lastChild.textContent = 'Scan';
    const n = wordCount(v);
    count.textContent = `${n.toLocaleString()} words · ${v.length.toLocaleString()} / ${MAX_CHARS.toLocaleString()} characters`;
    if (!v) hint.replaceChildren();
    else if (v.length > MAX_CHARS) hint.replaceChildren(note('', h('b', {}, 'Too long. '), `Only the first ${MAX_CHARS.toLocaleString()} characters will be scanned.`));
    else if (n < MIN_WORDS) hint.replaceChildren(note('', h('b', {}, 'Add more text for a reliable result. '), `${MIN_WORDS}+ words works best. You can still scan — the result will be Low confidence.`));
    else hint.replaceChildren();
  }
  ta.addEventListener('input', () => { state.source = { kind: 'paste' }; update(); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runScan(); } });
  scanBtn.addEventListener('click', runScan);

  async function useFile(file) {
    if (!file) return;
    hint.replaceChildren(loading(`Reading ${file.name}…`));
    try {
      ta.value = await readFile(file);
      state.source = { kind: 'file', name: file.name };
      update();
      toast(`Read ${file.name} — ${wordCount(ta.value).toLocaleString()} words.`);
    } catch (e) {
      hint.replaceChildren(note('err', explain(e)));
    }
    fileInput.value = '';
  }
  fileInput.addEventListener('change', () => useFile(fileInput.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    const file = e.dataTransfer.files?.[0];
    if (file) useFile(file);
    else { const t = e.dataTransfer.getData('text/plain'); if (t) { ta.value = t; update(); } }
  });

  async function runScan() {
    let text = ta.value.trim();
    if (!text) { hint.replaceChildren(note('err', 'Add some text first — paste it, drop a file, or enter a URL.')); ta.focus(); return; }
    scanBtn.disabled = true;
    const notes = [];
    try {
      if (isUrl(text)) {
        hint.replaceChildren(loading('Fetching the page…'));
        const page = await readUrl(text);
        state.source = { kind: 'url', name: text };
        text = page.text;
        ta.value = text;
        state.input = text;
        notes.push(note('info', `Read from ${new URL(state.source.name).hostname}${page.title ? ` — “${page.title}”` : ''}.`));
      }
      if (wordCount(text) < 8) { hint.replaceChildren(note('err', 'Add a few full sentences — there isn’t enough text to analyse.')); return; }
      const fit = fitLength(text);
      if (fit.trimmed) notes.push(note('', h('b', {}, 'Trimmed. '), `Only the first ${fit.text.length.toLocaleString()} characters were scanned (the limit is ${MAX_CHARS.toLocaleString()}).`));
      state.scanning = true;
      main.replaceChildren(head('Scanning…', null), h('div', { class: 'stack' }, loading(WORKER ? 'Asking the detector and measuring signals…' : 'Measuring signals…')));
      const { detection, note: detectNote } = await detect(fit.text);
      const report = buildReport(fit.text, detection);
      if (detectNote) notes.unshift(note('', h('b', {}, 'Signals only — no AI score. '), detectNote));
      if (report.short) notes.push(note('', h('b', {}, 'Low confidence. '), `Only ${report.words} words — add more text (${MIN_WORDS}+) for a reliable result.`));
      state.report = report;
      state.scanNotes = notes;
      state.stamped = null;
    } catch (e) {
      hint.replaceChildren(note('err', explain(e)));
      return;
    } finally {
      scanBtn.disabled = false;
      state.scanning = false;
    }
    renderPanel();
  }

  main.append(head('Scan', 'Paste text, drop a .txt, PDF or .docx file, or enter a link. Files are read in your browser; the text isn’t kept.'), h('div', { class: 'stack' }, drop, hint));
  update();
}

function scanReport() {
  const report = state.report;
  const stampSlot = h('div', { class: 'stack' });
  const actions = h('div', { class: 'rep-actions' },
    h('button', { class: 'btn black', type: 'button', onclick: () => stampFlow(stampSlot) }, svgUse('i-cert'), 'Stamp scan certificate'),
    h('button', { class: 'btn light', type: 'button', onclick: () => { state.report = null; state.input = ''; renderPanel(); } }, 'New scan'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => { state.report = null; renderPanel(); } }, 'Edit text'));
  const view = h('div', { class: 'stack' },
    head('Report', null),
    reportView(report, { actions, notes: state.scanNotes || [] }),
    stampSlot);
  if (state.stamped) showStamped(stampSlot, state.stamped);
  return view;
}

async function stampFlow(slot) {
  const report = state.report;
  if (state.stamped) { slot.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
  slot.replaceChildren(h('div', { class: 'stamp-box' }, loading('Fingerprinting your text…')));
  slot.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const hash = await fingerprint(report.text);
  const score = report.score === null ? NO_SCORE : report.score;
  const detector = (report.detector || 'signals only').slice(0, 64);
  const info = h('div', { class: 'stack' },
    h('p', {}, 'This stamps on ', h('b', {}, NET.name), ': the fingerprint ', h('span', { class: 'mono' }, shortHash(hash)), `, ${report.score === null ? 'no AI score (signals only)' : `${report.score}% likely AI`}, ${report.confidenceLabel} confidence, ${detector}, and the time. `, h('b', {}, 'Not the text.')),
    h('p', { class: 'cap' }, 'Keep a copy of the exact text — it’s what anyone needs to verify this certificate later.'));
  const status = h('div', { 'aria-live': 'polite' });
  const go = h('button', { class: 'btn black', type: 'button' }, PREVIEW ? 'Stamp (preview)' : 'Confirm in MetaMask');
  const box = h('div', { class: 'stamp-box stack' }, info, h('div', { class: 'row' }, go, h('button', { class: 'btn light', type: 'button', onclick: () => slot.replaceChildren() }, 'Cancel')), status);
  slot.replaceChildren(box);
  go.addEventListener('click', async () => {
    if (!(await ensureReady())) { status.replaceChildren(note('', 'Connect your wallet on BOT Chain to stamp. Scanning and verifying work without one.')); return; }
    go.disabled = true;
    try {
      const done = await store.stampCertificate(hash, score, report.confidence, detector, (step, tx) => {
        status.replaceChildren(step === 'confirm'
          ? loading(PREVIEW ? 'Preview: confirming…' : 'Confirm the transaction in MetaMask…')
          : h('div', { class: 'row grey' }, h('span', { class: 'spinner' }), 'Stamping on BOT Chain… ', tx && !PREVIEW ? ext(explorer(`tx/${tx}`), 'view transaction ↗') : ''));
      });
      state.stamped = done;
      showStamped(slot, done);
      refreshCounts();
    } catch (e) {
      status.replaceChildren(note('err', explain(e), ' ', h('button', { class: 'btn small light', type: 'button', onclick: () => go.click() }, 'Try again')));
      go.disabled = false;
    }
  });
}

const certLink = (id) => {
  const u = new URL(location.pathname, location.origin);
  if (netKey === 'testnet') u.searchParams.set('net', 'testnet');
  u.hash = `/cert/${id}`;
  return u.toString();
};
const pieceLink = (id) => certLink(id).replace(/#\/cert\//, '#/piece/');

function showStamped(slot, { id, tx }) {
  slot.replaceChildren(h('div', { class: 'note ok' }, h('div', { class: 'stack', style: 'gap:10px' },
    h('div', {}, h('b', {}, `✓ Certificate #${id} stamped`), PREVIEW ? ' (preview — kept in this browser)' : ' on BOT Chain.'),
    h('div', { class: 'row' },
      h('a', { class: 'btn small black', href: `#/cert/${id}` }, 'Open certificate'),
      h('button', { class: 'btn small light', type: 'button', onclick: () => copy(certLink(id)) }, 'Copy link'),
      txLink(tx)))));
}

// ============================================================
// Verify (app panel + the home page box share this)
// ============================================================
function parseCertRef(input) {
  const s = input.trim();
  const m = s.match(/#\/cert\/(\d+)\s*$/) || s.match(/^#?(\d{1,9})$/) || s.match(/^certificate\s*#?(\d+)$/i);
  return m ? Number(m[1]) : null;
}

async function verifyText(input) {
  const ref = parseCertRef(input);
  if (ref !== null) return { kind: 'ref', id: ref };
  const hash = await fingerprint(input);
  const ids = await store.certsForHash(hash);
  const certs = (await Promise.all(ids.map((id) => store.cert(id)))).filter(Boolean);
  return { kind: 'text', hash, certs };
}

const certSummary = (c) => `${c.score === NO_SCORE ? 'signals only (no AI score)' : `${c.score}% likely AI`} (${CONFIDENCE[c.confidence] || '—'})`;

function verifyResult(out) {
  if (out.kind === 'ref') return null;
  if (!out.certs.length) return note('', h('b', {}, 'No certificate for this exact text. '), 'Even one changed character changes the fingerprint. (Spacing and line breaks are ignored.)');
  const [first, ...more] = out.certs;
  return h('div', { class: 'stack', style: 'gap:8px' },
    note('ok', h('b', {}, `✓ Matches certificate #${first.id}`), `, stamped ${fmtDate(first.at)}, ${certSummary(first)}. `, h('a', { href: `#/cert/${first.id}` }, 'Open ›')),
    more.length ? h('p', { class: 'cap' }, `Also stamped as `, ...more.flatMap((c, i) => [i ? ', ' : '', h('a', { href: `#/cert/${c.id}` }, `#${c.id}`)]), '.') : null);
}

function bindHomeVerify() {
  const form = $('home-verify');
  const input = $('home-verify-input');
  const out = $('home-verify-result');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value.trim()) { out.replaceChildren(note('err', 'Paste some text or a certificate link first.')); return; }
    out.replaceChildren(loading('Checking BOT Chain…'));
    try {
      const res = await verifyText(input.value);
      if (res.kind === 'ref') { location.hash = `/cert/${res.id}`; return; }
      out.replaceChildren(verifyResult(res));
    } catch (err) { out.replaceChildren(note('err', 'Couldn’t reach BOT Chain. Check your connection and try again.')); console.error(err); }
  });
}

function renderVerify(main) {
  const ta = h('textarea', { placeholder: 'Paste the text, or a certificate link…', style: 'min-height:200px', 'aria-label': 'Text or certificate link' });
  const out = h('div', { 'aria-live': 'polite' });
  const btn = h('button', { class: 'btn black', type: 'submit' }, svgUse('i-check'), 'Verify');
  const form = h('form', { class: 'stack' }, ta, h('div', { class: 'row end' }, btn), out);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!ta.value.trim()) { out.replaceChildren(note('err', 'Paste some text or a certificate link first.')); return; }
    btn.disabled = true;
    out.replaceChildren(loading('Fingerprinting and checking BOT Chain…'));
    try {
      const res = await verifyText(ta.value);
      if (res.kind === 'ref') { location.hash = `/cert/${res.id}`; return; }
      out.replaceChildren(verifyResult(res), h('p', { class: 'cap', style: 'margin-top:10px' }, 'Fingerprint: ', h('span', { class: 'mono' }, res.hash)));
    } catch (err) { out.replaceChildren(note('err', 'Couldn’t reach BOT Chain. Check your connection and try again.')); console.error(err); }
    finally { btn.disabled = false; }
  });
  main.append(head('Verify', 'Paste a text to find its certificates, or paste a certificate link to open it. Your text stays in this browser — only its fingerprint is looked up.'), form);
}

// ============================================================
// Certificates
// ============================================================
function connectPrompt(main, why) {
  main.append(h('div', { class: 'empty stack' },
    h('p', {}, why),
    h('div', { class: 'row', style: 'justify-content:center' }, walletButton({ small: false }))));
}

async function renderCerts(main, _arg, stale) {
  main.append(head('Certificates', 'Scan certificates stamped from your wallet. Open one to share its link.'));
  if (!state.account) return connectPrompt(main, 'Connect your wallet to see the certificates you’ve stamped. To check someone else’s, use Verify.');
  const list = h('div', { class: 'list' }, loading());
  main.append(list);
  try {
    const ids = (await store.certsOf(state.account)).reverse();
    const certs = (await Promise.all(ids.slice(0, 50).map((id) => store.cert(id)))).filter(Boolean);
    if (stale()) return;
    if (!certs.length) return list.replaceChildren(h('div', { class: 'empty' }, 'No certificates yet. ', h('a', { href: '#/scan' }, 'Scan a text'), ' and stamp the result.'));
    list.replaceChildren(...certs.map((c) => h('a', { href: `#/cert/${c.id}` },
      h('b', {}, `#${c.id}`), labelChip(c.score === NO_SCORE ? 'Signals only' : labelFor(c.score)), h('span', {}, certSummary(c)), h('span', { class: 'meta' }, fmtDate(c.at)))));
  } catch (e) { if (!stale()) list.replaceChildren(note('err', 'Couldn’t load your certificates from BOT Chain.')); console.error(e); }
}

async function renderCert(main, arg, stale) {
  const id = /^\d+$/.test(arg || '') ? Number(arg) : null;
  main.append(loading('Loading certificate…'));
  let c = null;
  try { c = id === null ? null : await store.cert(id); }
  catch (e) { console.error(e); if (!stale()) main.replaceChildren(note('err', 'Couldn’t reach BOT Chain. Check your connection and reload.')); return; }
  if (stale()) return;
  if (!c) return main.replaceChildren(head('Not found', null), h('div', { class: 'empty' }, `There’s no certificate ${id === null ? 'with that id' : '#' + id}${PREVIEW ? ' in this preview' : ` on ${NET.name}`}. `, h('a', { href: '#/verify' }, 'Verify a text instead')));
  const scored = c.score !== NO_SCORE;
  const label = scored ? labelFor(c.score) : 'Signals only';
  const ta = h('textarea', { placeholder: 'Paste the text to check it matches this certificate…', style: 'min-height:140px', 'aria-label': 'Text to check' });
  const out = h('div', { 'aria-live': 'polite' });
  const check = h('form', { class: 'stack' }, ta, h('div', { class: 'row end' }, h('button', { class: 'btn black', type: 'submit' }, svgUse('i-check'), 'Check text')), out);
  check.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!ta.value.trim()) return out.replaceChildren(note('err', 'Paste the text first.'));
    const hash = await fingerprint(ta.value);
    out.replaceChildren(hash === c.textHash
      ? note('ok', h('b', {}, `✓ Matches certificate #${c.id}. `), `This exact text was scanned on ${fmtDate(c.at)}.`)
      : note('', h('b', {}, 'Doesn’t match. '), 'This isn’t the text that was stamped — even one changed character changes the fingerprint.'));
  });
  main.replaceChildren(
    head(`Certificate #${c.id}`, null, h('button', { class: 'btn small light', type: 'button', onclick: () => copy(certLink(c.id)) }, 'Copy link')),
    h('div', { class: 'stack' },
      h('div', { class: 'cert' },
        h('div', { class: 'cert-head' },
          ring(scored ? c.score : null, { size: 132 }),
          h('div', {},
            h('div', { class: 'rep-title' }, h('h3', {}, label), h('span', { class: 'chip' }, scored ? `${CONFIDENCE[c.confidence]} confidence` : 'no AI score'), PREVIEW ? h('span', { class: 'badge' }, 'Preview') : null),
            h('p', { class: 'verdict' }, scored ? `The detector rated this text ${c.score}% likely AI when it was scanned.` : 'The detector wasn’t available, so this scan was stamped with signals only and no AI score.'),
            h('p', { class: 'cap', style: 'margin-top:6px' }, 'The score was reported by the app. The certificate proves which text was scanned and when — not that the score is true.'))),
        h('dl', {},
          h('div', {}, h('dt', {}, 'Stamped'), h('dd', {}, new Date(c.at * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))),
          h('div', {}, h('dt', {}, 'Detector'), h('dd', {}, c.detector)),
          h('div', {}, h('dt', {}, 'Stamped by'), h('dd', { class: 'mono' }, PREVIEW ? short(c.owner) : ext(explorer(`address/${c.owner}`), short(c.owner)))),
          h('div', {}, h('dt', {}, 'Network'), h('dd', {}, PREVIEW ? 'Preview (this browser)' : `${NET.name} · chain ID ${NET.chainId}`)),
          h('div', { style: 'grid-column:1/-1;border-bottom:0' }, h('dt', {}, 'Text fingerprint (SHA-256)'), h('dd', { class: 'mono' }, c.textHash)))),
      h('h3', { style: 'font-size:18px;margin-top:8px' }, 'Check a text against this certificate'),
      check,
      HONEST.cloneNode(true)));
}

// ============================================================
// Writer's proof: pieces and drafts
// ============================================================
async function renderDrafts(main, _arg, stale) {
  main.append(head('Drafts', 'Create a piece, then stamp each draft as you write. Only fingerprints and word counts go on-chain — never your text.'));
  if (!state.account) return connectPrompt(main, 'Connect your wallet to start a piece. Anyone can view a piece’s trail by its link.');
  const title = h('input', { type: 'text', placeholder: 'Title, e.g. “History coursework — Industrial Revolution”', maxlength: '120', 'aria-label': 'Piece title' });
  const status = h('div', { 'aria-live': 'polite' });
  const createBtn = h('button', { class: 'btn black', type: 'submit' }, 'Create piece');
  const form = h('form', { class: 'stamp-box stack' }, h('b', {}, 'New piece'), h('p', { class: 'cap' }, 'The title is stored on-chain and public, so keep it general.'), h('div', { class: 'row', style: 'flex-wrap:nowrap' }, title, createBtn), status);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = title.value.replace(/\s+/g, ' ').trim();
    if (!t) return status.replaceChildren(note('err', REVERTS.EmptyTitle));
    if (new TextEncoder().encode(t).length > 120) return status.replaceChildren(note('err', REVERTS.TitleTooLong));
    if (!(await ensureReady())) return;
    createBtn.disabled = true;
    try {
      const { id } = await store.createPiece(t, (step, tx) => status.replaceChildren(step === 'confirm' ? loading(PREVIEW ? 'Preview: creating…' : 'Confirm in MetaMask…') : h('div', { class: 'row grey' }, h('span', { class: 'spinner' }), 'Creating on BOT Chain… ', tx && !PREVIEW ? ext(explorer(`tx/${tx}`), 'view transaction ↗') : '')));
      location.hash = `/piece/${id}`;
    } catch (err) { status.replaceChildren(note('err', explain(err))); createBtn.disabled = false; }
  });
  const list = h('div', { class: 'list' }, loading());
  main.append(h('div', { class: 'stack' }, form, h('h3', { style: 'font-size:18px;margin-top:10px' }, 'Your pieces'), list));
  try {
    const ids = (await store.piecesOf(state.account)).reverse();
    const pieces = (await Promise.all(ids.slice(0, 50).map((id) => store.piece(id)))).filter(Boolean);
    if (stale()) return;
    if (!pieces.length) return list.replaceChildren(h('div', { class: 'empty' }, 'No pieces yet. Create one above, then stamp your first draft.'));
    list.replaceChildren(...pieces.map((p) => h('a', { href: `#/piece/${p.id}` }, h('b', {}, p.title), h('span', { class: 'chip' }, `${p.drafts.length} draft${p.drafts.length === 1 ? '' : 's'}`), h('span', { class: 'meta' }, p.drafts.length ? `latest ${fmtDate(p.drafts.at(-1).at)}` : `created ${fmtDate(p.createdAt)}`))));
  } catch (e) { if (!stale()) list.replaceChildren(note('err', 'Couldn’t load your pieces from BOT Chain.')); console.error(e); }
}

async function renderPiece(main, arg, stale) {
  const id = /^\d+$/.test(arg || '') ? Number(arg) : null;
  main.append(loading('Loading piece…'));
  let p = null;
  try { p = id === null ? null : await store.piece(id); }
  catch (e) { console.error(e); if (!stale()) main.replaceChildren(note('err', 'Couldn’t reach BOT Chain. Check your connection and reload.')); return; }
  if (stale()) return;
  if (!p) return main.replaceChildren(head('Not found', null), h('div', { class: 'empty' }, `There’s no piece ${id === null ? 'with that id' : '#' + id}${PREVIEW ? ' in this preview' : ` on ${NET.name}`}. `, h('a', { href: '#/drafts' }, 'Back to drafts')));

  const mine = state.account && state.account.toLowerCase() === p.author.toLowerCase();
  const latest = p.drafts.at(-1);
  let attached = [];
  if (latest) { try { attached = await store.certsForHash(latest.textHash); } catch { /* optional */ } }
  if (stale()) return;

  const trail = p.drafts.length
    ? h('ol', { class: 'timeline' }, ...p.drafts.map((d, i) => h('li', { class: i === p.drafts.length - 1 ? 'final' : '' },
      h('div', { class: 'tl-card' }, h('b', {}, `Draft ${i + 1}`), h('span', {}, `${d.words.toLocaleString()} words`), h('span', { class: 'grey' }, fmtDate(d.at)),
        h('span', { class: 'hash', title: d.textHash }, shortHash(d.textHash)),
        i === p.drafts.length - 1 && attached.length ? h('a', { href: `#/cert/${attached.at(-1)}` }, `Scan attached · #${attached.at(-1)}`) : null))))
    : h('div', { class: 'empty' }, mine ? 'No drafts yet. Stamp your first one below.' : 'No drafts stamped yet.');

  const parts = [
    head(p.title, null, h('button', { class: 'btn small light', type: 'button', onclick: () => copy(pieceLink(p.id)) }, 'Copy link')),
    h('p', { class: 'cap', style: 'margin:-8px 0 18px' }, `Piece #${p.id} · by `, PREVIEW ? short(p.author) : ext(explorer(`address/${p.author}`), short(p.author)), ` · started ${fmtDate(p.createdAt)}`, PREVIEW ? ' · preview' : ''),
    trail,
  ];
  const just = state.justStamped?.pieceId === p.id ? state.justStamped.text : null;
  if (mine && just && !attached.length) {
    // Offer to scan the draft just stamped; its certificate then shows here as attached.
    parts.push(note('info', h('b', {}, 'Draft stamped. '), 'Want a scan attached to it? ',
      h('button', { class: 'btn small black', type: 'button', onclick: () => { state.input = just; state.report = null; state.justStamped = null; location.hash = '/scan'; } }, 'Scan this draft')));
  } else if (latest && !attached.length) {
    parts.push(h('p', { class: 'cap', style: 'margin-top:4px' }, 'Tip: scan the final draft and stamp its certificate — it shows up here as attached.'));
  }
  if (mine) parts.push(draftForm(p));
  main.replaceChildren(h('div', { class: 'stack' }, ...parts));
}

function draftForm(p) {
  const ta = h('textarea', { placeholder: 'Paste this draft, or drop a file…', style: 'min-height:160px', 'aria-label': 'Draft text' });
  const fileInput = h('input', { type: 'file', accept: '.txt,.pdf,.docx,.md', class: 'sr', id: 'draft-file' });
  const count = h('span', { class: 'cap', style: 'margin-right:auto' }, '0 words');
  const status = h('div', { 'aria-live': 'polite' });
  const go = h('button', { class: 'btn black', type: 'submit' }, `Stamp draft ${p.drafts.length + 1}`);
  ta.addEventListener('input', () => { count.textContent = `${wordCount(ta.value).toLocaleString()} words`; });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    status.replaceChildren(loading(`Reading ${f.name}…`));
    try { ta.value = await readFile(f); ta.dispatchEvent(new Event('input')); status.replaceChildren(); }
    catch (e) { status.replaceChildren(note('err', explain(e))); }
    fileInput.value = '';
  });
  const form = h('form', { class: 'stamp-box stack' },
    h('b', {}, 'Stamp a new draft'),
    h('p', { class: 'cap' }, 'Your text stays here. Only its fingerprint and word count go on-chain.'),
    ta,
    h('div', { class: 'row' }, count, h('label', { class: 'btn light small', for: 'draft-file' }, 'Upload file'), fileInput, go),
    status);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    const words = wordCount(text);
    if (!words) return status.replaceChildren(note('err', 'Paste the draft first.'));
    const hash = await fingerprint(text);
    if (p.drafts.some((d) => d.textHash === hash)) return status.replaceChildren(note('', 'This exact draft is already stamped on this piece.'));
    if (!(await ensureReady())) return;
    go.disabled = true;
    const n = p.drafts.length + 1;
    try {
      await store.stampDraft(p.id, hash, Math.min(words, 4294967295), (step, tx) => status.replaceChildren(step === 'confirm' ? loading(PREVIEW ? 'Preview: stamping…' : 'Confirm in MetaMask…') : h('div', { class: 'row grey' }, h('span', { class: 'spinner' }), 'Stamping on BOT Chain… ', tx && !PREVIEW ? ext(explorer(`tx/${tx}`), 'view transaction ↗') : '')));
      toast(`Draft ${n} stamped.`);
      state.justStamped = { pieceId: p.id, text };
      refreshCounts();
      renderPanel();
    } catch (err) { status.replaceChildren(note('err', explain(err), ' ', h('button', { class: 'btn small light', type: 'button', onclick: () => go.click() }, 'Try again'))); go.disabled = false; }
  });
  return form;
}

// ============================================================
// Home page bits
// ============================================================
function renderHomeExtras() {
  // hero mockup: the mixed sample, highlighted
  const { text, detection } = sampleDetection('mixed');
  const mixed = buildReport(text, detection);
  const mock = $('mock-text');
  mixed.sentences.slice(0, 7).forEach((s) => mock.append(h('span', { class: `hl ${tintFor(s.score)}` }, s.text), ' '));
  $('mock-ring').append(ring(mixed.score, { size: 120, stroke: 9 }));
  $('mock-chip').textContent = `${mixed.label} · ${mixed.confidenceLabel}`;

  // tiny charts
  const burst = [9, 22, 6, 31, 14, 4, 26, 12, 18, 7];
  $('mini-burst').replaceChildren(...burst.map((n) => h('i', { class: 'b', style: `height:${(n / 31) * 100}%` })));
  const pred = [0.2, 0.3, 0.85, 0.9, 0.4, 0.15, 0.7, 0.92, 0.3, 0.1];
  $('mini-pred').replaceChildren(...pred.map((p) => h('i', { class: 'b', style: `height:${Math.max(10, p * 100)}%;background:${p >= 0.65 ? '#9DBBF7' : p >= 0.35 ? '#F2CF6B' : '#E3E3E3'}` })));

  // sample report tabs
  const tabs = [...document.querySelectorAll('[data-sample]')];
  const show = (key) => {
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.sample === key)));
    const s = sampleDetection(key);
    $('sample-report').replaceChildren(reportView(buildReport(s.text, s.detection), { example: true }));
  };
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.sample)));
  show('mixed');

  // writer's proof example trail
  const year = new Date().getFullYear();
  const day = (m, d) => Math.floor(new Date(year, m, d, 18).getTime() / 1000);
  const example = [[1, 320, day(9, 12), '0x3fa1c2…9e04'], [2, 810, day(9, 15), '0x81d0aa…37bc'], [3, 1240, day(9, 19), '0xc94e51…a1f2']];
  $('proof-timeline').replaceChildren(...example.map(([n, words, at, hash], i) => h('li', { class: i === 2 ? 'final' : '' },
    h('div', { class: 'tl-card' }, h('b', {}, `Draft ${n}`), h('span', {}, `${words.toLocaleString()} words`), h('span', { class: 'grey' }, fmtDay(at)), h('span', { class: 'hash' }, hash),
      ext(contractUrl(), 'Explorer ↗')),
    i === 2 ? h('div', { class: 'tl-card', style: 'margin-top:8px;background:#F5F9FF' }, labelChip('Likely human'), h('span', {}, 'Scan attached · 12% likely AI (High)')) : null)));
}

// ============================================================
// Footer: a mini browser window
// ============================================================
async function refreshCounts() {
  try { state.counts = await store.counts(); } catch { state.counts = null; }
  renderFooter();
}

function renderFooter() {
  const addr = MAINNET.contract;
  const explorerUrl = addr ? `${MAINNET.explorer}/address/${addr}` : MAINNET.explorer;
  const addrText = addr ? `scan.botchain.ai/address/${addr.slice(0, 6)}…${addr.slice(-4)}` : 'scan.botchain.ai · contract deploying soon';
  const c = state.counts;
  const fmt = (n) => (n === null || n === undefined ? '—' : n.toLocaleString());
  const countNote = netKey === 'testnet' ? 'Live from the testnet contract.' : PREVIEW ? 'Preview counts, kept in this browser.' : 'Live from the mainnet contract.';
  $('footer').replaceChildren(h('div', { class: 'col' },
    h('div', { class: 'window' },
      h('div', { class: 'titlebar' },
        h('span', { class: 'lights' }, h('i'), h('i'), h('i')),
        h('a', { class: 'addr-bar mono', href: explorerUrl, target: '_blank', rel: 'noopener', title: addr || 'BOT Chain explorer' }, addrText),
        h('a', { class: 'btn black small', href: explorerUrl, target: '_blank', rel: 'noopener' }, 'View on explorer ↗')),
      h('div', { class: 'win-body' },
        h('nav', { class: 'side', 'aria-label': 'Bookmarks' },
          h('span', { class: 'side-label' }, 'Bookmarks'),
          h('a', { class: 'side-item', href: 'https://botchain.ai', target: '_blank', rel: 'noopener', 'aria-label': 'BOT Chain — botchain.ai' }, h('img', { src: 'images/bot-chain-black.png', alt: '' }), 'BOT Chain'),
          h('a', { class: 'side-item muted', href: '#/scan' }, 'Inkprint · Scan'),
          h('a', { class: 'side-item muted', href: '#/verify' }, 'Verify'),
          h('a', { class: 'side-item muted', href: CONFIG.github, target: '_blank', rel: 'noopener' }, 'GitHub repo')),
        h('div', { class: 'main' },
          h('div', { class: 'tasks' },
            h('span', { class: 'side-label', style: 'display:block;padding:0 0 6px' }, 'Recent tasks'),
            h('h3', {}, 'Every certificate · stamped on BOT Chain'),
            h('div', { class: 'stats' },
              h('div', { class: 'stat' }, h('b', {}, fmt(c?.certs)), h('span', {}, 'certificates')),
              h('div', { class: 'stat' }, h('b', {}, fmt(c?.drafts)), h('span', {}, 'drafts')),
              h('div', { class: 'stat' }, h('b', {}, '677'), h('span', {}, 'chain ID'))),
            h('p', { class: 'cap', style: 'margin-top:12px' }, countNote, ' Only fingerprints and numbers — never text.'))))),
    h('p', { class: 'fine' }, '© Inkprint 2026 · Results are signals, not proof.')));
}

// ============================================================
// Boot
// ============================================================
function boot() {
  renderWallet();
  renderFooter();
  renderHomeExtras();
  bindHomeVerify();
  window.addEventListener('hashchange', route);
  window.addEventListener('scroll', () => { $('nav').classList.toggle('solid', scrollY > 10 || currentRoute().view === 'app'); hideTip(); }, { passive: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); hideTip(); } });
  document.addEventListener('click', (e) => { if (!e.target.closest('.hl')) hideTip(); });
  route();
  $('nav').classList.toggle('solid', currentRoute().view === 'app');
  window.addEventListener('hashchange', () => $('nav').classList.toggle('solid', scrollY > 10 || currentRoute().view === 'app'));
  initWallet();
  refreshCounts();
}

if (!window.ethers) {
  document.querySelector('.view[data-view="home"]').classList.add('active');
  document.body.prepend(h('div', { class: 'note err', style: 'border-radius:0' }, 'Couldn’t load ethers.js. Check your connection and reload.'));
} else {
  boot();
}

// Exposed for tools/check-frontend.mjs, which reads the ABI from this file.
export { ABI };
