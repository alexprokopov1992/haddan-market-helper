# Changelog

## 0.6.46

- Added a content-side watchdog around the CAPTCHA decode message so a broken MV3 message channel cannot leave the UI forever at `отправляю изображение в API`.
- Automatic CAPTCHA decoding now retries transient API/network/message-channel failures up to 3 times with backoff while the same challenge is still visible.
- CAPTCHA solving is no longer tied only to the first detection scan; a reload with a persisted `pauseReason=captcha` can resume the decode flow without requiring a full extension restart.
- Non-transient errors and exhausted retries stop cleanly with an explicit error instead of an indefinite in-flight state.

## 0.6.45

- Fixed the reward `Спасибо.` loop caused by using a delayed stale DOM node: Haddan can refresh/replace the `qa.php` contents before the generic delayed click fires.
- Reward acknowledgement now re-finds the live native `Спасибо.` link immediately before clicking it.
- Split `rewardAckScheduledAt` from `rewardAckStartedAt`; an ACK is no longer treated as executed merely because it was queued.
- Removed the unsafe idle-Poliana acknowledgement heuristic that could clear `pendingReward` while `Спасибо.` was still visibly open.
- Cooldown completion is now tied to the frame/document that actually attempted the reward ACK; manual ACK recovery requires a new cooldown document after the matching XP capture.
- Added a one-time ACK-state migration so upgrading while stuck on an open `Спасибо.` can recover without discarding the already captured XP.

## 0.6.44

- Fixed a reward transaction race where the top Poliana frame could treat an idle page as proof that `Спасибо.` had already been acknowledged.
- `pendingReward` is no longer cleared from an idle top frame unless a real reward ACK was first scheduled (`rewardAckStartedAt`).
- A captured reward is no longer blindly unlocked after 30 seconds while the native `Спасибо.` page is still open; the verified reward frame keeps retrying instead.
- Prevents the state `Иду к Фее` from appearing while an unacknowledged reward `Спасибо.` is still visible.

## 0.6.43

- Fixed a Fairy reward ACK deadlock when Haddan renders the final `Спасибо.` in a fresh `qa.php` document whose frame identity differs from the resource-choice frame.
- After the exact reward/XP has already been captured, a fresh post-choice `qa.php?id=9000` acknowledgement is accepted even if the frame key changed; stale documents created before the choice are still rejected.
- Unrelated Haddan frames no longer overwrite the global status with `Фея: опыт сохранен · жду «Спасибо» в окне награды`.

## 0.6.42

- Fixed Fairy reward ACK recovery for Cyrillic resource names by replacing a JavaScript `\b` word boundary with a Cyrillic-safe boundary.

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
