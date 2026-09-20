# Changelog

## 0.6.41

- Made reward ACK recovery detect the real chat echo format: `player -> *Фея Поляныnpc* Спасибо.`.
- Binds that recovery to the current saved reward quantity/resource, avoiding stale `Спасибо` messages from older cycles.

## 0.6.40

- Restored proper UTF-8 Russian text and regex literals in `content/automation.js`.
- Fixes mojibake statuses such as `Р‘РѕС‚ Р°РєС‚РёРІРµРЅ...` and restores Fairy/battle text detection.

## 0.6.39

- Added recovery when XP is already saved but Haddan closes the reward window before the extension observes `Спасибо.`.
- Added a 30-second timeout for the saved-XP reward acknowledgement wait, so the Poliana cycle cannot stay locked forever.
- Split the runtime storage contract into `content/runtime.js` and documented the no-bundler content-script architecture.

## 0.6.38

- Fixed the Fairy reward acknowledgement deadlock after XP capture.
- Added a watchdog for stalled `Спасибо.` acknowledgement transitions.
- Split status messages around reward capture, acknowledgement, and post-ack navigation.

## Maintenance notes

Older release notes are preserved in `README.md` from the pre-cleanup project history. New entries should be added here first, then summarized in the README only when they affect installation or usage.
