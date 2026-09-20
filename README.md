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

`0.6.43` fixes the post-reward `Спасибо.` deadlock when Haddan moves the acknowledgement into a fresh `qa.php` document/frame after XP has already been saved.
