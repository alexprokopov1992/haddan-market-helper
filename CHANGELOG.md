## 0.6.64

- Added stochastic-rounding diagnostics to every Жнец XP sample: `universalExpectedExpMin`, `universalExpectedExpMax`, and `chanseUp`.
- `chanseUp` is the fractional part of `universalExpectedExp` after the 1..10 cap; it represents the working hypothesis `P(round up) = fractional part`.
- Historical samples are backfilled automatically on startup. Integer/capped universal expectations get `Min = Max` and `chanseUp = 0`.

## 0.6.63

- Added `universalExpectedExp` to every Жнец XP sample while keeping the existing rank-specific `expectedExp` unchanged.
- Universal candidate formula: `quantity * (resourceTier + 6 - rankIndex) / (rankIndex + 1)`, capped to `1..10` and stored as a fractional value.
- Existing stored samples are backfilled/recalculated automatically on startup so both model outputs can be compared against actual `exp` without clearing the dataset.

## 0.6.62

- Split the experimental `expectedExp` model by confirmed Жнец rank instead of forcing one universal formula.
- `Опытный Травник` now uses the raw `RESOURCES` index: `quantity * (resourceIndex + 2) / 5`.
- `Опытный Гербологист` keeps the progression-tier model: `quantity * (resourceTier + 1) / 6`.
- Other ranks now receive `expectedExp: null` until their formulas are supported by enough observations.
- Existing stored samples are automatically recalculated on startup, so 0.6.61 values are corrected without clearing the dataset.

## 0.6.61

- Added experimental formula output `expectedExp` to every stored Жнец XP sample.
- Existing stored samples are backfilled automatically on extension startup; low-rank samples (`Новичок`, `Косарь`, `Травник`) receive `expectedExp: null` while their separate rule remains unknown.
- The current model uses resource progression tiers rather than raw resource-array indexes, so `Мандрагора` and `Зеленая Массивка` share the same tier.
- `expectedExp` keeps a fractional expected value (capped to 1..10) so actual integer rewards can be compared against the model while reconstructing server-side rounding/randomness.

## 0.6.60

- START now always begins a clean runtime session and clears inherited Fairy cooldowns, battle timers, reward/ACK locks, choice locks, CAPTCHA pause timestamps and other transient state.
- Switching Haddan characters no longer carries the previous character's Fairy wait timer into the new START session.
- STOP keeps the same full transient-state reset semantics.

## 0.6.59

- Added a 60-second continuous-battle watchdog. If the real Haddan battle interface remains active for more than one minute, the extension reloads the entire Haddan tab rather than only an iframe.
- Battle start time is persisted across frames; normal result/return states clear it.
- Full-tab reload requests are deduplicated in the service worker so several Haddan frames cannot create a reload storm.
- After a timeout reload the battle watchdog starts a fresh 60-second window; if Haddan is still genuinely stuck, another reload may occur only after that full minute.

## 0.6.58

- Low-rank reward parser now accepts both `1 опыт Жнеца` and plural `N опыта Жнеца`.
- A live standalone `Спасибо.` is now a terminal action by itself: it is auto-closed even if `pendingReward` or the XP sample was lost.
- Added a short cross-frame acknowledgement lock so idle frames cannot overwrite the state with `Иду к Фее` while `Спасибо.` is being closed.
- The 90-second generic reward watchdog no longer clears a transaction while an exact native `Спасибо.` is still visible; the dedicated 30-second ACK fallback owns that state.

## 0.6.57

- Added a 5-second pre-click watchdog for Fairy resource choices.
- If the best resource was calculated and shown in the UI but the delayed native click was abandoned before `pendingReward` could be armed, the exact live choice document is rescanned and retried instead of remaining open indefinitely.
- The existing 15-second post-click watchdog remains responsible for cases where `pendingReward` was armed but Haddan did not navigate to the reward page.

# Changelog

## 0.6.56

- Fixed Fairy resource selection for low Жнец ranks where Haddan can offer only one resource (for example `Новичок` -> one `Мухожор` choice).
- The Fairy parser no longer requires two offers/two resource links unconditionally.
- A one-resource offer is accepted only in the real `/room/func/qa.php` choice document, preserving protection against mirrored/stale Fairy text in the room chat/history frame.
- Single-resource dialogs now receive the normal price/XP annotation and automatic selection.

## 0.6.55

- Replaced the manual Жнец rank selector with an automatic session profile.
- START now reads `/info/info.php` once, captures current Жнец rank and total professional XP, and calculates the next rank threshold locally.
- During the running session every exact Fairy XP reward advances the cached total XP locally; crossing a threshold immediately switches the rank used for XP prediction, with no additional profile requests.
- The panel shows current rank, total XP / next-rank XP, XP remaining, and XP gained in the current session.
- If the START profile request fails, the last cached profile can be used explicitly marked as cache; if no profile exists, START is cancelled rather than silently using a guessed rank.
- Reward-session accounting is keyed by the reward transaction so repeated scans of the same reward do not intentionally advance the session twice, while identical rewards in later cycles remain countable.

## 0.6.54
- Fixed an `id=9000` action collision in Fairy dialogs: Haddan uses the same QA id for both reward `Спасибо.` and cooldown `Хорошо, я подойду позже.`.
- QA actions with a text matcher now require BOTH the expected `qa.php?id` and the expected visible label; the helper no longer falls back to an arbitrary action sharing the same id.
- Prevents the cooldown page from being misdetected as an orphan reward acknowledgement, which caused `найдено незакрытое «Спасибо»` / `Иду к Фее` to alternate and repeatedly reopen Fairy.

## 0.6.53 - Fairy cooldown frame/status fix

- Cooldown/ready-dialog detection now requires the live `qa.php` context (or the exact actionable QA control), so old NPC lines retained in the room chat no longer masquerade as an open Fairy dialog.
- Added `fairyWaitKind` to distinguish a real parsed server cooldown from the local 60-second watchdog used when Haddan replies with an unparseable `?` timer.
- All frames now render the same status for an unknown timer instead of alternating between `время таймера не распознано` and `ждать`.
- One-time cooldown runtime migration forces a clean resync from 0.6.52 and older.

## 0.6.52

- Fixed a regression introduced by the v0.6.47 post-reward timeout: captured XP no longer causes `pendingReward` to be blindly cleared after 30 seconds while the real native `Спасибо.` page is still open.
- After 30 seconds, a verified current `Спасибо.` is actively retried instead of skipped. Unrelated frames keep the global reward transaction locked and cannot reopen Fairy.
- Added a verified reward-surface heartbeat so other Haddan frames can tell that the reward/ACK page is still alive elsewhere.
- Added a finite 2-minute fallback only for the opposite case where XP was captured but the reward surface has genuinely disappeared; captured XP evidence is preserved.
- Added orphan-`Спасибо.` recovery for upgrades from affected versions: if `pendingReward` was already lost but a recent captured reward exists and the real `qa.php?id=9000` acknowledgement is still visible, the extension closes it automatically instead of staying at `Иду к Фее`.

## 0.6.51

- Added a 15-second watchdog for a lost Fairy resource-choice navigation.
- If `pendingReward` was armed but the exact originating `Выбери себе` document is still visible after 15 seconds and no reward was captured, only the stale reward transaction lock is cleared and the same choice is retried.
- The watchdog is bound to both the original frame key and document start time, so an old choice frame cannot cancel a legitimate reward page in another/new document.

## 0.6.50

- Added watchdogs for the remaining automation states that could wait indefinitely without a server transition.
- A stale `battleActive` lock is now released when no real battle surface refreshes its deadline for 60 seconds.
- The exact `Продолжить бой` recovery page no longer stops forever after two ignored clicks; the bounded retry cycle is restarted after 15 seconds.
- A Fairy reward transaction that produces neither an XP line nor a valid `Спасибо.` is reset after 90 seconds so a lost resource click cannot lock the whole cycle.
- An unparseable Fairy cooldown timer is rechecked after one minute and the stale dialogue is released instead of waiting forever.
- A CAPTCHA that was submitted but remains visible is retried up to the existing 3-attempt limit; after that the UI explicitly switches to manual recovery instead of staying forever at `жду переход страницы`.
- Generic delayed auto-clicks now have a trailing rescan watchdog, including throttled-click recovery, so an ignored native click cannot become the last FSM scan.
- Market/profile HTTP requests now have finite timeouts so `Обновить цены` cannot remain permanently in `Сканирование…` on a stalled request.

## 0.6.49

- Added a 30-second fallback for a current Fairy reward dialog that shows the exact native `Спасибо.` link but never exposes the learnable resource + quantity + XP line.
- After the timeout the extension clicks `Спасибо.` and continues the cycle instead of waiting forever.
- That one reward is intentionally not added to the Жнец XP learning table because its exact XP was never observed.
- The timeout starts when the valid `Спасибо.` link is first seen in the current reward document, not merely when the resource was selected.

## 0.6.48

- Added recovery for Haddan's exact `Ошибка инициализации диалога! ... попытайтесь начать диалог ещё раз` page.
- The extension now clicks the exact `Вернуться` link to `/room/room.php`, releases stale battle/Fairy transaction locks, waits 3 seconds, and retries the Fairy flow.
- Already captured reward/XP evidence is preserved if this error appears during a reward transaction.

## 0.6.47

- Added a 30-second post-reward failsafe: after the exact Fairy XP reward has already been saved, a stalled `Спасибо.` completion no longer locks the automation indefinitely.
- The failsafe clears only the pending reward/ACK transaction state; the captured XP evidence is preserved and the next scan continues the Fairy cycle.

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
