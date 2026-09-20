# Architecture

Haddan Market Helper is a Chrome MV3 extension without a bundler. Content scripts are loaded by `manifest.json` in a deterministic order and share small namespaces on `window`.

## Current script layers

1. `content/shared.js`
   - Shared constants.
   - Pure helpers for settings, market normalization, XP prediction, CAPTCHA rune mapping.
   - Exported as `window.HMH_SHARED` and `module.exports` for Node tests.

2. `content/runtime.js`
   - Runtime storage contract for `hmh_bot_runtime_v1`.
   - Default runtime state, normalizer, and safe reset patches.
   - Exported as `window.HMH_RUNTIME` and `module.exports` for Node tests.

3. `content/content.js`
   - Top-frame UI panel.
   - Market DOM parsing and rendering.
   - User settings.

4. `content/fairy.js`
   - Fairy offer detection and annotations.
   - Resource selection.
   - Reward XP capture.

5. `content/automation.js`
   - Main Poliana/Fairy/CAPTCHA state machine.
   - Cross-frame locks.
   - Native clicks and recovery guards.

## Refactor rules

- Keep shared modules dependency-light and testable in Node.
- Do not move browser DOM/FSM code until the surrounding behavior has tests or a manual Haddan reproduction case.
- New persistent storage keys must be added to one shared contract first.
- New runtime fields must be added to `content/runtime.js` and covered by `test/runtime.test.js`.
- Content script order in `manifest.json` is part of the API. Shared modules must be listed before scripts that use them.
- Recovery paths should be conservative: only release locks after a positive signal or after a bounded timeout once user-visible data has already been saved.

## Target shape

The next safe split for `content/automation.js` is:

- `content/automation/captcha.js` - CAPTCHA detection, status publishing, API application helpers.
- `content/automation/actions.js` - action discovery, signatures, click throttling, main-world click bridge.
- `content/automation/reward.js` - reward document state, ACK recovery, transaction clearing.
- `content/automation/battle.js` - battle/result detection and locks.
- `content/automation/fsm.js` - orchestration only.

Until then, `automation.js` should shrink by extracting pure contracts first, then DOM helpers, and only then state transitions.
