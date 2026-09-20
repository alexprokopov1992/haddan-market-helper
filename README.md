# Haddan Market Helper

Chrome MV3 extension for Haddan market scanning and Poliana/Fairy helper automation.

## What it does

- Shows an in-page market panel on `haddan.ru`.
- Scans configured herb/resource buy prices and ignores `coin-copper` shops.
- Caches market data in `chrome.storage.local`.
- Annotates Fairy resource choices with value and learned profession XP hints.
- Runs a conservative Poliana automation loop:
  - opens Fairy;
  - waits through cooldowns;
  - starts the next collection through Haddan's native flow;
  - does not automate the battle itself;
  - selects a resource by profit or learned XP;
  - records the Fairy reward XP before acknowledging `Спасибо.`.
- Pauses all automation while CAPTCHA is visible.
- Optionally solves CAPTCHA through `https://runes.spravahub.com.ua/decode` when enabled and an API token is configured.

## Project layout

- `manifest.json` - MV3 permissions, content scripts, service worker.
- `background.js` - service worker, CAPTCHA API proxy, offscreen audio, main-world click bridge.
- `offscreen.html`, `offscreen.js` - CAPTCHA alert sound.
- `popup/` - browser action popup.
- `content/shared.js` - shared constants and pure helpers used by content scripts and tests.
- `content/runtime.js` - shared runtime storage contract and normalization helpers.
- `content/content.js` - top-frame market panel and settings UI.
- `content/fairy.js` - Fairy offer parsing, annotations, resource choice, reward XP capture.
- `content/automation.js` - Poliana/Fairy/CAPTCHA runtime state machine.
- `test/` - Node tests for shared pure logic.
- `scripts/` - syntax check and extension packaging helpers.

## Development

This project has no external npm dependencies.

```powershell
npm run check
npm test
npm run verify
```

If `node`/`npm` are not on PATH, run the same scripts with the bundled Codex Node executable or install Node.js locally.

To package a release zip:

```powershell
npm run zip
```

## Manual install

1. Open Chrome extensions: `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this project folder.
5. Open or reload a Haddan tab.

## CAPTCHA and token handling

Automatic CAPTCHA solving is opt-in. The token is stored in `chrome.storage.local` as `captchaApiToken` inside `hmh_automation_v1`.

Important boundaries:

- The token is sent only from `background.js` to `https://runes.spravahub.com.ua/decode`.
- The extension avoids logging the token or Authorization header.
- Debug CAPTCHA response logs are disabled by default behind local `DEBUG_LOGS` flags.
- `chrome.storage.local` is not encrypted storage; do not reuse a sensitive token outside this extension.

## Release process

Use [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) before publishing a zip. New release notes go to [CHANGELOG.md](CHANGELOG.md). The module layout is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Current version

`0.6.48` recovers automatically from Haddan's intermittent NPC dialogue-initialization error by returning to the Poliana, clearing stale transient locks, and retrying after a short backoff.


### Experimental universal Жнец XP model

Stored XP samples also include `universalExpectedExp`, calculated in parallel as:

`quantity * (resourceTier + 6 - rankIndex) / (rankIndex + 1)`

The value is capped to `1..10` and kept fractional. Version 0.6.66 keeps two universal hypotheses in parallel:

- `expectedExp`: resource-index model `Q * (resourceIndex + 6 - rankIndex) / (rankIndex + 1)`
- `universalExpectedExp`: resource-tier model `Q * (resourceTier + 6 - rankIndex) / (rankIndex + 1)`

Both are evaluated for every known Жнец rank so accumulated samples can decide which resource progression model better matches the server.

Each stored sample also includes stochastic-rounding diagnostics derived from the universal value:

- `universalExpectedExpMin = floor(universalExpectedExp)`
- `universalExpectedExpMax = ceil(universalExpectedExp)`
- `chanseUp = universalExpectedExp - floor(universalExpectedExp)` (0 for an integer/capped value)

The `chanseUp` field intentionally follows the storage key requested for the experiment. It represents the current hypothesis that the server rounds up with probability equal to the fractional part.
