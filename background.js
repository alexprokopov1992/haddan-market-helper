importScripts('content/shared.js');

'use strict';

const REAPER_MODEL_RECALC_VERSION = '0.6.66-dual-universal-20260921';

function reaperModelFields(sample) {
  const shared = globalThis.HMH_SHARED;
  if (!shared) return null;

  const expected = shared.expectedProfessionalExpDetails(sample?.resourceId, sample?.quantity, sample?.rankKey);
  const universal = shared.universalExpectedProfessionalExpDetails(sample?.resourceId, sample?.quantity, sample?.rankKey);

  return {
    expectedExp: expected?.value ?? null,
    expectedExpMin: expected?.min ?? null,
    expectedExpMax: expected?.max ?? null,
    expectedChanceUp: expected?.chanceUp ?? null,
    universalExpectedExp: universal?.value ?? null,
    universalExpectedExpMin: universal?.min ?? null,
    universalExpectedExpMax: universal?.max ?? null,
    chanseUp: universal?.chanceUp ?? null
  };
}

async function recalculateStoredReaperModels() {
  const shared = globalThis.HMH_SHARED;
  if (!shared?.STORAGE_KEYS?.reaperExp) return false;

  const key = shared.STORAGE_KEYS.reaperExp;
  const stored = await chrome.storage.local.get(key);
  const current = stored[key];
  if (!current || !Array.isArray(current.samples)) return false;
  if (current.modelRecalcVersion === REAPER_MODEL_RECALC_VERSION) return false;

  const samples = current.samples.map((sample) => {
    const fields = reaperModelFields(sample);
    return fields ? { ...sample, ...fields } : sample;
  });

  await chrome.storage.local.set({
    [key]: {
      ...current,
      samples,
      modelRecalcVersion: REAPER_MODEL_RECALC_VERSION
    }
  });
  return true;
}

// Run once for this model revision as soon as the MV3 worker starts. This makes
// historical samples consistent even if the user never opens a Fairy page.
recalculateStoredReaperModels().catch((error) => {
  console.warn('[Haddan Market Helper] Reaper model backfill failed', error);
});

chrome.runtime.onInstalled.addListener(() => {
  recalculateStoredReaperModels().catch((error) => {
    console.warn('[Haddan Market Helper] Reaper model install backfill failed', error);
  });
});

let creatingOffscreen = null;
const captchaAlertByTab = new Map();
const reloadByTab = new Map();
const DEBUG_LOGS = false;

function debugLog(...args) {
  if (DEBUG_LOGS) console.log(...args);
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.some((ctx) => ctx.documentUrl?.endsWith('/offscreen.html'));
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return true;
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play a short alert when Haddan shows a CAPTCHA and automation pauses.'
  }).then(() => true).catch((error) => {
    console.warn('[Haddan Market Helper] offscreen document failed', error);
    return false;
  }).finally(() => {
    creatingOffscreen = null;
  });

  return creatingOffscreen;
}

async function playCaptchaSound() {
  const ready = await ensureOffscreenDocument();
  if (!ready) return false;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'HMH_OFFSCREEN_CAPTCHA_SOUND' });
    return !!response?.ok;
  } catch (error) {
    console.warn('[Haddan Market Helper] offscreen sound message failed', error);
    return false;
  }
}

const CAPTCHA_API_URL = 'https://runes.spravahub.com.ua/decode';
const CAPTCHA_API_TIMEOUT_MS = 15000;

function dataUrlToBlob(dataUrl) {
  const value = String(dataUrl || '');
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  if (!match) throw new Error('invalid-image-data-url');

  const mime = match[1];
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function validateCaptchaDecodeResponse(data) {
  if (!data || typeof data !== 'object') throw new Error('invalid-json');
  if (data.result !== true) throw new Error('decode-result-false');
  if (!Array.isArray(data.runes) || data.runes.length === 0) throw new Error('empty-runes');

  const runes = data.runes.map((value) => Number(value));
  if (runes.some((value) => !Number.isInteger(value) || value < 1 || value > 9)) {
    throw new Error('invalid-rune-range');
  }
  return runes;
}

async function decodeCaptchaImage(imageDataUrl, token) {
  const apiToken = String(token || '').trim();
  if (!apiToken) throw new Error('missing-api-token');

  const imageBlob = dataUrlToBlob(imageDataUrl);
  const form = new FormData();
  form.append('image', imageBlob, 'captcha.png');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CAPTCHA_API_TIMEOUT_MS);

  try {
    const response = await fetch(CAPTCHA_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
      signal: controller.signal
    });

    const rawBody = await response.text();
    debugLog('[Haddan Market Helper] CAPTCHA API raw response:', {
      status: response.status,
      ok: response.ok,
      body: rawBody
    });

    if (!response.ok) throw new Error(`http-${response.status}`);

    let data;
    try {
      data = JSON.parse(rawBody);
    } catch (_) {
      throw new Error('invalid-json');
    }

    debugLog('[Haddan Market Helper] CAPTCHA API parsed response:', data);
    return validateCaptchaDecodeResponse(data);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('api-timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === 'HMH_CAPTCHA_DECODE') {
    const senderUrl = String(sender.url || sender.tab?.url || '');
    if (!/^https:\/\/(?:www\.|ru\.)?haddan\.ru\//i.test(senderUrl)) {
      sendResponse?.({ ok: false, error: 'invalid-sender' });
      return;
    }

    decodeCaptchaImage(message.imageDataUrl, message.token).then((runes) => {
      sendResponse?.({ ok: true, runes });
    }).catch((error) => {
      // Never include the token or request headers in logs/responses.
      const reason = String(error?.message || error || 'decode-failed');
      console.warn('[Haddan Market Helper] CAPTCHA API request failed:', reason);
      sendResponse?.({ ok: false, error: reason });
    });
    return true;
  }

  if (message.type === 'HMH_RELOAD_TAB') {
    const senderUrl = String(sender.url || sender.tab?.url || '');
    const tabId = sender.tab?.id;
    if (!/^https:\/\/(?:www\.|ru\.)?haddan\.ru\//i.test(senderUrl) || tabId == null) {
      sendResponse?.({ ok: false, error: 'invalid-sender' });
      return;
    }

    const now = Date.now();
    const last = Number(reloadByTab.get(tabId) || 0);
    if (now - last < 10000) {
      sendResponse?.({ ok: true, reloaded: false, deduped: true });
      return;
    }
    reloadByTab.set(tabId, now);

    chrome.tabs.reload(tabId).then(() => {
      sendResponse?.({ ok: true, reloaded: true });
    }).catch((error) => {
      reloadByTab.delete(tabId);
      sendResponse?.({ ok: false, error: String(error?.message || error) });
    });
    return true;
  }

  if (message.type === 'HMH_CAPTCHA_ALERT') {
    const tabId = sender.tab?.id;
    const now = Date.now();
    const last = tabId == null ? 0 : Number(captchaAlertByTab.get(tabId) || 0);

    // Several Haddan frames run the same content script. Deduplicate the audible
    // alert at tab level so one CAPTCHA produces one short signal, not a chorus.
    if (tabId != null && now - last < 10000) {
      sendResponse?.({ ok: true, played: false, deduped: true });
      return;
    }
    if (tabId != null) captchaAlertByTab.set(tabId, now);

    playCaptchaSound().then((played) => {
      sendResponse?.({ ok: true, played });
    }).catch((error) => {
      sendResponse?.({ ok: false, error: String(error) });
    });
    return true;
  }

  if (message.type !== 'HMH_MAIN_WORLD_CLICK') return;

  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  const token = String(message.token || '');

  if (tabId == null || frameId == null || !token) {
    sendResponse?.({ ok: false, error: 'missing-target' });
    return;
  }

  chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: (clickToken) => {
      const selector = `[data-hmh-main-click="${CSS.escape(clickToken)}"]`;
      const el = document.querySelector(selector);
      if (!el) return { ok: false, error: 'element-not-found' };

      try {
        el.removeAttribute('data-hmh-main-click');
        el.click();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    args: [token]
  }).then((results) => {
    sendResponse?.(results?.[0]?.result || { ok: false, error: 'no-result' });
  }).catch((error) => {
    sendResponse?.({ ok: false, error: String(error?.message || error) });
  });

  return true;
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  captchaAlertByTab.delete(tabId);
  reloadByTab.delete(tabId);
});
