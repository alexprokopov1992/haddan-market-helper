(() => {
  'use strict';

  if (window.__HMH_BATTLE_AUTOMATION__) return;
  window.__HMH_BATTLE_AUTOMATION__ = true;

  const {
    STORAGE_KEYS,
    DEFAULT_AUTOMATION,
    normalizeAutomation,
    mapApiRunesToSiteRunes
  } = window.HMH_SHARED;
  const AUTOMATION_KEY = STORAGE_KEYS.automation;
  const BOT_STATUS_KEY = STORAGE_KEYS.botStatus;
  const BOT_RUNTIME_KEY = STORAGE_KEYS.botRuntime;
  const REAPER_PROFILE_KEY = STORAGE_KEYS.reaperProfile;

  const {
    DEFAULT_RUNTIME,
    normalizeRuntime,
    clearRewardRuntimePatch
  } = window.HMH_RUNTIME;
  let settings = { ...DEFAULT_AUTOMATION };
  let runtime = { ...DEFAULT_RUNTIME };
  let mutationVersion = 0;
  let lastClickAt = 0;
  let lastClickMutation = -1;
  let lastClickKey = '';
  let scanTimer = null;
  let lastStatusText = '';
  let lastOrphanThanksClickAt = 0;
  const DOCUMENT_STARTED_AT = Date.now();
  let captchaSolveInFlight = false;
  let lastCaptchaDecode = null;
  let captchaAttemptCount = 0;
  let captchaRetryAt = 0;
  let captchaAttemptFingerprint = '';
  let captchaSubmitExhausted = false;
  const CAPTCHA_DECODE_MESSAGE_TIMEOUT_MS = 18000;
  const CAPTCHA_MAX_AUTO_ATTEMPTS = 3;
  const CAPTCHA_RETRY_DELAYS_MS = [1500, 3500, 7000];
  const REWARD_ACK_FAILSAFE_MS = 30000;
  const REWARD_CAPTURE_ORPHAN_FAILSAFE_MS = 120000;
  const ORPHAN_THANKS_RECOVERY_WINDOW_MS = 300000;
  const REWARD_SURFACE_HEARTBEAT_MS = 5000;
  const REWARD_MISSING_LINE_THANKS_FAILSAFE_MS = 30000;
  const REWARD_TRANSACTION_FAILSAFE_MS = 90000;
  const RESOURCE_CHOICE_STALL_FAILSAFE_MS = 15000;
  const CAPTCHA_SUBMIT_STALL_MS = 12000;
  const UNKNOWN_COOLDOWN_RECHECK_MS = 60000;
  const CONTINUE_BATTLE_RECOVERY_RETRY_MS = 15000;
  const CLICK_WATCHDOG_MS = 1200;
  const DEBUG_LOGS = false;

  function debugLog(...args) {
    if (DEBUG_LOGS) console.log(...args);
  }

  function normalize(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function bodyText() {
    return normalize(document.body?.innerText || document.body?.textContent || '');
  }

  function frameContextKey() {
    try {
      if (window.top === window) return 'top';
      const frame = window.frameElement;
      if (!frame) return `frame:unknown:${location.pathname}`;
      const owner = frame.ownerDocument;
      const frames = [...owner.querySelectorAll('iframe,frame')];
      const index = frames.indexOf(frame);
      return `frame:${frame.tagName.toLowerCase()}:${frame.id || ''}:${frame.getAttribute('name') || ''}:${index}`;
    } catch (_) {
      return `frame:opaque:${location.pathname}`;
    }
  }

  function captchaVisible() {
    // captcha.js supplied by Haddan uses #cap_symbols, #wutface and .captcha_rune.
    // We intentionally detect the challenge UI only; the extension never tries to
    // read or solve the rune sequence.
    return Boolean(
      document.querySelector('#cap_symbols') ||
      document.querySelector('#wutface') ||
      document.querySelector('.captcha_rune')
    );
  }

  async function playLocalCaptchaBeep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      const ctx = new Ctx();
      if (ctx.state === 'suspended') await ctx.resume();
      const start = ctx.currentTime + 0.02;
      [880, 1175, 880].forEach((frequency, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t0 = start + index * 0.24;
        const t1 = t0 + 0.16;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(frequency, t0);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.14, t0 + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t1);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t1 + 0.02);
      });
      setTimeout(() => ctx.close().catch(() => {}), 1300);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function requestCaptchaAlertSound() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'HMH_CAPTCHA_ALERT' });
      // ok=true also covers tab-level deduplication when another frame already
      // triggered the same alert. Do not play a second local beep in that case.
      if (result?.ok) return;
    } catch (_) {}
    await playLocalCaptchaBeep();
  }

  function hashString(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  async function waitForImageReady(img, timeoutMs = 5000) {
    if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) return true;

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
        error ? reject(error) : resolve();
      };
      const onLoad = () => finish();
      const onError = () => finish(new Error('captcha-image-load-failed'));
      const timer = setTimeout(() => finish(new Error('captcha-image-load-timeout')), timeoutMs);
      img.addEventListener('load', onLoad, { once: true });
      img.addEventListener('error', onError, { once: true });
    });
    return true;
  }

  async function captureCaptchaImageDataUrl() {
    const img = document.querySelector('img[src*="/inner/img/bc.php"]');
    if (!img) throw new Error('captcha-image-not-found');

    await waitForImageReady(img);

    const width = Number(img.naturalWidth || img.width || 0);
    const height = Number(img.naturalHeight || img.height || 0);
    if (!width || !height) throw new Error('captcha-image-empty');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('captcha-canvas-unavailable');

    // PNG Haddan має прозорий фон.
    // Перед drawImage робимо його білим,
    // щоб API/OpenCV отримав чорні руни на білому фоні.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.drawImage(img, 0, 0, width, height);

    return canvas.toDataURL('image/png');
  }

  async function requestCaptchaDecode(imageDataUrl, token) {
    let timer = null;
    const messagePromise = chrome.runtime.sendMessage({
      type: 'HMH_CAPTCHA_DECODE',
      imageDataUrl,
      token
    });
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('captcha-message-timeout')), CAPTCHA_DECODE_MESSAGE_TIMEOUT_MS);
    });

    try {
      const response = await Promise.race([messagePromise, timeoutPromise]);
      debugLog('[Haddan Market Helper] CAPTCHA API response received by content script:', response);

      if (!response?.ok) throw new Error(String(response?.error || 'captcha-api-failed'));
      if (!Array.isArray(response.runes) || response.runes.length === 0) throw new Error('captcha-api-empty-runes');
      return response.runes;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function isRetryableCaptchaError(reason) {
    const value = String(reason || '').toLowerCase();
    return value === 'api-timeout' ||
      value === 'captcha-message-timeout' ||
      /failed to fetch|networkerror|network error|load failed|message port closed|receiving end does not exist/.test(value) ||
      /^http-(408|425|429|500|502|503|504)$/.test(value);
  }

  function resetCaptchaRequestState() {
    captchaSolveInFlight = false;
    captchaAttemptCount = 0;
    captchaRetryAt = 0;
    captchaAttemptFingerprint = '';
    captchaSubmitExhausted = false;
  }

function waitForCondition(check, timeoutMs = 2000, intervalMs = 50) {
  return new Promise((resolve) => {
    const started = Date.now();

    const timer = setInterval(() => {
      try {
        if (check()) {
          clearInterval(timer);
          resolve(true);
          return;
        }
      } catch (e) {
        clearInterval(timer);
        resolve(false);
        return;
      }

      if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}

async function applyOneRune(rune, stateInput) {
  if (!rune) {
    console.error('Rune not found');
    return false;
  }

  const before = stateInput.value;
  rune.click();

  const changed = await waitForCondition(
    () => stateInput.value !== before,
    2000
  );

  if (!changed) {
    console.error('Rune interaction timeout');
    return false;
  }

  debugLog('State changed:', before, '->', stateInput.value);
  return true;
}

async function applyRunes(runes) {
  const stateInput = document.querySelector('#cap_symbols');
  if (!stateInput) return false;

  const total = runes.length;
  for (let index = 0; index < total; index += 1) {
    const current = index + 1;
    const progress = 60 + Math.round((current / Math.max(1, total)) * 24);
    await setCaptchaStatus(
      'input',
      `CAPTCHA: ввожу руну ${current} из ${total}…`,
      { progress, current, total, runeCount: total }
    );

    const ok = await applyOneRune(runes[index], stateInput);
    if (!ok) return false;
  }

  await setCaptchaStatus(
    'verifying',
    `CAPTCHA: все ${total} рун(ы) введены, проверяю ответ…`,
    { progress: 88, current: total, total, runeCount: total }
  );
  return true;
}

function submitBattleForm() {
  const form = document.querySelector('form[name="frmExchange"]');
  if (!form) {
    console.error('Form not found');
    return false;
  }

  const submitButton = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
  if (!submitButton) {
    console.error('Submit button not found');
    return false;
  }

  debugLog('submitButton:', submitButton);
  debugLog('text:', submitButton?.textContent.trim());
  debugLog('type:', submitButton?.type);

  form.requestSubmit(submitButton);
  return true;
}

const delay = ms => new Promise(res => setTimeout(res, ms));

async function applyCaptchaResultToCurrentPage(siteRunes) {
  debugLog('siteRunes:', siteRunes);

  const runes = [];
  for (const value of siteRunes) {
    const rune = document.querySelector(`.captcha_rune[value="${value}"]`);
    debugLog(value, rune);
    if (!rune) {
      console.error('Rune element missing:', value);
      return false;
    }
    runes.push(rune);
  }

  await setCaptchaStatus(
    'decoded',
    `CAPTCHA: распознано ${runes.length} рун(ы), начинаю ввод…`,
    { progress: 58, total: runes.length, runeCount: runes.length }
  );
  await delay(800);

  const ok = await applyRunes(runes);
  debugLog('applyRunes result:', ok);
  if (!ok) return false;

  await setCaptchaStatus(
    'submitting',
    'CAPTCHA: ответ сформирован, отправляю «В бой»…',
    { progress: 94, current: runes.length, total: runes.length, runeCount: runes.length }
  );
  await delay(800);

  const formResult = submitBattleForm();
  if (!formResult) return false;

  return true;
}

  async function captchaIntegrationHook() {
    if (!settings.solveCaptcha) return { ok: false, stage: 'disabled' };

    const token = String(settings.captchaApiToken || '').trim();
    if (!token) return { ok: false, stage: 'missing-token' };
    if (captchaSolveInFlight) return { ok: false, stage: 'in-flight' };
    if (!captchaVisible()) return { ok: false, stage: 'not-visible' };

    captchaSolveInFlight = true;
    try {
      await setCaptchaStatus('preparing', 'CAPTCHA: подготавливаю изображение…', { progress: 12 });
      const beforeImage = await captureCaptchaImageDataUrl();
      const challengeFingerprint = hashString(beforeImage);

      if (captchaAttemptFingerprint !== challengeFingerprint) {
        captchaAttemptFingerprint = challengeFingerprint;
        captchaAttemptCount = 0;
        captchaRetryAt = 0;
      }
      captchaAttemptCount += 1;
      const attemptNumber = captchaAttemptCount;

      await setCaptchaStatus(
        'api',
        `CAPTCHA: отправляю изображение в API · попытка ${attemptNumber}/${CAPTCHA_MAX_AUTO_ATTEMPTS}…`,
        { progress: 30, detail: `Запрос к API, попытка ${attemptNumber} из ${CAPTCHA_MAX_AUTO_ATTEMPTS}` }
      );
      const apiRunes = await requestCaptchaDecode(beforeImage, token);
      debugLog('[Haddan Market Helper] CAPTCHA API runes:', apiRunes);

      const siteRunes = mapApiRunesToSiteRunes(apiRunes);
      debugLog('[Haddan Market Helper] CAPTCHA mapped siteRunes:', siteRunes);
      await setCaptchaStatus(
        'decoded',
        `CAPTCHA: API распознал ${siteRunes.length} рун(ы)`,
        { progress: 50, total: siteRunes.length, runeCount: siteRunes.length }
      );

      await setCaptchaStatus(
        'verifying',
        'CAPTCHA: проверяю, что изображение не изменилось…',
        { progress: 54, total: siteRunes.length, runeCount: siteRunes.length }
      );

      // A network response must never be applied to a replacement challenge.
      if (!captchaVisible()) return { ok: false, stage: 'challenge-gone' };
      const afterImage = await captureCaptchaImageDataUrl();
      if (hashString(afterImage) !== challengeFingerprint) {
        return { ok: false, stage: 'challenge-changed' };
      }

      lastCaptchaDecode = {
        fingerprint: challengeFingerprint,
        decodedAt: Date.now(),
        runeCount: siteRunes.length,
        applied: false
      };

      const applied = await applyCaptchaResultToCurrentPage(siteRunes);
      if (!applied) {
        lastCaptchaDecode.applied = false;
        return { ok: false, stage: 'apply-failed', runeCount: siteRunes.length };
      }

      lastCaptchaDecode.applied = true;
      lastCaptchaDecode.submittedAt = Date.now();
      await setCaptchaStatus(
        'waiting',
        'CAPTCHA: ответ отправлен, жду переход страницы…',
        { progress: 97, current: siteRunes.length, total: siteRunes.length, runeCount: siteRunes.length }
      );
      return { ok: true, stage: 'applied', runeCount: siteRunes.length };
    } catch (error) {
      const reason = String(error?.message || error || 'captcha-integration-failed');
      console.warn('[Haddan Market Helper] CAPTCHA integration failed:', reason);

      const retryable = isRetryableCaptchaError(reason);
      if (retryable && captchaAttemptCount < CAPTCHA_MAX_AUTO_ATTEMPTS && captchaVisible()) {
        const retryDelay = CAPTCHA_RETRY_DELAYS_MS[Math.min(captchaAttemptCount - 1, CAPTCHA_RETRY_DELAYS_MS.length - 1)];
        captchaRetryAt = Date.now() + retryDelay;
        await setCaptchaStatus(
          'api',
          `CAPTCHA: API не ответил · повтор ${captchaAttemptCount + 1}/${CAPTCHA_MAX_AUTO_ATTEMPTS} через ${Math.ceil(retryDelay / 1000)}с`,
          {
            progress: 30,
            detail: `Ошибка ${reason}. Повторю запрос автоматически; CAPTCHA и остальная автоматика остаются на паузе.`
          }
        );
        return { ok: false, stage: 'retry', error: reason, retryAt: captchaRetryAt };
      }

      captchaRetryAt = Number.POSITIVE_INFINITY;
      const exhausted = retryable && captchaAttemptCount >= CAPTCHA_MAX_AUTO_ATTEMPTS;
      await setCaptchaStatus(
        'error',
        exhausted ? `CAPTCHA: API не ответил после ${captchaAttemptCount} попыток` : `CAPTCHA: ошибка — ${reason}`,
        {
          progress: 0,
          detail: exhausted
            ? `Последняя ошибка: ${reason}. Автоповторы остановлены для этой CAPTCHA; можно решить вручную или перезапустить цикл.`
            : `Автоматическое решение не завершено: ${reason}. Можно ввести руны вручную.`
        }
      );
      return { ok: false, stage: 'error', error: reason };
    } finally {
      captchaSolveInFlight = false;
    }
  }

  async function resetTransientBattleAfterCaptcha() {
    lastCaptchaDecode = null;
    resetCaptchaRequestState();
    await saveRuntime({
      pauseReason: '',
      captchaDetectedAt: 0,
      captchaLastSeenAt: 0,
      captchaSignalAt: 0,
      battleExpectedUntil: 0,
      battleStartRequestedAt: 0,
      battleStartRequestFrameKey: '',
      battleStartRequestDocumentStartedAt: 0,
      battleStartAttempts: 0,
      battleActive: false,
      battleRecoveryLastClickAt: 0,
      battleRecoveryAttempts: 0
    });
  }

  function elementLabel(el) {
    if (!el) return '';
    const direct = normalize(el.innerText || el.textContent || el.value || el.getAttribute?.('aria-label') || el.getAttribute?.('title'));
    if (direct) return direct.slice(0, 180);
    const img = el.querySelector?.('img');
    return normalize(img?.alt || img?.title).slice(0, 180);
  }

  function closestAction(target) {
    if (!(target instanceof Element)) return null;
    return target.closest('a[href], button, input[type="button"], input[type="submit"], [onclick], [role="button"]');
  }

  function relativeHref(el) {
    const raw = el?.getAttribute?.('href');
    if (!raw || /^javascript:/i.test(raw)) return '';
    try {
      const url = new URL(raw, location.href);
      return `${url.pathname}${url.search}`;
    } catch (_) {
      return raw.slice(0, 300);
    }
  }

  function hrefPath(el) {
    const raw = el?.getAttribute?.('href');
    if (!raw || /^javascript:/i.test(raw)) return '';
    try { return new URL(raw, location.href).pathname; }
    catch (_) { return raw.split('?')[0].slice(0, 200); }
  }

  function makeSignature(el) {
    const label = elementLabel(el);
    return {
      label,
      tag: el.tagName?.toLowerCase() || '',
      id: el.id || '',
      name: el.getAttribute?.('name') || '',
      title: normalize(el.getAttribute?.('title')),
      value: normalize(el.value),
      href: relativeHref(el),
      hrefPath: hrefPath(el),
      onclick: normalize(el.getAttribute?.('onclick')).slice(0, 400),
      framePath: location.pathname
    };
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function enabled(el) {
    return !el.disabled && el.getAttribute?.('aria-disabled') !== 'true';
  }

  function allActions() {
    return [...document.querySelectorAll('a[href], button, input[type="button"], input[type="submit"], [onclick], [role="button"]')]
      .filter((el) => !el.closest?.('#hmh-root'));
  }

  function sameLabel(el, signature) {
    const label = elementLabel(el).toLowerCase();
    return !!signature.label && label === normalize(signature.label).toLowerCase();
  }

  function findBySignature(signature) {
    if (!signature) return null;

    // framePath is informational only. Haddan changes iframe URLs while a fight is
    // resumed/advanced, although the same skill control remains available.
    if (signature.id) {
      const byId = document.getElementById(signature.id);
      if (byId && visible(byId) && enabled(byId) && (!signature.label || sameLabel(byId, signature))) return byId;
    }

    const actions = allActions().filter((el) => visible(el) && enabled(el));

    if (signature.label) {
      const exact = actions.find((el) => sameLabel(el, signature));
      if (exact) return exact;
    }

    if (signature.onclick) {
      const exactOnclick = actions.find((el) => normalize(el.getAttribute?.('onclick')) === signature.onclick);
      if (exactOnclick) return exactOnclick;
    }

    if (signature.href) {
      const exactHref = actions.find((el) => relativeHref(el) === signature.href);
      if (exactHref) return exactHref;
    }

    if (signature.hrefPath) {
      const samePath = actions.filter((el) => hrefPath(el) === signature.hrefPath);
      if (samePath.length === 1) return samePath[0];
      if (signature.label) {
        const labeled = samePath.find((el) => sameLabel(el, signature));
        if (labeled) return labeled;
      }
    }

    return null;
  }


  function isQaLink(el) {
    return /\/room\/func\/qa\.php(?:\?|$)/i.test(hrefPath(el));
  }

  function findFairyTrigger() {
    const captured = findBySignature(settings.selectedFairy);
    if (captured && !isQaLink(captured)) return captured;

    const candidates = allActions()
      .filter((el) => visible(el) && enabled(el) && !isQaLink(el))
      .filter((el) => /фея(?:\s+поляны)?/i.test(elementLabel(el)));

    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      const exact = candidates.find((el) => /^фея(?:\s+поляны)?$/i.test(elementLabel(el)));
      if (exact) return exact;
    }
    return null;
  }

  function fairyChoiceVisible(text = bodyText()) {
    return /могу\s+дать\s+тебе\s+следующие\s+травы|выбери\s+себе/i.test(text) && !!document.querySelector('a[href*="qa.php"]');
  }

  function readyDialogueVisible(text = bodyText()) {
    if (!/тебе\s+нужны\s+новые\s+травы\s*,?\s*жнец/i.test(text)) return false;

    // The same NPC sentence is copied into the room chat log. automation.js runs
    // in every Haddan frame, so matching bodyText() alone lets the long-lived room
    // frame masquerade as the live qa.php dialogue. Require either the real qa.php
    // document or its actionable «Да, мне нужны новые травы» control.
    return /\/room\/func\/qa\.php$/i.test(location.pathname) ||
      !!findQaAction(100, /да.*нужны.*новые\s+травы/i);
  }

  function professionalExpFromRewardText(text = bodyText()) {
    const normalized = normalize(text);
    const patterns = [
      /(?:ты\s+)?получа(?:ешь|ешься|л|ла|ете|ют|ется)\s*\+?(\d+)\s+опыта\s+жнеца/i,
      /\+?(\d+)\s+опыта\s+жнеца/i,
      /опыт(?:а)?\s+жнеца\s*[:+—-]?\s*(\d+)/i
    ];
    for (const re of patterns) {
      const match = normalized.match(re);
      if (match) return Number(match[1]);
    }
    return null;
  }

  function rewardConfirmationVisible(text = bodyText()) {
    return professionalExpFromRewardText(text) != null ||
      /я\s+дам\s+тебе\s+\d+\s*(?:ед\.?|шт\.?).*опыта\s+жнеца/i.test(text);
  }

  function pendingRewardObservation(text = bodyText()) {
    const normalized = normalize(text);
    const match = normalized.match(/я\s+дам\s+тебе\s+(\d+)\s*(?:ед\.?|шт\.?)\s+(.+?)\.\s*ты\s+получа(?:ешь|ете)\s*\+?(\d+)\s+опыта\s+жнеца/i);
    if (!match) return null;
    const quantity = Number(match[1]);
    const resourceName = normalize(match[2]);
    const exp = Number(match[3]);
    const expectedName = normalize(runtime.pendingRewardResource).toLowerCase();
    const expectedQty = Number(runtime.pendingRewardQuantity || 0);
    if (expectedName && resourceName.toLowerCase() !== expectedName) return null;
    if (expectedQty > 0 && quantity !== expectedQty) return null;
    if (!Number.isFinite(exp)) return null;
    return { quantity, resourceName, exp };
  }

  function thanksVisible() {
    return !!findQaAction(9000, /спасибо/i);
  }

  function rewardAckEchoVisible(text = bodyText()) {
    const src = normalize(text);
    const expectedName = normalize(runtime.pendingRewardResource);
    const expectedQty = Number(runtime.pendingRewardQuantity || 0);
    if (!expectedName || !expectedQty || !/спасибо[.!]?/i.test(src)) return false;

    const escapedName = expectedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rewardLine = new RegExp(`я\\s+дам\\s+тебе\\s+${expectedQty}\\s*(?:ед\\.?|шт\\.?)\\s+${escapedName}(?=\\s|[.,!?:;]|$)`, 'i');
    if (!rewardLine.test(src)) return false;

    const thanksToFairy = /->\s*\*?\s*Фея\s+Поляны\s*npc\s*\*?\s*спасибо[.!]?/i;
    if (thanksToFairy.test(src)) return true;

    const thanksIndex = src.search(/спасибо[.!]?/i);
    const rewardIndex = src.search(rewardLine);
    return thanksIndex >= 0 && rewardIndex >= 0 && Math.abs(thanksIndex - rewardIndex) <= 700;
  }

  function likelyIdlePolianaAfterReward() {
    if (window.top !== window) return false;
    if (!/\/room\/room\.php$/i.test(location.pathname)) return false;
    return !fairyChoiceVisible() &&
      !readyDialogueVisible() &&
      !fairyCooldownDialogueVisible() &&
      !battleInterfaceVisible() &&
      !findBattleReturnAction();
  }

  function fairyCooldownDialogueVisible(text = bodyText()) {
    if (!/сейчас\s+пока\s+нет\s+для\s+тебя\s+работы/i.test(text)) return false;

    // Do not treat the NPC echo in the room chat as an open Fairy cooldown dialog.
    // The live dialog is a qa.php document (or exposes its exact close action).
    // This matters because the chat can permanently retain old lines such as
    // «Приходи где-то через ?».
    return /\/room\/func\/qa\.php$/i.test(location.pathname) ||
      !!findQaAction(9000, /хорошо.*подойду.*позже/i);
  }

  function parseFairyWaitMs(text = bodyText()) {
    if (!fairyCooldownDialogueVisible(text)) return null;

    // Haddan sometimes lets the displayed countdown go below zero, e.g.
    // "Приходи где-то через -1:47:22". A negative value means the cooldown
    // has already expired and the dialogue should be closed immediately.
    const clock = text.match(/приходи[^.]*?через\s+(-?\d{1,3}):([0-5]?\d)(?::([0-5]?\d))?/i);
    if (clock) {
      const negative = String(clock[1]).startsWith('-');
      const a = Math.abs(Number(clock[1]));
      const b = Number(clock[2]);
      const c = clock[3] == null ? null : Number(clock[3]);
      const seconds = c == null ? (a * 60 + b) : (a * 3600 + b * 60 + c);
      return negative ? 0 : Math.max(0, seconds * 1000);
    }

    const hMatch = text.match(/через[^.]*?(-?\d+)\s*(?:ч|час)/i);
    const mMatch = text.match(/через[^.]*?(-?\d+)\s*(?:м|мин)/i);
    const sMatch = text.match(/через[^.]*?(-?\d+)\s*(?:с|сек)/i);
    const h = Number(hMatch?.[1] || 0);
    const m = Number(mMatch?.[1] || 0);
    const sec = Number(sMatch?.[1] || 0);
    if (hMatch || mMatch || sMatch) {
      if (h < 0 || m < 0 || sec < 0) return 0;
      return Math.max(0, (h * 3600 + m * 60 + sec) * 1000);
    }

    return null;
  }

  function findQaAction(id, textRe) {
    const links = [...document.querySelectorAll('a[href*="qa.php"]')].filter((el) => visible(el) && enabled(el));
    const byId = links.filter((el) => {
      try {
        const url = new URL(el.getAttribute('href'), location.href);
        return url.searchParams.get('id') === String(id);
      } catch (_) { return false; }
    });

    // Haddan reuses the same qa.php?id for semantically different terminal actions.
    // In particular id=9000 is used both for «Спасибо.» after a reward and for
    // «Хорошо, я подойду позже.» on the Fairy cooldown page. Therefore, when a
    // label matcher is supplied, BOTH the id and the visible label must match.
    // Falling back to an arbitrary link with the same id causes a loop where a
    // cooldown close link is mistaken for an orphan reward acknowledgement.
    if (textRe) {
      return byId.find((el) => {
        textRe.lastIndex = 0;
        return textRe.test(elementLabel(el));
      }) || null;
    }

    return byId[0] || null;
  }

  function findContinueBattleAction(text = bodyText()) {
    // IMPORTANT: Haddan can echo old "Продолжить бой" links in the chat/history.
    // Never react to the link text alone; require the actual guard-dialog phrase.
    // This prevents the bot from being thrown out of an otherwise normal active fight.
    const guardDialog = /вам\s+хотелось\s+бы\s+пообщаться[\s\S]{0,260}?ужасно\s+заняты\s+ведением\s+боя/i.test(text);
    if (!guardDialog) return null;
    return findQaAction(2000000001, /продолжить\s+бой/i);
  }

  function findExactThanksAction() {
    // Resource confirmation can render as a minimal page containing only "Спасибо.".
    // Do not depend on pendingReward or on the preceding reward sentence being present.
    return findQaAction(9000, /^спасибо[.!]?$/i);
  }

  function rewardDocumentState() {
    const choiceAt = Number(runtime.rewardChoiceAt || runtime.pendingRewardSince || 0);
    if (!choiceAt) {
      return {
        choiceAt: 0,
        age: Infinity,
        freshDocument: false,
        freshQaAfterChoice: false,
        sameChoiceFrame: false,
        captured: false
      };
    }
    const age = Date.now() - choiceAt;
    const choiceDocumentStartedAt = Number(runtime.rewardChoiceDocumentStartedAt || 0);
    const expectedFrame = String(runtime.rewardChoiceFrameKey || '');
    const sameChoiceFrame = !expectedFrame || expectedFrame === frameContextKey();
    const isQaDocument = /\/room\/func\/qa\.php$/i.test(location.pathname);

    // Before XP is captured we keep the old strict binding to the frame that
    // submitted the resource choice. After navigation Haddan can, however, render
    // the final «Спасибо.» in a newly created qa.php document/browsing context.
    // That new document can legitimately have another frameContextKey. Remember
    // this separately so a captured reward cannot deadlock only because the frame
    // identity changed during the server-side transition.
    const freshQaAfterChoice = isQaDocument && DOCUMENT_STARTED_AT >= choiceAt - 250;
    const freshDocument = sameChoiceFrame &&
      DOCUMENT_STARTED_AT >= Math.max(choiceAt - 250, choiceDocumentStartedAt);
    const capturedAt = Number(runtime.lastRewardCapturedAt || 0);
    const captured = capturedAt >= choiceAt;
    return { choiceAt, age, freshDocument, freshQaAfterChoice, sameChoiceFrame, captured };
  }

  function dialogueInitializationErrorVisible(text = bodyText()) {
    const normalized = normalize(text);
    return /ошибка\s+инициализации\s+диалога!?/i.test(normalized) &&
      /пожалуйста[,!]?\s*попытайтесь\s+начать\s+диалог\s+ещ[её]\s+раз/i.test(normalized);
  }

  function findDialogueInitializationErrorReturnAction(text = bodyText()) {
    if (!dialogueInitializationErrorVisible(text)) return null;

    // This is a very specific Haddan error page. Require both the exact server
    // message above and an exact "Вернуться" action leading back to room.php,
    // so an unrelated error or ordinary navigation link is never auto-clicked.
    const actions = allActions().filter((el) => visible(el) && enabled(el));
    return actions.find((el) => {
      if (!/^вернуться[.!]?$/i.test(elementLabel(el))) return false;
      return /\/room\/room\.php$/i.test(hrefPath(el));
    }) || null;
  }

  function findBattleReturnAction(text = bodyText()) {
    // Typical Poliana result page:
    //   "Вы получили +20 опыта"
    //   "Вы нанесли урон: ..."
    //   "Вы создали ... новых трупов"
    //   [Вернуться] -> /room/room.php
    // Require a result-page marker plus an exact Return label so we do not click
    // unrelated navigation links that happen to point to room.php.
    const resultPage = /вы\s+получили\s*\+?\d+\s+опыта/i.test(text) ||
      /вы\s+нанесли\s+урон/i.test(text) ||
      /вы\s+создали\s+\d+\s+новых?\s+труп/i.test(text);
    if (!resultPage) return null;

    const actions = allActions().filter((el) => visible(el) && enabled(el));
    const exact = actions.find((el) => {
      if (!/^вернуться[.!]?$/i.test(elementLabel(el))) return false;
      const path = hrefPath(el);
      return !path || /\/room\/room\.php$/i.test(path);
    });
    if (exact) return exact;

    return actions.find((el) =>
      /^вернуться[.!]?$/i.test(elementLabel(el)) && /\/room\/room\.php$/i.test(hrefPath(el))
    ) || null;
  }

  function battleInterfaceVisible(text = bodyText()) {
    let score = 0;
    if (/история\s+боя/i.test(text)) score += 1;
    if (/\bраунд\s*\d+/i.test(text)) score += 1;
    if (/\bударить\s*!?/i.test(text)) score += 1;
    if (/между\s+двумя[^.]{0,120}воинственными\s+сторонами/i.test(text)) score += 1;
    return score >= 2;
  }

  async function touchBattleExpected(durationMs = 60000) {
    const target = Date.now() + durationMs;
    // Avoid writing chrome.storage on every MutationObserver pass.
    if ((runtime.battleExpectedUntil || 0) >= target - 30000) return;
    await saveRuntime({ battleExpectedUntil: target });
  }

  async function clearBattleExpected() {
    if (!runtime.battleExpectedUntil) return;
    await saveRuntime({ battleExpectedUntil: 0 });
  }

  async function markBattleActive(extra = {}) {
    const patch = { battleActive: true, ...extra };
    await saveRuntime(patch);
  }

  async function clearBattleActive() {
    if (runtime.battleActive || runtime.battleRecoveryLastClickAt || runtime.battleRecoveryAttempts) {
      await saveRuntime({
        battleActive: false,
        battleRecoveryLastClickAt: 0,
        battleRecoveryAttempts: 0
      });
    }
  }

  async function setStatus(text) {
    if (text === lastStatusText) return;
    lastStatusText = text;
    try {
      await chrome.storage.local.set({ [BOT_STATUS_KEY]: { text, ts: Date.now(), frame: location.pathname } });
    } catch (_) {}
  }

  async function setCaptchaStatus(phase, text, extra = {}) {
    const progress = Math.max(0, Math.min(100, Number(extra.progress || 0)));
    const current = Math.max(0, Number(extra.current || 0));
    const total = Math.max(0, Number(extra.total || 0));
    const signature = `captcha:${phase}:${progress}:${current}:${total}:${text}`;
    if (signature === lastStatusText) return;
    lastStatusText = signature;
    try {
      await chrome.storage.local.set({
        [BOT_STATUS_KEY]: {
          kind: 'captcha',
          mode: settings.solveCaptcha ? 'auto' : 'manual',
          phase: String(phase || ''),
          progress,
          current,
          total,
          runeCount: Math.max(0, Number(extra.runeCount || total || 0)),
          detail: String(extra.detail || text || ''),
          text: String(text || ''),
          ts: Date.now(),
          frame: location.pathname
        }
      });
    } catch (_) {}
  }

  async function saveRuntime(patch) {
    // automation.js runs in multiple Haddan frames. Merge against the newest stored
    // value before writing so a stale frame is less likely to erase another frame's
    // pendingReward / cooldown / battleExpected state.
    try {
      const stored = await chrome.storage.local.get(BOT_RUNTIME_KEY);
      const current = normalizeRuntime(stored[BOT_RUNTIME_KEY] || {});
      runtime = normalizeRuntime({ ...current, ...patch });
      await chrome.storage.local.set({ [BOT_RUNTIME_KEY]: runtime });
    } catch (_) {
      runtime = normalizeRuntime({ ...runtime, ...patch });
    }
  }

  async function clearRewardTransaction(extra = {}) {
    await saveRuntime(clearRewardRuntimePatch(extra));
  }

  function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  async function captureClick(event) {
    if (!settings.captureFairy) return;
    const action = closestAction(event.target);
    if (!action || action.closest?.('#hmh-root')) return;

    const signature = makeSignature(action);
    if (!signature.label && !signature.href && !signature.onclick && !signature.id) return;

    settings = normalizeAutomation({
      ...settings,
      running: false,
      captureFairy: false,
      selectedFairy: signature
    });
    try {
      await chrome.storage.local.set({
        [AUTOMATION_KEY]: settings,
        [BOT_STATUS_KEY]: { text: `Фея выбрана: ${signature.label || signature.title || signature.hrefPath || 'действие'}`, ts: Date.now(), frame: location.pathname }
      });
    } catch (e) {
      console.warn('[Haddan Market Helper] Fairy capture failed', e);
    }
    // User's click is intentionally not blocked.
  }

  function canClickAgain(key = '') {
    const now = Date.now();
    if (now - lastClickAt < 750) return false;
    if (key && key === lastClickKey && now - lastClickAt < 2500) return false;
    if (lastClickAt && mutationVersion <= lastClickMutation && now - lastClickAt < 6500) return false;
    return true;
  }

  function needsMainWorldClick(el) {
    const href = el?.getAttribute?.('href') || '';
    return /^javascript:/i.test(href);
  }

  async function clickInMainWorld(el) {
    const token = `hmh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    el.setAttribute('data-hmh-main-click', token);

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'HMH_MAIN_WORLD_CLICK',
        token
      });
      return !!result?.ok;
    } catch (e) {
      console.warn('[Haddan Market Helper] MAIN world click failed', e);
      return false;
    } finally {
      if (el.isConnected && el.getAttribute('data-hmh-main-click') === token) {
        el.removeAttribute('data-hmh-main-click');
      }
    }
  }

  async function clickAction(el, key, status, delay = 350) {
    if (!el) return false;
    if (!canClickAgain(key)) {
      // A fast rescan can arrive from chrome.storage.onChanged before the delayed
      // native click has even fired. Never let that throttled rescan become the
      // last scan of the FSM.
      scheduleScan(350);
      return false;
    }
    lastClickAt = Date.now();
    lastClickMutation = mutationVersion;
    lastClickKey = key || '';
    await setStatus(status);

    setTimeout(async () => {
      if (!el.isConnected || !settings.running) return;
      try {
        if (needsMainWorldClick(el)) {
          const ok = await clickInMainWorld(el);
          if (!ok) {
            console.warn('[Haddan Market Helper] MAIN world auto click failed', key);
            await setStatus('Ошибка автоматического клика');
          }
        } else {
          el.click();
        }
      } catch (e) {
        console.warn('[Haddan Market Helper] auto click failed', key, e);
      }
    }, delay);

    // Independent trailing watchdog. Successful navigation destroys this timer; if
    // Haddan ignores the click (or MAIN-world messaging stalls), the FSM still gets
    // another scan instead of stopping on the last status forever.
    setTimeout(() => scheduleScan(60), delay + CLICK_WATCHDOG_MS);
    return true;
  }

  async function clickRewardThanks(status) {
    const now = Date.now();
    const scheduledAt = Number(runtime.rewardAckScheduledAt || 0);
    const startedAt = Number(runtime.rewardAckStartedAt || 0);

    // Reward ACK is special: Haddan can replace the qa.php DOM while it is open.
    // Generic clickAction() keeps a reference to the old <a> until its delayed
    // timeout fires; if the page refreshes in that gap the element becomes
    // disconnected and the click is silently lost.  Re-find the native
    // «Спасибо.» immediately before clicking and distinguish a scheduled ACK
    // from a click that was actually attempted.
    if (startedAt) return false;
    if (scheduledAt && now - scheduledAt < 1500) return false;

    await saveRuntime({
      rewardAckScheduledAt: now,
      rewardAcknowledgingUntil: now + 3000
    });
    await setStatus(status);

    let target = findExactThanksAction();
    if (!target || !target.isConnected || !settings.running || !runtime.pendingReward) {
      await saveRuntime({ rewardAckScheduledAt: 0, rewardAcknowledgingUntil: 0 });
      return false;
    }

    const ackStartedAt = Date.now();
    await saveRuntime({
      rewardAckScheduledAt: 0,
      rewardAckStartedAt: ackStartedAt,
      rewardAckFrameKey: frameContextKey(),
      rewardAckDocumentStartedAt: DOCUMENT_STARTED_AT,
      rewardAcknowledgingUntil: ackStartedAt + 3000
    });

    // Storage writes above are asynchronous and the page may have refreshed in
    // the meantime. Never click the stale node captured before them.
    target = findExactThanksAction();
    if (!target || !target.isConnected || !settings.running || !runtime.pendingReward) {
      await saveRuntime({
        rewardAckStartedAt: 0,
        rewardAckFrameKey: '',
        rewardAckDocumentStartedAt: 0,
        rewardAcknowledgingUntil: 0
      });
      return false;
    }

    try {
      target.click();
      return true;
    } catch (e) {
      console.warn('[Haddan Market Helper] reward ACK click failed', e);
      await saveRuntime({
        rewardAckStartedAt: 0,
        rewardAckFrameKey: '',
        rewardAckDocumentStartedAt: 0,
        rewardAcknowledgingUntil: 0
      });
      return false;
    }
  }

  async function scanAutomation() {
    scanTimer = null;
    if (!settings.running || settings.captureFairy || !settings.collectResources) return;

    const text = bodyText();
    const now = Date.now();

    // CAPTCHA GUARD. This must run before every battle/Fairy state. Automation
    // pauses globally while the challenge is visible. Depending on settings the
    // CAPTCHA frame either runs the API flow or waits for manual input; the cycle
    // resumes only after the CAPTCHA UI disappears for a short grace period.
    const captchaHere = captchaVisible();
    if (captchaHere) {
      const firstDetection = runtime.pauseReason !== 'captcha';
      const heartbeatDue = firstDetection || now - Number(runtime.captchaLastSeenAt || 0) >= 700;

      if (heartbeatDue) {
        await saveRuntime({
          pauseReason: 'captcha',
          captchaDetectedAt: firstDetection ? now : Number(runtime.captchaDetectedAt || now),
          captchaLastSeenAt: now,
          captchaSignalAt: firstDetection ? now : Number(runtime.captchaSignalAt || 0)
        });
      }

      let captchaHookResult = null;
      if (firstDetection) {
        lastCaptchaDecode = null;
        resetCaptchaRequestState();
        requestCaptchaAlertSound();
      }

      // Do not make CAPTCHA solving a one-shot action. A transient API/network or
      // MV3 message-channel failure used to leave this frame forever at
      // «отправляю изображение в API» until the page/extension was restarted.
      // The content side now has its own watchdog and retries the same unchanged
      // challenge a few times. This also recovers after a page reload when the
      // shared runtime still says pauseReason='captcha' and firstDetection=false.
      // A retry budget belongs to one concrete image only. If the user/site
      // regenerates the CAPTCHA without removing the widget, release an exhausted
      // budget so the new challenge can be solved automatically.
      if ((captchaSubmitExhausted || captchaRetryAt === Number.POSITIVE_INFINITY) && captchaAttemptFingerprint) {
        try {
          const currentCaptchaImage = await captureCaptchaImageDataUrl();
          if (hashString(currentCaptchaImage) !== captchaAttemptFingerprint) {
            resetCaptchaRequestState();
            lastCaptchaDecode = null;
          }
        } catch (_) {}
      }

      // A successful form submission is not proof that Haddan actually accepted
      // it. If the exact same CAPTCHA remains visible, retry the unchanged challenge
      // after a bounded grace period. Previously lastCaptchaDecode.applied=true
      // blocked every future attempt forever at «жду переход страницы».
      if (lastCaptchaDecode?.applied && lastCaptchaDecode.submittedAt &&
          now - Number(lastCaptchaDecode.submittedAt) >= CAPTCHA_SUBMIT_STALL_MS) {
        if (captchaAttemptCount < CAPTCHA_MAX_AUTO_ATTEMPTS) {
          lastCaptchaDecode.applied = false;
          captchaRetryAt = now;
          await setCaptchaStatus(
            'waiting',
            `CAPTCHA: переход не произошёл · повтор ${captchaAttemptCount + 1}/${CAPTCHA_MAX_AUTO_ATTEMPTS}`,
            { progress: 40, detail: 'После отправки CAPTCHA осталась на странице; повторяю тот же challenge.' }
          );
        } else {
          lastCaptchaDecode.applied = false;
          captchaRetryAt = Number.POSITIVE_INFINITY;
          captchaSubmitExhausted = true;
        }
      }

      const captchaAutoAttemptDue = settings.solveCaptcha &&
        !!settings.captchaApiToken &&
        !captchaSolveInFlight &&
        !captchaSubmitExhausted &&
        !lastCaptchaDecode?.applied &&
        now >= Number(captchaRetryAt || 0);
      if (captchaAutoAttemptDue) {
        captchaHookResult = await captchaIntegrationHook();
      }

      if (!settings.solveCaptcha) {
        await setCaptchaStatus('manual', 'CAPTCHA: ручной режим — введи руны вручную', { progress: 0 });
      } else if (!settings.captchaApiToken) {
        await setCaptchaStatus('manual', 'CAPTCHA: API token не задан — нужен ручной ввод', { progress: 0 });
      } else if (captchaSubmitExhausted) {
        await setCaptchaStatus(
          'error',
          `CAPTCHA: отправлена ${captchaAttemptCount} раз(а), но перехода нет`,
          { progress: 0, detail: 'Автоповторы остановлены для этой CAPTCHA. Можно завершить её вручную; цикл возобновится после исчезновения проверки.' }
        );
      } else if (captchaHookResult?.stage === 'challenge-changed') {
        await setCaptchaStatus('error', 'CAPTCHA: изображение изменилось во время запроса', { progress: 0, detail: 'Challenge сменился до применения ответа. Введи текущие руны вручную.' });
      } else if (captchaHookResult?.stage === 'challenge-gone') {
        await setCaptchaStatus('waiting', 'CAPTCHA: проверка уже исчезла, жду обновление состояния…', { progress: 98 });
      } else if (captchaHookResult?.stage === 'apply-failed') {
        await setCaptchaStatus('error', 'CAPTCHA: не удалось применить распознанные руны', { progress: 0, detail: 'API ответ получен, но ввод на странице не подтвердился. Можно завершить CAPTCHA вручную.' });
      } else if (captchaHookResult?.stage === 'retry') {
        // captchaIntegrationHook published the retry countdown/status.
      } else if (captchaHookResult?.stage === 'error') {
        // captchaIntegrationHook already stored a structured error status.
      } else if (captchaHookResult?.ok) {
        // captchaIntegrationHook already stored the final waiting status.
      } else if (!firstDetection && lastCaptchaDecode?.applied) {
        await setCaptchaStatus(
          'waiting',
          'CAPTCHA: ответ отправлен, жду переход страницы…',
          { progress: 97, current: lastCaptchaDecode.runeCount, total: lastCaptchaDecode.runeCount, runeCount: lastCaptchaDecode.runeCount }
        );
      } else if (!firstDetection && lastCaptchaDecode && !lastCaptchaDecode.applied) {
        await setCaptchaStatus('error', 'CAPTCHA: распознано, но ввод не завершён', { progress: 0, detail: 'Автоматический ввод не подтвердился. Можно продолжить вручную.' });
      } else if (!firstDetection && settings.solveCaptcha) {
        // Do not overwrite the CAPTCHA frame's detailed progress from another scan.
      } else {
        await setCaptchaStatus('manual', 'CAPTCHA: автоматика на паузе — ручной ввод', { progress: 0 });
      }
      scheduleScan(500);
      return;
    }

    // Other Haddan frames do not contain the CAPTCHA themselves. They honour the
    // heartbeat written by the challenge frame and are forbidden to click anything
    // until that heartbeat has stopped for >2.2 s (the CAPTCHA frame navigated away).
    if (runtime.pauseReason === 'captcha') {
      const age = now - Number(runtime.captchaLastSeenAt || runtime.captchaDetectedAt || now);
      if (age < 2200) {
        // In automatic mode the CAPTCHA-owning frame publishes detailed progress.
        // Other frames must not overwrite it with the old manual-pause message.
        if (!settings.solveCaptcha) {
          await setCaptchaStatus('manual', 'CAPTCHA: жду ручной ввод', { progress: 0 });
        }
        scheduleScan(500);
        return;
      }

      await resetTransientBattleAfterCaptcha();
      await setCaptchaStatus('done', 'CAPTCHA пройдена: возобновляю цикл Поляны', { progress: 100 });
      scheduleScan(900);
      return;
    }

    // 0) Haddan occasionally returns a dedicated NPC-dialog initialization error:
    //    "Ошибка инициализации диалога! Пожалуйста, попытайтесь начать диалог ещё раз."
    // Treat it as a recoverable transport/dialog race: close that exact error page,
    // release transient locks that would otherwise keep the bot on "Бой: активен"
    // or "жду награду", then retry the Fairy only after a short shared backoff.
    const dialogErrorReturn = findDialogueInitializationErrorReturnAction(text);
    if (dialogErrorReturn) {
      const recoveryUntil = Number(runtime.dialogInitRecoveryUntil || 0);
      if (recoveryUntil > now) {
        await setStatus('Фея: ошибка инициализации диалога · жду возврат на Поляну');
        scheduleScan(Math.min(500, Math.max(120, recoveryUntil - now)));
        return;
      }

      await clearBattleExpected();
      await clearBattleActive();

      // If the failed page appeared during a reward transaction, keeping
      // pendingReward would make every other frame wait forever for a reward page
      // that the server explicitly failed to initialize. clearRewardTransaction()
      // removes only transaction/ACK locks; already captured XP evidence remains.
      if (runtime.pendingReward || runtime.rewardAckStartedAt || runtime.rewardAckScheduledAt) {
        await clearRewardTransaction();
      }

      const retryUntil = Date.now() + 3000;
      await saveRuntime({
        dialogInitRecoveryUntil: retryUntil,
        battleExpectedUntil: 0,
        battleStartRequestedAt: 0,
        battleStartRequestFrameKey: '',
        battleStartRequestDocumentStartedAt: 0,
        battleStartAttempts: 0,
        fairyChoiceActiveUntil: 0
      });

      const clicked = await clickAction(
        dialogErrorReturn,
        'dialog-init-error-return',
        'Фея: ошибка инициализации диалога · возвращаюсь и повторю',
        160
      );
      if (!clicked) {
        await setStatus('Фея: ошибка инициализации диалога · жду возможность вернуться');
        scheduleScan(300);
      } else {
        // If Haddan ignores the native return once, rescan the same error page
        // after the shared backoff and retry instead of silently stopping here.
        scheduleScan(500);
      }
      return;
    }

    // 0.1) Haddan can show this guard page when the user/NPC navigation happens while
    //      a fight is still active. Return to the fight before processing any Fairy state.
    const continueBattle = findContinueBattleAction(text);
    if (continueBattle) {
      // This dialogue may remain visible for a while even after the first click,
      // and Haddan also echoes every click into chat. Clicking it on every scan
      // therefore creates an endless "Продолжить бой" loop. Treat recovery as
      // a one-shot operation with one slow retry at most.
      await touchBattleExpected(60000);
      if (!runtime.battleActive) await markBattleActive();

      const sinceRecovery = now - Number(runtime.battleRecoveryLastClickAt || 0);
      const attempts = Number(runtime.battleRecoveryAttempts || 0);

      if (!runtime.battleRecoveryLastClickAt) {
        await saveRuntime({
          battleActive: true,
          battleRecoveryLastClickAt: now,
          battleRecoveryAttempts: 1
        });
        await clickAction(continueBattle, 'continue-battle', 'Бой: возвращаюсь в бой', 160);
        scheduleScan(600);
        return;
      }

      // Allow just one retry if the first recovery click genuinely did not take.
      if (attempts < 2 && sinceRecovery >= 5000) {
        await saveRuntime({
          battleActive: true,
          battleRecoveryLastClickAt: now,
          battleRecoveryAttempts: attempts + 1
        });
        await clickAction(continueBattle, `continue-battle-retry-${attempts + 1}`, 'Бой: повторно возвращаюсь в бой', 160);
        scheduleScan(700);
        return;
      }

      if (attempts >= 2 && sinceRecovery >= CONTINUE_BATTLE_RECOVERY_RETRY_MS) {
        // The guard still proves that a fight exists. Reset only the bounded retry
        // counter and try the native «Продолжить бой» again instead of waiting on
        // this exact page forever after two ignored clicks.
        await saveRuntime({
          battleRecoveryLastClickAt: 0,
          battleRecoveryAttempts: 0
        });
        await setStatus('Бой: возврат не сработал · повторяю восстановление');
        scheduleScan(300);
        return;
      }

      await setStatus('Бой: жду возврат в бой');
      scheduleScan(500);
      return;
    }

    // 0.5) The fight has finished and Haddan is showing the result screen.
    const battleReturn = findBattleReturnAction(text);
    if (battleReturn) {
      await clearBattleExpected();
      await clearBattleActive();
      await saveRuntime({
        battleStartRequestedAt: 0,
        battleStartRequestFrameKey: '',
        battleStartRequestDocumentStartedAt: 0,
        battleStartAttempts: 0
      });
      if (runtime.fairyWaitUntil) await saveRuntime({ fairyWaitUntil: 0, fairyWaitKind: '' });
      await clickAction(battleReturn, 'battle-return', 'Бой завершен: возвращаюсь с Поляны', 180);
      return;
    }

    // 1) A real battle always wins over any stale Fairy runtime state. This is also
    //    important because automation.js runs in several Haddan frames.
    const battleVisible = battleInterfaceVisible(text);
    if (battleVisible) {
      if (runtime.fairyWaitUntil) await saveRuntime({ fairyWaitUntil: 0, fairyWaitKind: '' });
      await touchBattleExpected(60000);

      // The extension no longer conducts combat. Haddan's built-in autobattle owns
      // every combat action; we only keep a cross-frame lock so stale Fairy/chat
      // frames cannot start a second interaction while the fight is running.
      if (!runtime.battleActive || runtime.battleRecoveryLastClickAt || runtime.battleRecoveryAttempts) {
        await saveRuntime({
          battleActive: true,
          battleStartRequestedAt: 0,
          battleStartRequestFrameKey: '',
          battleStartRequestDocumentStartedAt: 0,
          battleStartAttempts: 0,
          battleRecoveryLastClickAt: 0,
          battleRecoveryAttempts: 0
        });
      }

      await setStatus('Бой: жду штатный автобой Haddan');
      scheduleScan(500);
      return;
    }

    // 2) While a fight is known to be active, no stale Fairy/chat frame is
    //    allowed to drive the Fairy FSM. Only the actual battle/result/recovery
    //    states above may clear this lock.
    if (runtime.battleActive) {
      const battleDeadline = Number(runtime.battleExpectedUntil || 0);
      if (!battleDeadline || battleDeadline <= now) {
        // battleExpectedUntil is refreshed while a real fight surface is visible.
        // If no frame has seen the fight for a full deadline window, battleActive is
        // stale. Leaving that boolean set used to block the Fairy FSM forever.
        await clearBattleActive();
        await saveRuntime({
          battleExpectedUntil: 0,
          battleStartRequestedAt: 0,
          battleStartRequestFrameKey: '',
          battleStartRequestDocumentStartedAt: 0,
          battleStartAttempts: 0
        });
        await setStatus('Бой: интерфейс боя давно не виден · снимаю зависшую блокировку');
        scheduleScan(300);
        return;
      }

      await setStatus('Бой: активен, жду штатный автобой/результат');
      scheduleScan(500);
      return;
    }

    // After the exact dialog-initialization error was closed, let Haddan finish
    // returning to room.php before another frame opens the Fairy again. A real
    // battle/result page is handled above and is therefore never hidden by this guard.
    if (runtime.dialogInitRecoveryUntil && runtime.dialogInitRecoveryUntil > now) {
      await setStatus(`Фея: повторяю диалог через ${formatCountdown(runtime.dialogInitRecoveryUntil - now)}`);
      scheduleScan(Math.min(500, Math.max(120, runtime.dialogInitRecoveryUntil - now)));
      return;
    }
    if (runtime.dialogInitRecoveryUntil && runtime.dialogInitRecoveryUntil <= now) {
      await saveRuntime({ dialogInitRecoveryUntil: 0 });
    }

    // Recovery for the exact regression visible in v0.6.47-v0.6.51: an older
    // post-XP watchdog could clear pendingReward while the real qa.php frame was
    // still sitting on the native «Спасибо.» link. Another idle frame then tried
    // to open Fairy again and the global status became «Иду к Фее», even though
    // the acknowledgement dialog was visibly still open.
    //
    // If the transaction lock is already gone, only auto-close an orphan
    // «Спасибо.» when there is very recent captured reward evidence. Requiring a
    // real qa.php document + exact id=9000 label + recent XP sample prevents an
    // unrelated/stale chat link from being clicked.
    if (!runtime.pendingReward && /\/room\/func\/qa\.php$/i.test(location.pathname)) {
      const orphanThanks = findExactThanksAction();
      const capturedAt = Number(runtime.lastRewardCapturedAt || 0);
      const captureAge = capturedAt ? now - capturedAt : Infinity;
      const capturedExp = Number(runtime.lastRewardCapturedExp);
      const capturedQty = Number(runtime.lastRewardCapturedQuantity || 0);
      const recentCapturedReward = capturedAt > 0 && captureAge >= 0 &&
        captureAge <= ORPHAN_THANKS_RECOVERY_WINDOW_MS &&
        Number.isFinite(capturedExp) && capturedQty > 0;

      if (orphanThanks && recentCapturedReward) {
        if (now - lastOrphanThanksClickAt >= 1500) {
          lastOrphanThanksClickAt = now;
          await setStatus('Фея: найдено незакрытое «Спасибо» после сохраненной награды · закрываю');
          const target = findExactThanksAction();
          if (target && target.isConnected && settings.running) {
            try { target.click(); } catch (e) {
              console.warn('[Haddan Market Helper] orphan reward ACK click failed', e);
            }
          }
        }
        scheduleScan(500);
        return;
      }
    }

    // Fast watchdog for a LOST RESOURCE CHOICE click. markPendingReward() is
    // intentionally stored before the native <a> click to lock all other Haddan
    // frames. If that click is swallowed (DOM replacement, throttled timer, or a
    // transient browser/navigation race), v0.6.50 could sit on the exact same
    // «Выбери себе» page until the generic 90-second transaction watchdog fired.
    //
    // It is safe to retry much earlier when ALL of the following are true:
    //   * no matching reward has been captured;
    //   * this is the exact frame/document that submitted the resource choice;
    //   * the original Fairy choice UI is STILL present after 15 seconds.
    // A successful navigation destroys/replaces this document, so a stale choice
    // frame elsewhere cannot release a legitimate reward transaction.
    if (runtime.pendingReward) {
      const choiceAt = Number(runtime.rewardChoiceAt || runtime.pendingRewardSince || 0);
      const capturedAt = Number(runtime.lastRewardCapturedAt || 0);
      const capturedCurrentReward = choiceAt > 0 && capturedAt >= choiceAt;
      const expectedFrame = String(runtime.rewardChoiceFrameKey || '');
      const sameChoiceFrame = !expectedFrame || expectedFrame === frameContextKey();
      const choiceDocumentStartedAt = Number(runtime.rewardChoiceDocumentStartedAt || 0);
      const sameChoiceDocument = choiceDocumentStartedAt > 0 &&
        Math.abs(DOCUMENT_STARTED_AT - choiceDocumentStartedAt) <= 250;
      const choiceStillVisible = fairyChoiceVisible(text);

      if (!capturedCurrentReward && choiceAt && sameChoiceFrame && sameChoiceDocument &&
          choiceStillVisible && now - choiceAt >= RESOURCE_CHOICE_STALL_FAILSAFE_MS) {
        const resourceName = runtime.pendingRewardResource || 'ресурс';
        const quantity = Number(runtime.pendingRewardQuantity || 0);
        await clearRewardTransaction({
          fairyChoiceActiveUntil: 0,
          latestFairyActionableChoiceDocumentStartedAt: 0,
          latestFairyActionableChoiceFrameKey: '',
          latestFairyActionableChoiceSignature: ''
        });
        await setStatus(`Фея: выбор ${resourceName}${quantity ? ` ${quantity} шт.` : ''} не открыл награду за 15 с · повторяю`);
        scheduleScan(250);
        return;
      }
    }

    // Generic reward transaction watchdog. The 30-second «Спасибо» fallback only
    // helps once a valid acknowledgement is visible (or XP was already captured).
    // If the resource click itself was lost and Haddan shows neither reward nor
    // «Спасибо», pendingReward otherwise had no terminal path at all.
    if (runtime.pendingReward) {
      const pendingSince = Number(runtime.pendingRewardSince || runtime.rewardChoiceAt || 0);
      const rewardChoiceAt = Number(runtime.rewardChoiceAt || 0);
      const capturedAt = Number(runtime.lastRewardCapturedAt || 0);
      const capturedCurrentReward = rewardChoiceAt > 0 && capturedAt >= rewardChoiceAt;
      if (!capturedCurrentReward && pendingSince && now - pendingSince >= REWARD_TRANSACTION_FAILSAFE_MS) {
        await clearRewardTransaction({ fairyChoiceActiveUntil: 0 });
        await setStatus('Фея: награда не появилась за 90 с · сбрасываю транзакцию и повторяю');
        scheduleScan(500);
        return;
      }
    }

    // 3) Fairy cooldown dialogue. The first positive server timer creates a local
    //    deadline. After that deadline expires, the same old qa.php document is
    //    stale even if its server-rendered text still says e.g. 15:00.
    if (fairyCooldownDialogueVisible(text)) {
      const waitMs = parseFairyWaitMs(text);
      await clearBattleExpected();

      // A stale cooldown iframe from the previous cycle can remain alive while a
      // new reward is being issued. It must not release the current transaction.
      // Only a cooldown document created after our native «Спасибо.» click proves
      // that this particular reward flow has completed.
      if (runtime.pendingReward) {
        const ackStartedAt = Number(runtime.rewardAckStartedAt || 0);
        const ackFrameKey = String(runtime.rewardAckFrameKey || '');
        const sameAckFrame = !ackFrameKey || ackFrameKey === frameContextKey();
        const freshAfterAck = ackStartedAt && sameAckFrame && DOCUMENT_STARTED_AT >= ackStartedAt - 250;

        // Manual recovery: if the user clicked «Спасибо.» themselves there is no
        // ACK attempt marker. Accept only a genuinely new qa.php cooldown document
        // created after the matching reward was captured. A stale cooldown frame
        // that merely shares the old resource-choice frame index is not enough.
        const capturedAt = Number(runtime.lastRewardCapturedAt || 0);
        const manualAckAfterCapture = !ackStartedAt && capturedAt &&
          /\/room\/func\/qa\.php$/i.test(location.pathname) &&
          DOCUMENT_STARTED_AT >= capturedAt - 250;
        if (!freshAfterAck && !manualAckAfterCapture) {
          const captured = Number(runtime.lastRewardCapturedAt || 0) >= Number(runtime.rewardChoiceAt || 0);
          await setStatus(captured
            ? 'Фея: опыт сохранен, жду завершение «Спасибо»'
            : 'Фея: жду точную строку награды, «Спасибо» не нажимаю');
          scheduleScan(300);
          return;
        }
        await clearRewardTransaction();
      } else if (runtime.rewardAckStartedAt) {
        await clearRewardTransaction();
      }

      if (waitMs === 0) {
        // Mark every document that was already open at this moment as stale.
        // Haddan leaves the original server-rendered timer text in the old qa.php
        // document, so that document must not be allowed to start another 15 min
        // wait after the local deadline reaches zero.
        await saveRuntime({
          fairyWaitUntil: 0,
          fairyWaitKind: '',
          fairyCooldownMinDocumentStartedAt: Math.max(
            Number(runtime.fairyCooldownMinDocumentStartedAt || 0),
            Date.now()
          ),
          fairyCooldownTransitionUntil: Date.now() + 2500
        });

        const close = findQaAction(9000, /хорошо.*подойду.*позже/i);
        if (close) {
          await clickAction(close, 'fairy-close-timer-expired', 'Фея: таймер завершен, закрываю диалог', 220);
          return;
        }

        await setStatus('Фея: таймер завершен, жду выход из диалога');
        scheduleScan(600);
        return;
      }

      if (waitMs != null && waitMs > 0) {
        // IMPORTANT: the visible timer text is server-rendered and can remain
        // frozen (for example at 15:00) in an old Fairy iframe. If our stored
        // deadline has already expired, that positive text is NOT a new timer.
        // Expire the current cooldown and close the stale dialogue instead of
        // rebasing another full wait from the same page.
        if (runtime.fairyWaitUntil && runtime.fairyWaitUntil <= now) {
          await saveRuntime({
            fairyWaitUntil: 0,
            fairyWaitKind: '',
            fairyCooldownMinDocumentStartedAt: Math.max(
              Number(runtime.fairyCooldownMinDocumentStartedAt || 0),
              Date.now()
            ),
            fairyCooldownTransitionUntil: Date.now() + 2500
          });

          const close = findQaAction(9000, /хорошо.*подойду.*позже/i);
          if (close) {
            await clickAction(close, 'fairy-close-stale-positive-timer', 'Фея: таймер завершен, закрываю диалог', 220);
            return;
          }

          await setStatus('Фея: таймер завершен, жду выход из диалога');
          scheduleScan(600);
          return;
        }

        if (!runtime.fairyWaitUntil) {
          const minDocumentStartedAt = Number(runtime.fairyCooldownMinDocumentStartedAt || 0);

          // Another Haddan frame may still contain the same old cooldown page
          // after one frame has already expired it. Any document that existed
          // before that expiry is stale and is forbidden from creating a new
          // deadline. A genuinely reopened Fairy dialogue is a new document and
          // therefore has DOCUMENT_STARTED_AT >= the expiry watermark.
          if (minDocumentStartedAt && DOCUMENT_STARTED_AT < minDocumentStartedAt) {
            const close = findQaAction(9000, /хорошо.*подойду.*позже/i);
            if (close) {
              await clickAction(close, 'fairy-close-stale-document', 'Фея: старый таймер уже завершен, закрываю диалог', 220);
              return;
            }

            await setStatus('Фея: старый таймер уже завершен, жду новый диалог');
            scheduleScan(600);
            return;
          }

          // A new/fresh cooldown page may initialize the shared deadline once.
          await saveRuntime({ fairyWaitUntil: Date.now() + waitMs + 1200, fairyWaitKind: 'known' });
        } else if (runtime.fairyWaitKind !== 'known') {
          // A previous unknown-format watchdog must never be presented as a real
          // server countdown once this document provides a parseable duration.
          await saveRuntime({ fairyWaitUntil: Date.now() + waitMs + 1200, fairyWaitKind: 'known' });
        }

        const remaining = Math.max(0, (runtime.fairyWaitUntil || 0) - Date.now());
        if (remaining > 0) {
          await setStatus(`Фея: ждать ${formatCountdown(remaining)}`);
          scheduleScan(1000);
          return;
        }
      }

      // Unknown timer format must also have a terminal path. Keep a conservative
      // one-minute local deadline, then mark this document stale and close it if
      // possible. Reopening the Fairy lets the server report the remaining cooldown
      // again without letting an unparseable layout freeze the bot forever.
      const minDocumentStartedAt = Number(runtime.fairyCooldownMinDocumentStartedAt || 0);
      if (minDocumentStartedAt && DOCUMENT_STARTED_AT < minDocumentStartedAt) {
        const close = findQaAction(9000, /хорошо.*подойду.*позже/i);
        if (close) {
          await clickAction(close, 'fairy-close-stale-unknown-timer', 'Фея: старый непонятный таймер · закрываю диалог', 220);
          return;
        }
        scheduleScan(900);
        return;
      }

      // If another fresh cooldown frame has already parsed a real server timer,
      // preserve that authoritative deadline instead of downgrading it to the
      // unknown-format watchdog.
      if (runtime.fairyWaitUntil && runtime.fairyWaitUntil > now && runtime.fairyWaitKind === 'known') {
        await setStatus(`Фея: ждать ${formatCountdown(runtime.fairyWaitUntil - now)}`);
        scheduleScan(1000);
        return;
      }

      if (!runtime.fairyWaitUntil || runtime.fairyWaitKind !== 'unknown') {
        await saveRuntime({
          fairyWaitUntil: now + UNKNOWN_COOLDOWN_RECHECK_MS,
          fairyWaitKind: 'unknown'
        });
      }

      const unknownRemaining = Math.max(0, Number(runtime.fairyWaitUntil || 0) - Date.now());
      if (unknownRemaining > 0) {
        await setStatus(`Фея: время таймера не распознано · повторная проверка через ${formatCountdown(unknownRemaining)}`);
        scheduleScan(1000);
        return;
      }

      await saveRuntime({
        fairyWaitUntil: 0,
        fairyWaitKind: '',
        fairyCooldownMinDocumentStartedAt: Math.max(
          Number(runtime.fairyCooldownMinDocumentStartedAt || 0),
          Date.now()
        ),
        fairyCooldownTransitionUntil: Date.now() + 2500
      });
      const closeUnknown = findQaAction(9000, /хорошо.*подойду.*позже/i);
      if (closeUnknown) {
        await clickAction(closeUnknown, 'fairy-close-unknown-timer', 'Фея: не удалось разобрать таймер · закрываю и перепроверю', 220);
        return;
      }
      await setStatus('Фея: не удалось разобрать таймер · освобождаю старый диалог');
      scheduleScan(700);
      return;
    }

    // 3) A future Fairy deadline is a GLOBAL lock shared by all Haddan frames.
    //    This prevents an idle/chat frame from clicking Fairy or an old "Спасибо"
    //    while another frame is legitimately waiting for the cooldown.
    if (runtime.fairyWaitUntil && runtime.fairyWaitUntil > now) {
      const remaining = runtime.fairyWaitUntil - now;
      await setStatus(runtime.fairyWaitKind === 'unknown'
        ? `Фея: время таймера не распознано · повторная проверка через ${formatCountdown(remaining)}`
        : `Фея: ждать ${formatCountdown(remaining)}`);
      scheduleScan(1000);
      return;
    }
    if (runtime.fairyWaitUntil && runtime.fairyWaitUntil <= now) {
      await saveRuntime({ fairyWaitUntil: 0, fairyWaitKind: '' });
    }

    // A reward choice is a GLOBAL transaction across all Haddan frames. While it
    // is open, stale ready/choice/chat frames are forbidden from talking to the
    // Fairy. The only frames allowed through are the current reward response
    // (XP text / «Спасибо.») handled below.
    if (runtime.pendingReward) {
      const pendingRewardDoc = rewardDocumentState();
      const exactThanksHere = findExactThanksAction();
      const exactRewardHere = pendingRewardObservation(text);
      const choiceAt = Number(runtime.rewardChoiceAt || 0);
      const capturedAt = Number(runtime.lastRewardCapturedAt || 0);
      const captured = choiceAt > 0 && capturedAt >= choiceAt;
      const rewardAge = now - Number(runtime.pendingRewardSince || now);

      // A reward surface can be updated in place or appear in a fresh qa.php
      // document. Keep a lightweight global heartbeat while a verified surface is
      // actually visible. This lets unrelated Haddan frames distinguish
      // "the reward is still open elsewhere" from "the reward frame vanished".
      const capturedThanksHere = captured && !!exactThanksHere &&
        (pendingRewardDoc.sameChoiceFrame || pendingRewardDoc.freshQaAfterChoice);
      const rewardSurfaceHere =
        (pendingRewardDoc.freshDocument && (!!exactRewardHere || !!exactThanksHere)) ||
        capturedThanksHere;
      if (rewardSurfaceHere && now - Number(runtime.rewardSurfaceLastSeenAt || 0) >= 1000) {
        await saveRuntime({ rewardSurfaceLastSeenAt: now });
      }

      // Recovery for the case where Haddan accepted «Спасибо.» and echoed the
      // acknowledgement in chat before this frame observed the next dialogue.
      let activeAckStartedAt = Number(runtime.rewardAckStartedAt || 0);
      let activeAckAge = activeAckStartedAt ? now - activeAckStartedAt : Infinity;
      if (captured && activeAckStartedAt && activeAckAge >= 250 && rewardAckEchoVisible(text)) {
        await clearRewardTransaction();
        scheduleScan(250);
        return;
      }

      // Some servers can transition directly to a fresh ready page after the
      // acknowledgement. Accept it only from the frame/document that actually
      // attempted the native «Спасибо.» click.
      const ackFrameKey = String(runtime.rewardAckFrameKey || '');
      const sameAckFrame = !ackFrameKey || ackFrameKey === frameContextKey();
      const freshPostAckReady = activeAckStartedAt && sameAckFrame &&
        DOCUMENT_STARTED_AT >= activeAckStartedAt - 250 &&
        readyDialogueVisible(text);
      if (freshPostAckReady) {
        await clearRewardTransaction();
        scheduleScan(250);
        return;
      }

      // If an acknowledgement was only scheduled, or a real click attempt did not
      // transition within the short ACK window, clear ONLY the ACK sub-lock. The
      // reward transaction itself remains locked so the verified «Спасибо.» frame
      // can retry safely.
      const scheduledAckAt = Number(runtime.rewardAckScheduledAt || 0);
      if (scheduledAckAt && !activeAckStartedAt && now - scheduledAckAt > 1500) {
        await saveRuntime({ rewardAckScheduledAt: 0, rewardAcknowledgingUntil: 0 });
      }

      const acknowledgingUntil = Number(runtime.rewardAcknowledgingUntil || 0);
      if (activeAckStartedAt && acknowledgingUntil && now > acknowledgingUntil) {
        await saveRuntime({
          rewardAckStartedAt: 0,
          rewardAckFrameKey: '',
          rewardAckDocumentStartedAt: 0,
          rewardAcknowledgingUntil: 0
        });
        activeAckStartedAt = 0;
        activeAckAge = Infinity;
      }

      // Post-XP watchdog. v0.6.47 accidentally reintroduced a regression here by
      // clearing pendingReward after 30 seconds even while the real «Спасибо.»
      // page was still open. That allowed another frame to display «Иду к Фее» and
      // left the acknowledgement dialog orphaned.
      //
      // New rule: after 30 seconds NEVER skip a visible acknowledgement. The frame
      // that owns the verified «Спасибо.» retries the native click. Other frames
      // keep the transaction locked while the reward-surface heartbeat is fresh.
      if (captured && now - capturedAt >= REWARD_ACK_FAILSAFE_MS) {
        if (capturedThanksHere) {
          if (!activeAckStartedAt) {
            const clicked = await clickRewardThanks('Фея: «Спасибо» висит больше 30 с · повторно подтверждаю');
            if (!clicked) {
              await setStatus('Фея: опыт сохранен · «Спасибо» всё ещё открыто, повторяю подтверждение');
            }
          } else {
            await setStatus('Фея: опыт сохранен · закрываю «Спасибо»');
          }
          scheduleScan(350);
          return;
        }

        const surfaceLastSeenAt = Number(runtime.rewardSurfaceLastSeenAt || 0);
        const rewardSurfaceAliveElsewhere = surfaceLastSeenAt > 0 &&
          now - surfaceLastSeenAt <= REWARD_SURFACE_HEARTBEAT_MS;
        if (rewardSurfaceAliveElsewhere) {
          scheduleScan(300);
          return;
        }

        // Finite terminal path for the opposite failure: XP was captured, but the
        // reward document then disappeared completely and no verified reward/ACK
        // surface has been seen for a long time. Preserve the captured XP and
        // release only the stale transaction after two minutes.
        if (now - capturedAt >= REWARD_CAPTURE_ORPHAN_FAILSAFE_MS) {
          await clearRewardTransaction();
          await setStatus('Фея: опыт сохранен, окно награды исчезло больше чем на 2 мин · освобождаю цикл');
          scheduleScan(350);
          return;
        }

        // Do not let an unrelated frame overwrite the status from the reward frame
        // or open Fairy while we are waiting for the acknowledgement surface.
        scheduleScan(300);
        return;
      }

      if (!rewardSurfaceHere) {
        if (captured) {
          // An unrelated Haddan frame must stay silent while another frame owns
          // the current reward/ACK surface.
        } else if (rewardAge >= 15000) {
          await setStatus(`Фея: нет строки награды для ${runtime.pendingRewardResource || 'ресурса'} ${runtime.pendingRewardQuantity || ''} шт. — «Спасибо» не нажимаю`);
        } else {
          await setStatus('Фея: жду точную строку награды с опытом Жнеца');
        }
        scheduleScan(300);
        return;
      }
    }

    // 5) Resource-choice dialogue is handled by fairy.js using cached market prices.
    //    Reaching it also proves that the previous fight is over, so clear any
    //    stale battle lock as a fallback for layouts without a separate result page.
    if (fairyChoiceVisible(text)) {
      await clearBattleActive();
      await clearBattleExpected();
      await setStatus(settings.collectResources ? (settings.resourceMode === 'experience' ? 'Фея: выбираю ресурс с максимальным опытом' : 'Фея: выбираю самый выгодный ресурс') : 'Фея: жду ручной выбор ресурса');
      scheduleScan(600);
      return;
    }

    // 5) If Fairy asks whether to start gathering, REQUEST the next battle.
    // IMPORTANT: do not set battleActive here. The qa.php click is asynchronous
    // and can be throttled by canClickAgain(). In <=0.6.30 we set battleActive
    // before knowing whether the click was actually scheduled, which could leave
    // the visible «Да, мне нужны новые травы» dialog open forever while every
    // frame reported «жду штатный автобой». battleActive is now set only when a
    // real fight surface is observed above.
    if (readyDialogueVisible(text)) {
      if (runtime.fairyWaitUntil) await saveRuntime({ fairyWaitUntil: 0, fairyWaitKind: '' });

      const start = findQaAction(100, /да.*нужны.*новые\s+травы/i);
      if (start) {
        const frameKey = frameContextKey();
        const sameRequestFrame = runtime.battleStartRequestFrameKey === frameKey;
        const requestAge = now - Number(runtime.battleStartRequestedAt || 0);
        let attempts = sameRequestFrame ? Number(runtime.battleStartAttempts || 0) : 0;

        // A request that is still on the exact same ready page after several
        // seconds did not transition. Allow a bounded native retry instead of
        // turning it into a permanent battle lock.
        if (sameRequestFrame && requestAge > 12000) attempts = 0;

        const clicked = await clickAction(
          start,
          attempts > 0 ? `fairy-start-work-retry-${attempts + 1}` : 'fairy-start-work',
          attempts > 0 ? 'Фея: повторно запускаю сбор' : 'Фея: запускаю следующий сбор',
          450
        );

        if (clicked) {
          const requestedAt = Date.now();
          await saveRuntime({
            battleExpectedUntil: requestedAt + 15000,
            battleStartRequestedAt: requestedAt,
            battleStartRequestFrameKey: frameKey,
            battleStartRequestDocumentStartedAt: DOCUMENT_STARTED_AT,
            battleStartAttempts: attempts + 1,
            battleRecoveryLastClickAt: 0,
            battleRecoveryAttempts: 0
          });
          scheduleScan(700);
          return;
        }

        // Most commonly this means the previous Fairy click is still inside the
        // click-throttle window. Stay on this dialog and retry; do NOT mark a fight
        // active until Haddan actually starts one.
        await setStatus('Фея: готова начать сбор · жду возможность нажать «Да»');
        scheduleScan(350);
        return;
      }
    }

    // 6) Reward confirmation. v0.6.29 deliberately has NO «Спасибо» fallback.
    // We acknowledge only after this exact iframe shows the exact server sentence
    // for the resource/quantity that was just selected. The logs showed that the
    // old 8-second fallback could click a stale «Спасибо.» in another qa.php frame,
    // aborting the genuine reward response before Haddan wrote the NPC XP line.
    const rewardDoc = rewardDocumentState();
    const exactReward = pendingRewardObservation(text);
    const exactThanks = findExactThanksAction();

    if (runtime.pendingReward && rewardDoc.freshDocument && exactReward) {
      await clearBattleExpected();
      let capturedNow = false;
      try {
        if (typeof window.__HMH_CAPTURE_FAIRY_REWARD__ === 'function') {
          capturedNow = !!(await window.__HMH_CAPTURE_FAIRY_REWARD__(text));
        }
      } catch (e) {
        console.warn('[Haddan Market Helper] direct reward capture failed', e);
      }

      const captured = capturedNow || Number(runtime.lastRewardCapturedAt || 0) >= Number(runtime.rewardChoiceAt || 0);
      if (!captured) {
        await setStatus(`Фея: +${exactReward.exp} опыта Жнеца · сохраняю данные`);
        scheduleScan(250);
        return;
      }

      if (!exactThanks) {
        await setStatus(`Фея: +${exactReward.exp} опыта сохранено · жду «Спасибо»`);
        scheduleScan(250);
        return;
      }

      if (!runtime.rewardAckStartedAt) {
        const clicked = await clickRewardThanks(`Фея: +${exactReward.exp} опыта Жнеца · подтверждаю «Спасибо»`);
        if (!clicked) {
          await setStatus(`Фея: +${exactReward.exp} опыта сохранено · жду возможность подтвердить «Спасибо»`);
          scheduleScan(250);
        } else {
          scheduleScan(350);
        }
      } else {
        await setStatus(`Фея: +${exactReward.exp} опыта сохранено · закрываю награду`);
        scheduleScan(350);
      }
      return;
    }

    // The exact reward sentence may disappear before «Спасибо.» appears when
    // Haddan updates qa.php in place. fairy.js already records lastRewardCapturedAt
    // only after seeing the exact resource + quantity + XP sentence for this
    // pending choice. Therefore a captured reward + exact «Спасибо.» in the same
    // iframe is safe to acknowledge even if the sentence is no longer in DOM.
    const capturedReward = Number(runtime.lastRewardCapturedAt || 0) >= Number(runtime.rewardChoiceAt || 0);
    if (runtime.pendingReward && capturedReward && exactThanks &&
        (rewardDoc.sameChoiceFrame || rewardDoc.freshQaAfterChoice)) {
      await clearBattleExpected();

      if (!runtime.rewardAckStartedAt) {
        const clicked = await clickRewardThanks('Фея: опыт сохранен · подтверждаю «Спасибо»');
        if (!clicked) {
          await setStatus('Фея: опыт сохранен · жду возможность подтвердить «Спасибо»');
          scheduleScan(250);
        } else {
          scheduleScan(350);
        }
      } else {
        await setStatus('Фея: опыт сохранен · закрываю награду');
        scheduleScan(350);
      }
      return;
    }

    // If the exact native «Спасибо.» belongs to the current reward document but
    // the XP sentence never appears, do not deadlock forever. Give Haddan 30
    // seconds to render the learnable resource+quantity+XP line; after that,
    // acknowledge the current reward anyway. This intentionally sacrifices only
    // the XP sample for this one cycle, not the whole automation flow.
    if (runtime.pendingReward && exactThanks &&
        (rewardDoc.sameChoiceFrame || rewardDoc.freshQaAfterChoice)) {
      let thanksSeenAt = Number(runtime.rewardThanksSeenAt || 0);
      if (!thanksSeenAt) {
        thanksSeenAt = now;
        await saveRuntime({ rewardThanksSeenAt: thanksSeenAt });
      }

      const thanksAge = now - thanksSeenAt;
      if (thanksAge >= REWARD_MISSING_LINE_THANKS_FAILSAFE_MS) {
        if (!runtime.rewardAckStartedAt) {
          const clicked = await clickRewardThanks(
            `Фея: нет строки награды ${Math.round(REWARD_MISSING_LINE_THANKS_FAILSAFE_MS / 1000)} с · подтверждаю «Спасибо» без записи опыта`
          );
          if (!clicked) {
            await setStatus('Фея: таймаут строки награды · жду возможность подтвердить «Спасибо»');
            scheduleScan(250);
          } else {
            scheduleScan(350);
          }
        } else {
          await setStatus('Фея: таймаут строки награды · закрываю награду без записи опыта');
          scheduleScan(350);
        }
        return;
      }

      const remainingSec = Math.max(1, Math.ceil((REWARD_MISSING_LINE_THANKS_FAILSAFE_MS - thanksAge) / 1000));
      await setStatus(`Фея: нет строки награды для ${runtime.pendingRewardResource || 'ресурса'} ${runtime.pendingRewardQuantity || ''} шт. · «Спасибо» через ${remainingSec} с`);
      scheduleScan(300);
      return;
    }

    if (runtime.pendingReward) {
      await setStatus(`Фея: жду награду за ${runtime.pendingRewardResource || 'ресурс'} ${runtime.pendingRewardQuantity || ''} шт.`);
      scheduleScan(300);
      return;
    }

    // 8) A recent "Продолжить бой" / "начинаю сбор" click means the battle iframe may
    //    still be loading. Other Haddan frames must not use that gap to click Fairy.
    if (runtime.battleExpectedUntil && Date.now() < runtime.battleExpectedUntil) {
      scheduleScan(300);
      return;
    }
    if (runtime.battleExpectedUntil && Date.now() >= runtime.battleExpectedUntil) {
      await clearBattleExpected();
    }

    // Give the expired qa.php frame a moment to close before another frame opens
    // Fairy again. Without this small shared guard an idle frame can race the
    // closing frame and start a second interaction at the same time.
    if (runtime.fairyCooldownTransitionUntil && runtime.fairyCooldownTransitionUntil > now) {
      await setStatus('Фея: таймер завершен, обновляю диалог');
      scheduleScan(Math.min(500, Math.max(120, runtime.fairyCooldownTransitionUntil - now)));
      return;
    }

    // An actionable Fairy resource-choice page is currently open in another
    // frame. Do NOT click Fairy again from idle/chat frames while fairy.js is
    // deciding and submitting the resource. This was the cause of the apparent
    // refresh loop in 0.6.29: the real choice iframe was being replaced before
    // its delayed native click could fire.
    if (runtime.fairyChoiceActiveUntil && runtime.fairyChoiceActiveUntil > now) {
      await setStatus(settings.resourceMode === 'experience'
        ? 'Фея: выбираю ресурс с максимальным опытом'
        : 'Фея: выбираю самый выгодный ресурс');
      scheduleScan(250);
      return;
    }

    // 9) Outside battle/dialogue/cooldown, open Fairy again and continue the FSM.
    const fairy = findFairyTrigger();
    if (fairy) {
      await clickAction(fairy, `fairy:${relativeHref(fairy) || elementLabel(fairy)}`, 'Иду к Фее', 450);
      return;
    }

    if (window.top === window) {
      await setStatus('Бот активен: ожидаю событие');
    }
    scheduleScan(900);
  }

  function scheduleScan(delay = 120) {
    if (scanTimer) return;
    scanTimer = setTimeout(scanAutomation, delay);
  }

  document.addEventListener('click', captureClick, true);

  const observer = new MutationObserver(() => {
    mutationVersion += 1;
    scheduleScan(140);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[AUTOMATION_KEY]?.newValue) {
      settings = normalizeAutomation(changes[AUTOMATION_KEY].newValue || {});
    }
    if (changes[BOT_RUNTIME_KEY]?.newValue) {
      runtime = normalizeRuntime(changes[BOT_RUNTIME_KEY].newValue || {});
    }
    scheduleScan(60);
  });

  (async () => {
    try {
      const stored = await chrome.storage.local.get([AUTOMATION_KEY, BOT_RUNTIME_KEY, REAPER_PROFILE_KEY]);
      settings = normalizeAutomation(stored[AUTOMATION_KEY] || {}, stored[REAPER_PROFILE_KEY]?.rank || '');

      const storedRuntime = stored[BOT_RUNTIME_KEY] || {};
      runtime = normalizeRuntime(storedRuntime);

      // v0.6.19 removes the extension's own combat automation. Clean legacy
      // skill/turn fields once; normal frame startup must not rewrite shared runtime.
      const legacyAutomationKeys = ['autoBattle', 'captureSkill', 'selectedSkill', 'captureSkillMode', 'selectedSkillMode', 'autoFairy'];
      const legacyRuntimeKeys = ['turnState', 'turnSkillSelectedAt', 'turnSubmittedAt', 'turnRetryAttempts', 'turnDocumentId', 'turnBaselineRound', 'turnBaselineSubmitLabel', 'turnBaselineFingerprint'];
      const rawAutomation = stored[AUTOMATION_KEY] || {};
      const hasLegacyAutomation = legacyAutomationKeys.some((key) => Object.prototype.hasOwnProperty.call(rawAutomation, key));
      const missingResourceSettings = !Object.prototype.hasOwnProperty.call(rawAutomation, 'collectResources') ||
        !Object.prototype.hasOwnProperty.call(rawAutomation, 'resourceMode') ||
        !Object.prototype.hasOwnProperty.call(rawAutomation, 'reaperRank') ||
        !Object.prototype.hasOwnProperty.call(rawAutomation, 'solveCaptcha') ||
        !Object.prototype.hasOwnProperty.call(rawAutomation, 'captchaApiToken');
      const hasLegacyRuntime = legacyRuntimeKeys.some((key) => Object.prototype.hasOwnProperty.call(storedRuntime, key));
      if (hasLegacyAutomation || missingResourceSettings || hasLegacyRuntime) {
        await chrome.storage.local.set({
          [AUTOMATION_KEY]: settings,
          [BOT_RUNTIME_KEY]: runtime
        });
      }

      // One-time migration from <=0.6.17. That version could rebase a finished
      // cooldown from the frozen timer text in the same qa.php page. We cannot
      // know whether a stored deadline is the original wait or the accidental
      // second wait, so force one clean server resync: mark all currently loaded
      // documents stale and close/reopen Fairy. A fresh page can then report the
      // real remaining cooldown (if any).
      if (Number(storedRuntime.fairyCooldownLogicVersion || 0) < 3) {
        await saveRuntime({
          fairyCooldownLogicVersion: 3,
          fairyWaitUntil: 0,
          fairyWaitKind: '',
          fairyCooldownMinDocumentStartedAt: Date.now(),
          fairyCooldownTransitionUntil: Date.now() + 2500
        });
      }

      // v0.6.31 fixes a premature fight lock introduced by the resource-only
      // workflow. <=0.6.30 could set battleActive before the «Да...» click was
      // actually scheduled. On upgrade, release that possibly-stale lock once.
      // If a real fight is currently open, its own frame will immediately set
      // battleActive again on the next scan.
      if (Number(storedRuntime.battleStartLogicVersion || 0) < 2) {
        await saveRuntime({
          battleStartLogicVersion: 2,
          battleExpectedUntil: 0,
          battleStartRequestedAt: 0,
          battleStartRequestFrameKey: '',
          battleStartRequestDocumentStartedAt: 0,
          battleStartAttempts: 0,
          battleActive: false,
          battleRecoveryLastClickAt: 0,
          battleRecoveryAttempts: 0
        });
      }

      // v0.6.52 restores the strict reward transaction lock and adds a verified
      // reward-surface heartbeat. Clear only the ACK substate once on upgrade;
      // keep pendingReward and captured XP intact so an already-open «Спасибо.»
      // can be recovered immediately.
      if (Number(storedRuntime.rewardAckLogicVersion || 0) < 4) {
        await saveRuntime({
          rewardAckLogicVersion: 4,
          rewardAckScheduledAt: 0,
          rewardAckStartedAt: 0,
          rewardAckFrameKey: '',
          rewardAckDocumentStartedAt: 0,
          rewardAcknowledgingUntil: 0,
          rewardSurfaceLastSeenAt: 0
        });
      }
    } catch (_) {}
    scheduleScan(100);
  })();
})();


