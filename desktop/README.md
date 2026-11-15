# Axofy Code Review — Windows desktop app

**Axofy Code Review as a real Windows program.** Same review engine as the
web app (`../server.js`, zero dependencies): it starts the local server on
your computer, opens it in a window, and reviews PRs on your machine.
Free forever — $0, no seat billing, no account, no card.

## What it is

- **Electron app** (`main.js` + `preload.js`): window 1280×800, Marco icon,
  menu File / View / Help, Settings panel for your LLM keys.
- **Local server, in-process child:** the Electron binary is relaunched as
  Node (`ELECTRON_RUN_AS_NODE=1`) to run `../server.js` on a free
  `127.0.0.1` port. The server is never exposed to your network.
- **Your keys stay yours:** Settings are stored in the app's user-data
  folder (`settings.json`, mode 0600). Keys are never logged, never put in
  code, never uploaded. The settings screen shows only "✓ key saved".
- **Offline-first:** with no key at all, mock mode still works —
  deterministic checks, Triage, Deep Scan, Autofix. LLM features honestly
  say `needs-llm` instead of faking output.
- **Updates are manual, never silent:** Help → Check for Updates reads
  GitHub Releases and shows a link if a newer version exists. Nothing is
  downloaded or installed automatically.

## Run it (development)

```bash
cd axoreview/desktop
npm install
npm start          # opens the app window
npm test           # smoke test (no window): settings store, version compare,
                   # real server child → /health → / → review-diff fixture
```

## Build the Windows installer

### On Windows (recommended — produces the real .exe)

```bash
cd axoreview/desktop
npm install
npm run dist:win   # dist/Axofy-Code-Review-Setup-1.0.0.exe (NSIS) +
                   # dist/Axofy-Code-Review-Portable-1.0.0.exe
```

### Via GitHub Actions (how the .exe gets into GitHub Releases)

This Linux dev VM **cannot** build the NSIS installer — `makensis` runs
under Wine, and Wine is not installed here (`spawn wine ENOENT`).
The build was attempted on this host on 2026-11-15: electron-builder packed
the full Windows app, then failed at the NSIS step. The 244 KB
`Axofy-Code-Review-Setup-1.0.0.exe` it left behind was an **incomplete
stub without the app payload** and was deleted, not shipped.

What this host DID produce (verified real, not faked):

- `dist/Axofy-Code-Review-Windows-1.0.0.zip` (112 MB) — the genuine
  unpacked Windows build: unzip on Windows and run
  `Axofy Code Review/Axofy Code Review.exe`. No install step needed.
  Contents verified: the real x64 Electron exe, `resources/app.asar`
  (main/preload/launcher/settings), `resources/axoreview/server.js` +
  `lib/` + `public/` + `fixtures/`.
- `dist/SHA256SUMS.txt` — SHA-256 of the zip.

The real NSIS installer + portable exe are built by GitHub Actions on
`windows-latest`:

1. Copy `desktop/.github/workflows/build-windows.yml` to the repo root as
   `.github/workflows/build-windows.yml` when the repo is created/pushed.
2. Push a tag, e.g. `git tag v1.0.0 && git push origin v1.0.0` (or run the
   workflow manually from the Actions tab — that builds without releasing).
3. The workflow runs `npm test` in `axoreview/`, builds both exes, writes
   `SHA256SUMS.txt`, uploads them as artifacts, and — on a `v*` tag only —
   publishes them in **GitHub Releases** for that tag.

Release contents for `v1.0.0` (built by GitHub Actions on Windows):

| File | What it is |
|---|---|
| `Axofy-Code-Review-Setup-1.0.0.exe` | NSIS installer — install to Program Files, Start Menu + Desktop shortcuts |
| `Axofy-Code-Review-Portable-1.0.0.exe` | Portable — run without installing |
| `Axofy-Code-Review-Windows-1.0.0.zip` | Unpacked build (also built on this host — see above) |
| `SHA256SUMS.txt` | SHA-256 checksums for all files |

## Headless test note

On a Linux container the Electron window needs a virtual display and no
sandbox: `xvfb-run -a env ELECTRON_DISABLE_SANDBOX=1 npx electron .
--smoke-test --no-sandbox` → prints `SMOKE_OK` when the server is up and
the window loaded it. This is a container limitation, not an app bug —
on real Windows the app runs sandboxed normally.

## Code signing — honest note

The installer is **not code-signed** (signing needs a paid certificate,
roughly $100+/year). Windows SmartScreen will warn on first install:
"Windows protected your PC" → click **More info → Run anyway**.
The release notes say this. Do not bypass SmartScreen claims, and do not
present the installer as signed.

## Files

| File | What it does |
|---|---|
| `main.js` | Electron main process: window, menu, server child, IPC, update check |
| `preload.js` | contextBridge only — the web UI never gets Node access |
| `server-launcher.js` | Pick a free port, spawn the server, wait for `/health` |
| `settings-store.js` | Load/save settings + keys (0600 file, values never logged) |
| `update-check.js` | GitHub Releases latest-version check + semver compare |
| `settings.html` | Settings screen (provider + 4 free keys + repo for updates) |
| `electron-builder.yml` | NSIS + portable Windows targets, Marco icon |
| `.github/workflows/build-windows.yml` | Windows CI build + GitHub Release publisher |
| `scripts/smoke-test.js` | Headless smoke test (settings, versions, real server child) |
| `assets/marco.png` / `assets/icon.ico` | Marco logo + multi-size Windows icon |

## What is NOT built here

- The NSIS Setup `.exe` and portable `.exe` — built only by the Windows
  GitHub Actions job (see above). This host produced the unpacked Windows
  build + zip instead, after the NSIS step failed on missing Wine.
  The incomplete 244 KB installer stub the failed build left behind was
  deleted, not shipped.
- Mac/Linux installers — the Electron code is cross-platform, but only the
  Windows target is configured and only Windows is tested.
- Auto-update install — deliberately not implemented; updates are
  check-and-download only.

## Verification (2026-11-15, this host)

- `node --check` on main/preload/launcher/store/update-check/smoke-test: OK
- Desktop smoke test (`npm test` in `desktop/`): **14 passed, 0 failed**
  (settings round-trip, keys never leak into the public view, version
  compare, real server child → `/health` → `/` → review-diff finds the
  planted SQL injection + eval, clean shutdown)
- Real Electron run under Xvfb (`--smoke-test`): **SMOKE_OK** —
  server up on `127.0.0.1:3000`, window loaded it, `llm=vault`
- Web-app suite (`npm test` in `axoreview/`): **63 passed, 0 failed**
- Windows pack (`electron-builder --win`): app packed, failed at NSIS
  on `spawn wine ENOENT` (Wine not installed); unpacked build + zip
  verified real as above
