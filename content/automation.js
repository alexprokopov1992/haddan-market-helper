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
  const DOCUMENT_STARTED_AT = Date.now();
  let captchaSolveInFlight = false;
  let lastCaptchaDecode = null;
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
    const response = await chrome.runtime.sendMessage({
      type: 'HMH_CAPTCHA_DECODE',
      imageDataUrl,
      token
    });

    debugLog('[Haddan Market Helper] CAPTCHA API response received by content script:', response);

    if (!response?.ok) throw new Error(String(response?.error || 'captcha-api-failed'));
    if (!Array.isArray(response.runes) || response.runes.length === 0) throw new Error('captcha-api-empty-runes');
    return response.runes;
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

      await setCaptchaStatus('api', 'CAPTCHA: отправляю изображение в API…', { progress: 30 });
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
      await setCaptchaStatus('error', `CAPTCHA: ошибка — ${reason}`, { progress: 0, detail: `Автоматическое решение не завершено: ${reason}. Можно ввести руны вручную.` });
      return { ok: false, stage: 'error', error: reason };
    } finally {
      captchaSolveInFlight = false;
    }
  }

  async function resetTransientBattleAfterCaptcha() {
    lastCaptchaDecode = null;
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
    return /тебе\s+нужны\s+новые\s+травы\s*,?\s*жнец/i.test(text);
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
    return /\b[^\n]{0,80}->\s*\*?Фея\s+Поляныnpc\*?\s*спасибо[.!]?/i.test(text) ||
      /\bспасибо[.!]?[\s\S]{0,260}?я\s+дам\s+тебе\s+\d+\s*(?:ед\.?|шт\.?)/i.test(text);
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
    return /сейчас\s+пока\s+нет\s+для\s+тебя\s+работы/i.test(text);
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

    // Some old Haddan pages split a single visual action into several <a> tags
    // with the same qa.php?id. Prefer the one whose label actually matches.
    if (textRe) {
      const labeledById = byId.find((el) => textRe.test(elementLabel(el)));
      if (labeledById) return labeledById;
    }
    if (byId.length) return byId[0];
    if (textRe) return links.find((el) => textRe.test(elementLabel(el))) || null;
    return null;
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
    if (!choiceAt) return { choiceAt: 0, age: Infinity, freshDocument: false, sameChoiceFrame: false, captured: false };
    const age = Date.now() - choiceAt;
    const choiceDocumentStartedAt = Number(runtime.rewardChoiceDocumentStartedAt || 0);
    const expectedFrame = String(runtime.rewardChoiceFrameKey || '');
    const sameChoiceFrame = !expectedFrame || expectedFrame === frameContextKey();
    // Time alone is not enough: several Haddan qa.php iframes can be alive at once.
    // The reward must arrive in the exact iframe/browsing context that submitted
    // the resource choice. This prevents a stale «Спасибо.» from another frame
    // from cancelling the real reward response.
    const freshDocument = sameChoiceFrame &&
      DOCUMENT_STARTED_AT >= Math.max(choiceAt - 250, choiceDocumentStartedAt);
    const capturedAt = Number(runtime.lastRewardCapturedAt || 0);
    const captured = capturedAt >= choiceAt;
    return { choiceAt, age, freshDocument, sameChoiceFrame, captured };
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
    if (!el || !canClickAgain(key)) return false;
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
    return true;
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
        requestCaptchaAlertSound();
        if (settings.solveCaptcha) captchaHookResult = await captchaIntegrationHook();
      }

      if (!settings.solveCaptcha) {
        await setCaptchaStatus('manual', 'CAPTCHA: ручной режим — введи руны вручную', { progress: 0 });
      } else if (!settings.captchaApiToken) {
        await setCaptchaStatus('manual', 'CAPTCHA: API token не задан — нужен ручной ввод', { progress: 0 });
      } else if (captchaHookResult?.stage === 'challenge-changed') {
        await setCaptchaStatus('error', 'CAPTCHA: изображение изменилось во время запроса', { progress: 0, detail: 'Challenge сменился до применения ответа. Введи текущие руны вручную.' });
      } else if (captchaHookResult?.stage === 'challenge-gone') {
        await setCaptchaStatus('waiting', 'CAPTCHA: проверка уже исчезла, жду обновление состояния…', { progress: 98 });
      } else if (captchaHookResult?.stage === 'apply-failed') {
        await setCaptchaStatus('error', 'CAPTCHA: не удалось применить распознанные руны', { progress: 0, detail: 'API ответ получен, но ввод на странице не подтвердился. Можно завершить CAPTCHA вручную.' });
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

    // 0) Haddan can show this guard page when the user/NPC navigation happens while
    //    a fight is still active. Return to the fight before processing any Fairy state.
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
      if (runtime.fairyWaitUntil) await saveRuntime({ fairyWaitUntil: 0 });
      await clickAction(battleReturn, 'battle-return', 'Бой завершен: возвращаюсь с Поляны', 180);
      return;
    }

    // 1) A real battle always wins over any stale Fairy runtime state. This is also
    //    important because automation.js runs in several Haddan frames.
    const battleVisible = battleInterfaceVisible(text);
    if (battleVisible) {
      if (runtime.fairyWaitUntil) await saveRuntime({ fairyWaitUntil: 0 });
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
      await setStatus('Бой: активен, жду штатный автобой/результат');
      scheduleScan(500);
      return;
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
        const sameChoiceFrame = !runtime.rewardChoiceFrameKey || runtime.rewardChoiceFrameKey === frameContextKey();
        const freshAfterAck = ackStartedAt && sameChoiceFrame && DOCUMENT_STARTED_AT >= ackStartedAt - 250;
        // If the user manually clicked «Спасибо.», there is no rewardAckStartedAt.
        // A new cooldown document in the SAME iframe after the choice is enough to
        // recover the FSM without letting an unrelated stale iframe release it.
        const manualAckAfterChoice = !ackStartedAt && sameChoiceFrame &&
          DOCUMENT_STARTED_AT >= Number(runtime.rewardChoiceAt || 0) - 250;
        if (!freshAfterAck && !manualAckAfterChoice) {
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
          await saveRuntime({ fairyWaitUntil: Date.now() + waitMs + 1200 });
        }

        const remaining = Math.max(0, (runtime.fairyWaitUntil || 0) - Date.now());
        if (remaining > 0) {
          await setStatus(`Фея: ждать ${formatCountdown(remaining)}`);
          scheduleScan(1000);
          return;
        }
      }

      // Unknown timer format: remain in the current dialogue. Never fall through to
      // "Иду к Фее" while the cooldown message is visibly open.
      await setStatus('Фея: вижу таймер, не удалось разобрать время');
      scheduleScan(600);
      return;
    }

    // 3) A future Fairy deadline is a GLOBAL lock shared by all Haddan frames.
    //    This prevents an idle/chat frame from clicking Fairy or an old "Спасибо"
    //    while another frame is legitimately waiting for the cooldown.
    if (runtime.fairyWaitUntil && runtime.fairyWaitUntil > now) {
      await setStatus(`Фея: ждать ${formatCountdown(runtime.fairyWaitUntil - now)}`);
      scheduleScan(1000);
      return;
    }
    if (runtime.fairyWaitUntil && runtime.fairyWaitUntil <= now) {
      await saveRuntime({ fairyWaitUntil: 0 });
    }

    // A reward choice is a GLOBAL transaction across all Haddan frames. While it
    // is open, stale ready/choice/chat frames are forbidden from talking to the
    // Fairy. The only frames allowed through are the current reward response
    // (XP text / «Спасибо.») handled below. v0.6.27 released this lock as soon as
    // XP was parsed, leaving a race where another frame could show «Иду к Фее»
    // before «Спасибо.» had completed.
    if (runtime.pendingReward) {
      const pendingRewardDoc = rewardDocumentState();
      const exactThanksHere = findExactThanksAction();
      const captured = Number(runtime.lastRewardCapturedAt || 0) >= Number(runtime.rewardChoiceAt || 0);
      const rewardAge = now - Number(runtime.pendingRewardSince || now);

      // Recovery for the case where Haddan accepted «Спасибо.» and closed the
      // reward iframe before this frame could observe the post-ACK transition.
      // We only release after XP capture, so an unrecorded reward is still protected.
      if (captured && (rewardAckEchoVisible(text) || (rewardAge >= 5000 && likelyIdlePolianaAfterReward()))) {
        await clearRewardTransaction();
        scheduleScan(250);
        return;
      }

      if (captured && rewardAge >= 30000) {
        await clearRewardTransaction();
        await setStatus('Фея: опыт сохранен · таймаут ожидания «Спасибо», возобновляю цикл');
        scheduleScan(250);
        return;
      }

      // Normal case: a new reward document appeared after the choice.
      // Haddan can also update the SAME qa.php document in place. In that case
      // DOCUMENT_STARTED_AT predates rewardChoiceAt, so freshDocument stays false
      // forever even though fairy.js has already captured the exact matching
      // reward sentence. Once that exact reward is captured, an exact «Спасибо.»
      // in the same iframe is safe evidence of the current transaction.
      const rewardSurfaceHere =
        (pendingRewardDoc.freshDocument &&
          (rewardConfirmationVisible(text) || !!exactThanksHere)) ||
        (captured && pendingRewardDoc.sameChoiceFrame && !!exactThanksHere);

      // If an acknowledgement was scheduled but the page never transitioned,
      // release only the ACK sub-lock and let the same verified reward retry.
      // pendingReward itself remains intact, so no stale frame can start a new cycle.
      const acknowledgingUntil = Number(runtime.rewardAcknowledgingUntil || 0);
      if (runtime.rewardAckStartedAt && acknowledgingUntil && now > acknowledgingUntil) {
        await saveRuntime({ rewardAckStartedAt: 0, rewardAcknowledgingUntil: 0 });
      }

      // Some servers can transition directly to a fresh ready page after the
      // acknowledgement. Accept that only from a document created after the ACK.
      const ackStartedAt = Number(runtime.rewardAckStartedAt || 0);
      const freshPostAckReady = ackStartedAt &&
        DOCUMENT_STARTED_AT >= ackStartedAt - 250 &&
        readyDialogueVisible(text);
      if (freshPostAckReady) {
        await clearRewardTransaction();
      } else if (!rewardSurfaceHere) {
        if (captured) {
          await setStatus(runtime.rewardAckStartedAt
            ? 'Фея: опыт сохранен · жду перехода после «Спасибо»'
            : 'Фея: опыт сохранен · жду «Спасибо» в окне награды');
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
      if (runtime.fairyWaitUntil) await saveRuntime({ fairyWaitUntil: 0 });

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
        // Keep the real Haddan reward page visible for a moment. This gives the
        // game's own chat/log enough time to record the Fairy NPC message before
        // the acknowledgement navigates the iframe away. Mark ACK as started only
        // after clickAction actually accepted/scheduled the click; otherwise a
        // temporary click-throttle could create a permanent ACK deadlock.
        const clicked = await clickAction(
          exactThanks,
          'fairy-thanks-exact-reward',
          `Фея: +${exactReward.exp} опыта Жнеца · опыт сохранен`,
          1800
        );
        if (clicked) {
          const ackStartedAt = Date.now();
          await saveRuntime({
            rewardAckStartedAt: ackStartedAt,
            rewardAcknowledgingUntil: ackStartedAt + 12000
          });
        } else {
          await setStatus(`Фея: +${exactReward.exp} опыта сохранено · жду возможность подтвердить «Спасибо»`);
          scheduleScan(350);
        }
      } else {
        await setStatus(`Фея: +${exactReward.exp} опыта сохранено · закрываю награду`);
      }
      return;
    }

    // The exact reward sentence may disappear before «Спасибо.» appears when
    // Haddan updates qa.php in place. fairy.js already records lastRewardCapturedAt
    // only after seeing the exact resource + quantity + XP sentence for this
    // pending choice. Therefore a captured reward + exact «Спасибо.» in the same
    // iframe is safe to acknowledge even if the sentence is no longer in DOM.
    const capturedReward = Number(runtime.lastRewardCapturedAt || 0) >= Number(runtime.rewardChoiceAt || 0);
    if (runtime.pendingReward && capturedReward && exactThanks && rewardDoc.sameChoiceFrame) {
      await clearBattleExpected();

      if (!runtime.rewardAckStartedAt) {
        const clicked = await clickAction(
          exactThanks,
          'fairy-thanks-captured-reward',
          `Фея: опыт сохранен · подтверждаю «Спасибо»`,
          650
        );
        if (clicked) {
          const ackStartedAt = Date.now();
          await saveRuntime({
            rewardAckStartedAt: ackStartedAt,
            rewardAcknowledgingUntil: ackStartedAt + 12000
          });
        } else {
          await setStatus('Фея: опыт сохранен · жду возможность подтвердить «Спасибо»');
          scheduleScan(350);
        }
      } else {
        await setStatus('Фея: опыт сохранен · закрываю награду');
      }
      return;
    }

    // A «Спасибо.» without a previously captured matching reward sentence is
    // still treated as unsafe. Never auto-click it.
    // Never auto-click it. This is intentionally conservative: START/STOP or a
    // manual click can recover, but the plugin will not sacrifice the XP record.
    if (runtime.pendingReward && exactThanks && rewardDoc.sameChoiceFrame) {
      await setStatus(`Фея: вижу «Спасибо», но нет строки «Я дам тебе ${runtime.pendingRewardQuantity || '?'} ед. ${runtime.pendingRewardResource || 'ресурса'}…» — жду`);
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
      if (Number(storedRuntime.fairyCooldownLogicVersion || 0) < 2) {
        await saveRuntime({
          fairyCooldownLogicVersion: 2,
          fairyWaitUntil: 0,
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
    } catch (_) {}
    scheduleScan(100);
  })();
})();


