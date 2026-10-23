# Inkprint

An honest AI writing detector. Drop in text, a file or a link and get a clear analysis of how AI-like it looks and why — then stamp a scan certificate, or your own drafts, on BOT Chain to prove the writing is yours.

*Results are signals, not proof. No tokens, no payments, no admin. Text is never stored on-chain — only fingerprints and numbers.*

## Status

| | |
|---|---|
| Live site | _not published yet_ |
| Worker (`/detect`, `/extract-url`) | _not deployed yet_ |
| Contract (BOT Chain mainnet, chain ID 677) | _not deployed yet_ |
| Contract (testnet, chain ID 968) | _not deployed yet_ |

## Project layout

- `index.html`: the page — 9 home sections, the app window (Scan · Verify · Drafts · Certificates) and the footer
- `app.js`: the frontend logic, as a plain ES module (ethers.js v6 from CDN, no build step). The `CONFIG` block at the top holds the contract addresses and the Worker URL.
- `analysis.js`: everything computed in the browser — the text fingerprint, sentence splitting, the four signals and the report
- `samples.js`: the three example essays on the home page (texts written for Inkprint; illustrative scores)
- `contracts/Inkprint.sol`: the contract (Solidity ^0.8.20)
- `deploy.html`: one-click deploy from MetaMask, testnet or mainnet
- `build/`: compiled ABI and bytecode, plus the standard JSON input for explorer verification
- `worker/`: the Cloudflare Worker (`POST /detect`, `POST /extract-url`)
- `tools/`: compile, contract tests, analysis tests and a frontend ↔ contract check
- `images/`: the BOT Chain logo for the footer

## Run locally

```bash
python3 -m http.server 4609
```

Then open http://localhost:4609. Two things are switched off until you configure them, and the site stays usable without either:

- **No contract address** → *preview mode*: certificates, pieces and drafts are simulated in this browser's localStorage (seeded with example data), so every screen can be reviewed before deploying. Without MetaMask it uses a preview wallet. Add `?reset` to start over.
- **No Worker URL** → reports are **signals only**: the three in-browser signals, clearly labelled "signals only — no AI score". No score is ever made up. URL import needs the Worker too.

Both are set in `CONFIG` at the top of `app.js`.

## 1. Deploy the contract

Compiled with Solidity 0.8.20, optimizer 200 runs, EVM `paris`. The constructor takes no arguments.

1. Run the site locally and open http://localhost:4609/deploy.html in a browser with MetaMask.
2. Click **Deploy to Testnet (968)**, confirm in MetaMask, then try the app at http://localhost:4609/?net=testnet. On localhost the app picks up the address you just deployed.
3. Click **Deploy to Mainnet (677)**.
4. Paste each address into the matching `contract: ''` field in `CONFIG.networks` in `app.js`, and into the Status table above. The mainnet `contract` is the one constant that feeds the app, the footer address bar and the "View on explorer" link.

Or use Remix: paste `contracts/Inkprint.sol` into https://remix.ethereum.org, compile with 0.8.20 and EVM version `paris`, deploy with *Injected Provider – MetaMask*.

| Network | Chain ID | RPC | Explorer |
|---|---|---|---|
| Testnet | 968 | https://rpc.bohr.life | https://scan.bohr.life |
| Mainnet | 677 | https://rpc.botchain.ai | https://scan.botchain.ai |

To verify on the explorer, use "Standard JSON input" with `build/Inkprint.standard-input.json` and compiler `v0.8.20+commit.a1b79de6`.

## 2. Deploy the Worker

The Worker holds the detector API key as a secret, so it never reaches the browser.

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put DETECTOR_API_KEY
npx wrangler deploy
```

Before deploying, edit `worker/wrangler.toml`:

- `ALLOWED_ORIGINS`: your live site origin(s), comma-separated, no trailing slash. Requests from any other origin get a 403.
- `DETECTOR`: `sapling` (default, [Sapling AI Detector](https://sapling.ai/docs/api/detector)) or `gptzero` ([GPTZero API](https://gptzero.me/docs)). Check the plan's free-tier limits and terms before going live — both return an overall score and per-sentence scores.
- `RATE_LIMIT`: scans per IP per hour (default 10) to protect API credit. Bind a KV namespace as `RATE_KV` to make it hold across instances.

Then paste the Worker URL (no path) into `CONFIG.workerUrl` in `app.js`. On localhost the site uses `http://localhost:8787` automatically, so for local testing put the key in `worker/.dev.vars` (`DETECTOR_API_KEY=...`, git-ignored) and run `npx wrangler dev --port 8787`.

**Shared Worker from Week 1:** both routes are self-contained. To merge them into the shared Worker, copy `DETECTORS`, `tidyResult`, `detect`, `blockedHost`, `extractArticle`, `extractUrl` and their helpers from `worker/src/core.js`, and add the two paths to its router. The rate limiter and CORS helpers are the same pattern as before; the rate-limit keys are namespaced by route.

### What the Worker does

- `POST /detect { text }` → `{ detector, score (0–1), sentences: [{ text, score }] }`. 40–10,000 characters. On any detector failure it returns an error code and the site falls back to signals only.
- `POST /extract-url { url }` → `{ title, text, url }`. Public `http(s)` pages on ports 80/443 only. Refuses `localhost`, private and link-local ranges (`10.x`, `172.16–31.x`, `192.168.x`, `169.254.x`, `100.64/10`, IPv6 loopback / ULA / link-local), internal names (`.local`, `.internal`, single-label hosts) and credentials in the URL. Redirects are followed by hand (up to 3) and every hop is re-checked. 5 s timeout, 2 MB cap. Paywalled or JavaScript-only pages come back as a friendly error.
- **Submitted text is never logged or stored.** Errors log only a status code.

## 3. Publish the site

GitHub Pages: push to `main` and set Pages to serve it (or `git push origin main:gh-pages`). For a custom domain, add it under Settings → Pages, which creates the `CNAME` file. Then add the final origin to `ALLOWED_ORIGINS` and redeploy the Worker, and set `CONFIG.github` in `app.js` to the repo URL for the footer bookmark.

## How it works

### The report

- **Overall:** the detector's score (0–100% likely AI), a confidence band and a label — Likely human (< 35), Mixed (35–65), Likely AI (> 65). Confidence is **Low** under 150 words or when the score sits near the middle, **High** only for 300+ words with a clear score.
- **Sentence highlighting:** the detector splits text its own way, so its sentences are matched back to ours by letters and digits only; a sentence covered by two detector pieces gets a length-weighted mix. Tint: none < 35%, amber 35–65%, blue ≥ 65%. A heat strip shows where AI-like sentences cluster; the verdict names the zone (intro / middle / conclusion).
- **Signals** (each a 0–100 "how AI-like" bar, plus whether it pushed the score up or down):
  - *Burstiness* — coefficient of variation of sentence length, with a chart of lengths.
  - *Repetition* — stock transitions per 100 words ("Moreover", "In conclusion", "It's important to note"…) plus repeated three-word phrases.
  - *Vocabulary* — moving-average type–token ratio over 50-word windows, so length doesn't skew it. A weak signal on its own, and the report says so.
  - *Predictability* — the average of the detector's per-sentence scores. Not measured when the detector is unavailable.
- **Why + honesty box:** three generated bullets, and a fixed note that detectors make mistakes, especially on short, formal or non-native English writing.

### The fingerprint

`SHA-256(normalise(text))`, where `normalise` is Unicode NFC, every run of whitespace (spaces, tabs, line breaks, non-breaking spaces) collapsed to one space, and the ends trimmed. Every letter and punctuation mark still counts, so one changed character means no match. A certificate covers the text that was analysed — if the input was over 10,000 characters, that's the trimmed text, and the report says so.

### On-chain

- **Scan certificate:** `stampCertificate(textHash, score, confidence, detector)`. `score` is 0–100, or `255` (`NO_SCORE`) for a signals-only scan; `confidence` is 0 Low · 1 Medium · 2 High. Anyone can paste the same text on Verify: `certificatesForHash(hash)` finds every certificate for it. Links look like `/#/cert/12`.
- **Writer's proof:** `createPiece(title)` then `stampDraft(pieceId, textHash, words)` (author only) builds a timestamped trail. If a scan certificate exists for the latest draft's hash, the piece shows it as attached — no extra storage needed. Links look like `/#/piece/3`.
- **Reads:** `getCertificate`, `certificatesForHash`, `certificatesOf`, `certificateCount`, `getPiece`, `getDrafts`, `piecesOf`, `pieceCount`, `draftCount` (the footer shows certificates + drafts live). Events: `CertificateStamped`, `PieceCreated`, `DraftStamped`.
- **The score is reported by the app.** The contract can't check the detector, so a certificate proves *what text was scanned and when*, not that the score is true. Piece titles are public, so the app suggests keeping them general.

## Tests

```bash
npm --prefix tools install
node tools/compile.mjs
node tools/test-contract.mjs   # every rule in the contract, on an in-memory chain
node tools/test-signals.mjs    # fingerprint, sentence splitting, score alignment, signals, the three sample reports
node tools/check-frontend.mjs  # app.js ABI matches the contract; the site's calls work; 9 sections + footer links
cd worker && node test/worker.test.mjs   # both routes, CORS, rate limit, blocked hosts and redirects, detector stubbed
```

## Credits

Logo, illustrations and example essays are made for this project. pdf.js and mammoth.js are loaded from cdnjs only when a PDF or .docx is opened.
