(() => {
  'use strict';

  if (window.__HMH_FAIRY_HELPER__) return;
  window.__HMH_FAIRY_HELPER__ = true;

  const {
    STORAGE_KEYS,
    RESOURCES,
    DEFAULT_AUTOMATION,
    MAX_REAPER_EXP,
    normalizeText,
    reaperProgress,
    normalizeAutomation,
    validReaperExp,
    expectedProfessionalExp,
    universalExpectedProfessionalExpDetails,
    sampleWeight,
    weightedMedian
  } = window.HMH_SHARED;
  const STORAGE_KEY = STORAGE_KEYS.market;
  const AUTOMATION_KEY = STORAGE_KEYS.automation;
  const BOT_STATUS_KEY = STORAGE_KEYS.botStatus;
  const BOT_RUNTIME_KEY = STORAGE_KEYS.botRuntime;
  const FAIRY_OFFERS_KEY = STORAGE_KEYS.fairyOffers;
  const REAPER_EXP_KEY = STORAGE_KEYS.reaperExp;
  const REAPER_PROFILE_KEY = STORAGE_KEYS.reaperProfile;
  const FAIRY_MARKER_RE = /(фея\s+поляны|могу\s+дать\s+тебе\s+следующие\s+травы|выбери\s+себе)/i;
  const DOCUMENT_STARTED_AT = Date.now();
  const MAX_REAPER_EXP_RECORDS = 5000;
  let automation = { ...DEFAULT_AUTOMATION };
  let runtime = { pauseReason: '' };
  let market = { updatedAt: null, data: {} };
  let lastAutoChoiceKey = '';
  let lastAutoChoiceAt = 0;
  let scanTimer = null;
  let lastRenderKey = '';
  let storageReady = false;
  let reaperExp = { samples: [] };
  let reaperProfile = null;
  let lastPublishedOfferKey = '';
  let lastRewardObservationKey = '';
  let overlayHost = null;
  let overlayRoot = null;
  let overlayStyle = null;
  let rewardBaselineFull = new Map();
  let rewardBaselineExp = new Map();
  let rewardBaselineArmed = false;

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  function formatNumber(value, digits = 2) {
    if (!Number.isFinite(Number(value))) return '—';
    return Number(value).toLocaleString('ru-RU', { maximumFractionDigits: digits });
  }

  function formatAge(ts) {
    if (!ts) return 'цены не обновлялись';
    const ageMs = Math.max(0, Date.now() - ts);
    const minutes = Math.floor(ageMs / 60000);
    if (minutes < 1) return 'цены только что обновлены';
    if (minutes < 60) return `цены ${minutes} мин. назад`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `цены ${hours} ч. назад`;
    return `цены ${Math.floor(hours / 24)} дн. назад`;
  }

  function extractOffers(text) {
    const src = normalizeText(text);
    const found = [];

    for (const resource of RESOURCES) {
      let quantity = null;

      for (const alias of resource.aliases) {
        const re = new RegExp(`${escapeRegExp(alias)}\\s*[-–—:]?\\s*(\\d[\\d\\s]*)\\s*(?:шт\\.?|ед\\.?)`, 'i');
        const match = src.match(re);
        if (match) {
          quantity = Number(match[1].replace(/\s+/g, ''));
          break;
        }
      }

      if (Number.isFinite(quantity) && quantity > 0) {
        found.push({
          resourceId: resource.id,
          resourceName: resource.name,
          aliases: resource.aliases,
          quantity
        });
      }
    }

    return found;
  }

  function profileRankKey() {
    return normalizeText(reaperProfile?.rank || automation.reaperRank || '').toLowerCase() || 'unknown';
  }

  function addExpectedExpToSamples(raw) {
    const source = raw && typeof raw === 'object' ? raw : { samples: [] };
    const samples = Array.isArray(source.samples) ? source.samples : [];
    let changed = false;
    const enriched = samples.map((item) => {
      const expectedExp = expectedProfessionalExp(item?.resourceId, item?.quantity, item?.rankKey);
      const universal = universalExpectedProfessionalExpDetails(item?.resourceId, item?.quantity, item?.rankKey);
      const universalExpectedExp = universal?.value ?? null;
      const universalExpectedExpMin = universal?.min ?? null;
      const universalExpectedExpMax = universal?.max ?? null;
      const chanseUp = universal?.chanceUp ?? null;
      const hasExpectedExp = Object.prototype.hasOwnProperty.call(item || {}, 'expectedExp');
      const hasUniversalExpectedExp = Object.prototype.hasOwnProperty.call(item || {}, 'universalExpectedExp');
      const hasUniversalExpectedExpMin = Object.prototype.hasOwnProperty.call(item || {}, 'universalExpectedExpMin');
      const hasUniversalExpectedExpMax = Object.prototype.hasOwnProperty.call(item || {}, 'universalExpectedExpMax');
      const hasChanseUp = Object.prototype.hasOwnProperty.call(item || {}, 'chanseUp');
      if (hasExpectedExp && item.expectedExp === expectedExp &&
          hasUniversalExpectedExp && item.universalExpectedExp === universalExpectedExp &&
          hasUniversalExpectedExpMin && item.universalExpectedExpMin === universalExpectedExpMin &&
          hasUniversalExpectedExpMax && item.universalExpectedExpMax === universalExpectedExpMax &&
          hasChanseUp && item.chanseUp === chanseUp) {
        return item;
      }
      changed = true;
      return {
        ...item,
        expectedExp,
        universalExpectedExp,
        universalExpectedExpMin,
        universalExpectedExpMax,
        chanseUp
      };
    });

    if (!changed) return { value: source, changed: false };
    return { value: { ...source, samples: enriched }, changed: true };
  }

  function samplesFor(resourceId) {
    const rankKey = profileRankKey();
    const samples = Array.isArray(reaperExp?.samples) ? reaperExp.samples : [];
    let matching = samples.filter((sample) => sample.resourceId === resourceId && sample.rankKey === rankKey);
    // Until the rank is known, use only observations collected while it was also unknown.
    if (!matching.length && rankKey === 'unknown') {
      matching = samples.filter((sample) => sample.resourceId === resourceId && (!sample.rankKey || sample.rankKey === 'unknown'));
    }
    return matching;
  }


  function exactExperienceSummary(samples, quantity) {
    const counts = new Map();
    let total = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const sample of samples) {
      if (Number(sample.quantity) !== Number(quantity)) continue;
      const exp = validReaperExp(sample.exp);
      if (exp == null) continue;
      const weight = sampleWeight(sample);
      counts.set(exp, (counts.get(exp) || 0) + weight);
      total += weight;
      min = Math.min(min, exp);
      max = Math.max(max, exp);
    }
    if (!counts.size) return null;

    // Same rank + resource + quantity should normally be deterministic. If old
    // observations disagree, keep all of them but use the most frequently seen
    // server value for automatic decisions.
    const value = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    return { value, min, max, exact: true, samples: total };
  }

  function predictProfessionalExp(resourceId, quantity) {
    const samples = samplesFor(resourceId);
    if (!samples.length || !Number.isFinite(quantity) || quantity <= 0) return null;

    // Primary knowledge base: exact empirical mapping
    // (profession rank, resource, quantity) -> observed XP.
    const exact = exactExperienceSummary(samples, quantity);
    if (exact) return exact;

    // For an unseen quantity keep the old approximate hint, but it is explicitly
    // an estimate derived only from this same resource/rank. Never allow a
    // prediction above Haddan's hard cap of 10 profession XP.
    const ratios = samples
      .map((sample) => {
        const exp = validReaperExp(sample.exp);
        const qty = Number(sample.quantity);
        return { value: exp != null && qty > 0 ? exp / qty : NaN, weight: sampleWeight(sample) };
      })
      .filter((entry) => Number.isFinite(entry.value));
    const ratio = weightedMedian(ratios);
    if (ratio == null) return null;
    return {
      value: Math.min(MAX_REAPER_EXP, Math.max(0, Math.round(quantity * ratio))),
      min: null,
      max: null,
      exact: false,
      samples: ratios.reduce((sum, entry) => sum + entry.weight, 0)
    };
  }

  function expDisplay(prediction) {
    if (!prediction) return 'опыт ?';
    if (prediction.exact && prediction.min !== prediction.max) {
      return `опыт ${formatNumber(prediction.min, 0)}–${formatNumber(prediction.max, 0)}`;
    }
    return `${prediction.exact ? 'опыт' : 'опыт ≈'}${formatNumber(prediction.value, 0)}`;
  }

  async function publishFairyOffers(offers) {
    const signature = offers.map((o) => `${o.resourceId}:${o.quantity}`).sort().join('|');
    if (!signature || signature === lastPublishedOfferKey) return;
    lastPublishedOfferKey = signature;
    try {
      await chrome.storage.local.set({
        [FAIRY_OFFERS_KEY]: {
          updatedAt: Date.now(),
          rankKey: profileRankKey(),
          offers: offers.map((offer) => ({
            resourceId: offer.resourceId,
            resourceName: offer.resourceName,
            quantity: offer.quantity
          }))
        }
      });
    } catch (_) {}
  }

  function parseProfessionalExp(text) {
    const src = normalizeText(text);
    const patterns = [
      /(?:ты\s+)?получа(?:ешь|ешься|л|ла|ете|ют|ется)\s*\+?(\d+)\s+опыт(?:а)?\s+жнеца/gi,
      /\+?(\d+)\s+опыт(?:а)?\s+жнеца/gi,
      /опыт(?:а)?\s+жнеца\s*[:+—-]?\s*(\d+)/gi
    ];
    const values = [];
    for (const re of patterns) {
      for (const match of src.matchAll(re)) values.push({ value: Number(match[1]), index: match.index || 0 });
      if (values.length) break;
    }
    if (!values.length) return null;
    values.sort((a, b) => a.index - b.index);
    return values[values.length - 1].value;
  }

  function rewardSignature(observation) {
    return `${observation.resourceId}|${observation.quantity}|${observation.exp}`;
  }

  function countBy(items, keyFn) {
    const out = new Map();
    for (const item of items) {
      const key = keyFn(item);
      out.set(key, (out.get(key) || 0) + 1);
    }
    return out;
  }

  function extractRewardObservations(text) {
    const src = normalizeText(text);
    const found = [];
    for (const resource of RESOURCES) {
      for (const alias of resource.aliases) {
        const re = new RegExp(
          `я\\s+дам\\s+тебе\\s+(\\d[\\d\\s]*)\\s*(?:ед\\.?|шт\\.?)?\\s*${escapeRegExp(alias)}[\\s\\S]{0,240}?(\\d+)\\s+опыт(?:а)?\\s+жнеца`,
          'gi'
        );
        for (const match of src.matchAll(re)) {
          const quantity = Number(String(match[1] || '').replace(/\s+/g, ''));
          const exp = Number(match[2]);
          if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(exp) || exp < 0 || exp > MAX_REAPER_EXP) continue;
          found.push({
            resourceId: resource.id,
            resourceName: resource.name,
            quantity,
            exp,
            index: match.index || 0
          });
        }
      }
    }
    found.sort((a, b) => a.index - b.index);
    return found;
  }

  function extractProfessionalExpEvents(text) {
    const src = normalizeText(text);
    const found = [];
    const re = /(?:ты\s+)?получа(?:ешь|ешься|л|ла|ете|ют|ется)\s*\+?(\d+)\s+опыт(?:а)?\s+жнеца|\+?(\d+)\s+опыт(?:а)?\s+жнеца|опыт(?:а)?\s+жнеца\s*[:+—-]?\s*(\d+)/gi;
    for (const match of src.matchAll(re)) {
      const exp = Number(match[1] ?? match[2] ?? match[3]);
      if (!Number.isFinite(exp) || exp < 0 || exp > MAX_REAPER_EXP) continue;
      found.push({ exp, index: match.index || 0 });
    }
    return found;
  }

  function snapshotRewardBaseline() {
    const text = normalizeText(document.body?.innerText || document.body?.textContent);
    rewardBaselineFull = countBy(extractRewardObservations(text), rewardSignature);
    rewardBaselineExp = countBy(extractProfessionalExpEvents(text), (item) => String(item.exp));
    rewardBaselineArmed = true;
  }

  function isNewOccurrence(item, counts, baseline, keyFn) {
    const key = keyFn(item);
    const seen = baseline.get(key) || 0;
    const current = counts.get(key) || 0;
    return current > seen;
  }

  async function markRewardCaptured(observation) {
    try {
      const stored = await chrome.storage.local.get(BOT_RUNTIME_KEY);
      const current = stored[BOT_RUNTIME_KEY] || {};
      // Do NOT clear pendingReward here. The reward transaction remains globally
      // locked until the native «Спасибо.» response has completed. Clearing it at
      // capture time created a short cross-frame window where another Haddan frame
      // could click the Fairy again and corrupt the reward flow.
      const next = {
        ...current,
        lastRewardCapturedAt: Date.now(),
        lastRewardCapturedExp: Number(observation?.exp),
        lastRewardCapturedResourceId: observation?.resourceId || '',
        lastRewardCapturedQuantity: Number(observation?.quantity || 0)
      };
      runtime = { ...runtime, ...next };
      await chrome.storage.local.set({ [BOT_RUNTIME_KEY]: next });
    } catch (_) {}
  }

  function currentRewardObservation(text) {
    const full = extractRewardObservations(text);
    const fullCounts = countBy(full, rewardSignature);
    const expectedId = String(runtime.pendingRewardResourceId || '');
    const expectedName = normalizeText(runtime.pendingRewardResource).toLowerCase();
    const expectedQty = Number(runtime.pendingRewardQuantity);

    // Prefer a newly appeared exact server line for the resource we just chose.
    const newFull = full.filter((item) => !rewardBaselineArmed || isNewOccurrence(item, fullCounts, rewardBaselineFull, rewardSignature));
    const exact = [...newFull].reverse().find((item) =>
      (!expectedId || item.resourceId === expectedId) &&
      (!expectedName || item.resourceName.toLowerCase() === expectedName) &&
      (!Number.isFinite(expectedQty) || expectedQty <= 0 || Number(item.quantity) === expectedQty)
    );
    if (exact) return exact;

    // A newly loaded qa.php reward page may already contain the current line before
    // this content script had a chance to snapshot a baseline. In that case accept
    // the newest line that exactly matches the remembered choice.
    const age = runtime.pendingRewardSince ? Date.now() - Number(runtime.pendingRewardSince) : Infinity;
    if (age >= 0 && age < 15000) {
      const matching = [...full].reverse().find((item) =>
        (!expectedId || item.resourceId === expectedId) &&
        (!expectedName || item.resourceName.toLowerCase() === expectedName) &&
        (!Number.isFinite(expectedQty) || expectedQty <= 0 || Number(item.quantity) === expectedQty)
      );
      if (matching) return matching;
    }

    // For automated rewards we intentionally require the exact Haddan server line
    // with resource + quantity + profession XP. A bare '+N опыта Жнеца' can come
    // from another stale frame and is not safe enough to acknowledge the reward.

    return null;
  }

  function advanceReaperSession(expGain, rewardTransactionKey) {
    const gain = Number(expGain);
    const currentExp = Number(reaperProfile?.exp);
    const appliedKey = String(rewardTransactionKey || '');
    if (!automation.running || !reaperProfile?.sessionStartedAt || !appliedKey || !Number.isFinite(gain) || gain < 0 || !Number.isFinite(currentExp)) {
      return null;
    }
    if (String(reaperProfile.lastAppliedRewardKey || '') === appliedKey) return null;

    const nextExp = currentExp + gain;
    const progress = reaperProgress(nextExp, reaperProfile.rank);
    if (!progress) return null;

    const previousRank = reaperProfile.rank || '';
    reaperProfile = {
      ...reaperProfile,
      rank: progress.rank,
      exp: progress.exp,
      nextRank: progress.nextRank,
      nextExp: progress.nextExp,
      remaining: progress.remaining,
      sessionGainedExp: Number(reaperProfile.sessionGainedExp || 0) + gain,
      sessionRewards: Number(reaperProfile.sessionRewards || 0) + 1,
      lastRewardExp: gain,
      lastRewardAt: Date.now(),
      lastAppliedRewardKey: appliedKey,
      rankChangedAt: previousRank && previousRank !== progress.rank ? Date.now() : (reaperProfile.rankChangedAt || 0),
      updatedAt: Date.now()
    };
    return reaperProfile;
  }

  async function captureRewardObservation(textOverride = null) {
    // Primary source is the Fairy reward qa.php page itself. The server renders
    // both the exact reward line and the native «Спасибо.» link there, so we do
    // not need to wait for the chat frame to mirror the message. This also avoids
    // cross-frame races around pendingReward.
    const text = normalizeText(textOverride ?? document.body?.innerText ?? document.body?.textContent);
    const freshRewardDocument =
      /\/room\/func\/qa\.php$/i.test(location.pathname) &&
      Date.now() - DOCUMENT_STARTED_AT < 30000 &&
      !![...document.querySelectorAll('a[href*="qa.php"]')].find((el) => {
        try {
          const url = new URL(el.getAttribute('href'), location.href);
          return url.searchParams.get('id') === '9000';
        } catch (_) { return false; }
      });

    if (!runtime.pendingReward && !freshRewardDocument) return false;
    const expectedFrame = String(runtime.rewardChoiceFrameKey || '');
    if (runtime.pendingReward && expectedFrame && expectedFrame !== frameContextKey()) return false;
    const observation = currentRewardObservation(text);
    if (!observation) return false;

    // Bind the observation to the profession level that was active WHEN the
    // resource was chosen. This avoids misclassifying a sample if the selector
    // is changed while the reward page is loading.
    const rankKey = normalizeText(runtime.pendingRewardRankKey || '').toLowerCase() || profileRankKey();
    const transactionKey = Number(runtime.rewardChoiceAt || runtime.pendingRewardSince || DOCUMENT_STARTED_AT);
    const key = `${transactionKey}|${rankKey}|${observation.resourceId}|${observation.quantity}|${observation.exp}`;
    if (key === lastRewardObservationKey) return true;
    lastRewardObservationKey = key;

    const safeExp = validReaperExp(observation.exp);
    if (safeExp == null) return false;
    const universal = universalExpectedProfessionalExpDetails(observation.resourceId, observation.quantity, rankKey);
    const sample = {
      resourceId: observation.resourceId,
      resourceName: observation.resourceName,
      quantity: Number(observation.quantity),
      exp: safeExp,
      rankKey,
      expectedExp: expectedProfessionalExp(observation.resourceId, observation.quantity, rankKey),
      universalExpectedExp: universal?.value ?? null,
      universalExpectedExpMin: universal?.min ?? null,
      universalExpectedExpMax: universal?.max ?? null,
      chanseUp: universal?.chanceUp ?? null,
      professionExp: Number.isFinite(Number(reaperProfile?.exp)) ? Number(reaperProfile.exp) : null,
      ts: Date.now(),
      count: 1
    };
    const samples = Array.isArray(reaperExp?.samples) ? [...reaperExp.samples] : [];

    // Persist the learned quantity->XP mapping instead of spending storage on an
    // endless stream of identical rows. Repeated observations strengthen the
    // same mapping through `count` and refresh its timestamp.
    const existing = samples.find((item) =>
      item.rankKey === sample.rankKey && item.resourceId === sample.resourceId &&
      Number(item.quantity) === sample.quantity && Number(item.exp) === sample.exp
    );
    if (existing) {
      existing.count = sampleWeight(existing) + 1;
      existing.ts = sample.ts;
      existing.resourceName = sample.resourceName;
      existing.professionExp = sample.professionExp;
      existing.expectedExp = sample.expectedExp;
      existing.universalExpectedExp = sample.universalExpectedExp;
      existing.universalExpectedExpMin = sample.universalExpectedExpMin;
      existing.universalExpectedExpMax = sample.universalExpectedExpMax;
      existing.chanseUp = sample.chanseUp;
    } else {
      samples.push(sample);
    }
    const enriched = addExpectedExpToSamples({ samples: samples.slice(-MAX_REAPER_EXP_RECORDS) });
    reaperExp = { ...enriched.value, updatedAt: Date.now(), maxExp: MAX_REAPER_EXP };
    const advancedProfile = advanceReaperSession(safeExp, transactionKey);
    try {
      // Keep FAIRY_OFFERS intact. Clearing it here made the panel lose the exact
      // quantity that the just-saved XP sample belongs to, so the user could not
      // see 16 шт. -> 6 опыта immediately after the reward. The next Fairy offer
      // list will naturally replace it.
      const patch = { [REAPER_EXP_KEY]: reaperExp };
      if (advancedProfile) patch[REAPER_PROFILE_KEY] = advancedProfile;
      await chrome.storage.local.set(patch);
    } catch (_) {}

    await markRewardCaptured(observation);
    return true;
  }

  // automation.js calls this directly before acknowledging «Спасибо». Both
  // scripts run in the same extension isolated world inside the same frame.
  window.__HMH_CAPTURE_FAIRY_REWARD__ = captureRewardObservation;

  function liquidationValue(resourceId, quantity) {
    const offers = Array.isArray(market.data?.[resourceId]) ? market.data[resourceId] : [];
    if (!offers.length || quantity <= 0) {
      return { total: null, average: null, uncovered: quantity };
    }

    let remaining = quantity;
    let total = 0;
    let sold = 0;

    for (const offer of offers) {
      if (remaining <= 0) break;

      const price = Number(offer.buyPrice);
      if (!Number.isFinite(price) || price <= 0) continue;

      // Secondary guard: copper shops are ignored even if old cache data contains one.
      if (offer.moneyLevel === 'copper') continue;

      const capacity = offer.buyLimit == null
        ? remaining
        : Math.max(0, Number(offer.buyLimit) || 0);

      if (capacity <= 0) continue;

      const take = Math.min(remaining, capacity);
      total += take * price;
      sold += take;
      remaining -= take;
    }

    return {
      total: sold > 0 ? total : null,
      average: sold > 0 ? total / sold : null,
      uncovered: remaining
    };
  }

  function findFairyOfferSet() {
    const nodes = [...document.querySelectorAll('td, div, p, li, span, body')];
    const candidates = [];

    for (const el of nodes) {
      if (el.closest?.('.hmh-fairy-price')) continue;
      const text = normalizeText(el.innerText || el.textContent);
      if (!text || text.length > 6000 || !FAIRY_MARKER_RE.test(text)) continue;

      const offers = extractOffers(text);
      if (!offers.length) continue;

      // Resource lists are also mirrored into Haddan's chat/history frame.
      // Text alone is therefore NOT proof that this is the interactive Fairy
      // choice page. Normally we require at least two native qa.php resource
      // links associated with the same offer block. Low Жнец ranks are a special
      // case: Haddan can legitimately offer only ONE resource. Accept that shape
      // only inside the real qa.php dialogue, never from the long-lived room/chat
      // frame where the same sentence is mirrored as history.
      const singleOffer = offers.length === 1;
      const liveQaDocument = /\/room\/func\/qa\.php$/i.test(location.pathname);
      if (singleOffer && !liveQaDocument) continue;

      const choices = collectChoiceLinks(offers, el);
      const requiredChoices = singleOffer ? 1 : 2;
      if (choices.length < requiredChoices) continue;

      candidates.push({ el, offers, choices, textLength: text.length });
    }

    if (!candidates.length) return null;

    // Prefer the smallest element that contains the complete Fairy message.
    candidates.sort((a, b) => a.textLength - b.textLength);
    return candidates[0];
  }

  function resourceForChoiceText(text, offers) {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) return null;

    return offers.find((offer) =>
      offer.aliases.some((alias) => normalized === alias.toLowerCase())
    ) || null;
  }

  function collectChoiceLinks(offers, offerContainer = null) {
    // IMPORTANT: choose only links that belong to the CURRENT Fairy offer block.
    // Searching the whole document can hit an old/stale qa.php choice that is still
    // present in another wrapper/history area. Clicking such a stale link produces
    // the outgoing resource name in chat but may skip the actual reward response.
    const scanScope = (scope) => {
      if (!scope?.querySelectorAll) return [];
      const result = [];
      for (const link of scope.querySelectorAll('a[href*="qa.php"]')) {
        const offer = resourceForChoiceText(link.textContent, offers);
        if (!offer) continue;
        result.push({ link, offer });
      }
      return result;
    };

    // The parser returns the smallest element containing the complete offer text.
    // In some Haddan layouts the actual links live one or two ancestors above it,
    // so widen the scope gradually, but never jump straight to unrelated frames.
    const requiredMatches = offers.length === 1 ? 1 : 2;
    let scope = offerContainer;
    for (let depth = 0; scope && depth < 5; depth += 1, scope = scope.parentElement) {
      const matches = scanScope(scope);
      if (matches.length >= requiredMatches) return matches;
      if (scope === document.body || scope === document.documentElement) break;
    }

    return [];
  }

  function ensureOverlay() {
    if (overlayHost?.isConnected && overlayRoot) return;
    overlayHost = document.createElement('div');
    overlayHost.id = 'hmh-fairy-overlay-host';
    overlayHost.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;contain:layout style paint;';
    overlayRoot = overlayHost.attachShadow({ mode: 'closed' });
    overlayStyle = document.createElement('style');
    overlayStyle.textContent = `
      :host { all: initial; }
      .note {
        position: fixed;
        pointer-events: none;
        color: #5c4a30;
        font: 12px/1.25 Arial, Helvetica, sans-serif;
        white-space: nowrap;
        background: rgba(255,255,255,.92);
        border-radius: 3px;
        padding: 1px 3px;
        box-shadow: 0 0 0 1px rgba(92,74,48,.12);
      }
      .note.best {
        color: #6f5300;
        font-weight: 700;
        background: #fff1a8;
        box-shadow: 0 0 0 1px rgba(146,112,0,.28);
      }
      .outline {
        position: fixed;
        pointer-events: none;
        border: 1px solid rgba(146,112,0,.60);
        border-radius: 3px;
        background: rgba(255,241,168,.24);
        box-sizing: border-box;
      }
    `;
    overlayRoot.appendChild(overlayStyle);
    document.documentElement.appendChild(overlayHost);
  }

  function clearDecorations() {
    if (!overlayRoot) return;
    [...overlayRoot.querySelectorAll('.note,.outline')].forEach((el) => el.remove());
  }

  function addVisualAnnotation(link, text, title, isBest) {
    ensureOverlay();
    const rect = link.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;

    if (isBest) {
      const outline = document.createElement('div');
      outline.className = 'outline';
      outline.style.left = `${Math.max(0, rect.left - 3)}px`;
      outline.style.top = `${Math.max(0, rect.top - 2)}px`;
      outline.style.width = `${rect.width + 6}px`;
      outline.style.height = `${rect.height + 4}px`;
      overlayRoot.appendChild(outline);
    }

    const note = document.createElement('span');
    note.className = `note${isBest ? ' best' : ''}`;
    note.textContent = text;
    note.title = title;
    note.style.left = `${Math.min(window.innerWidth - 4, rect.right + 4)}px`;
    note.style.top = `${Math.max(0, rect.top - 1)}px`;
    overlayRoot.appendChild(note);

    // If the label would overflow the frame, place it immediately below the link.
    const noteRect = note.getBoundingClientRect();
    if (noteRect.right > window.innerWidth - 2) {
      note.style.left = `${Math.max(2, Math.min(rect.left, window.innerWidth - noteRect.width - 2))}px`;
      note.style.top = `${Math.min(window.innerHeight - noteRect.height - 2, rect.bottom + 2)}px`;
    }
  }

  function offerProfitValue(offer) {
    const value = Number(offer?.valuation?.total);
    return Number.isFinite(value) ? value : -Infinity;
  }

  function offerExperienceValue(offer) {
    const value = Number(offer?.professionalExp?.value);
    return Number.isFinite(value) ? value : -Infinity;
  }

  function chooseBestOffer(valued) {
    if (!valued.length) return { best: null, fallback: false };

    if (automation.resourceMode === 'experience') {
      const knownExp = valued.filter((offer) => Number.isFinite(Number(offer?.professionalExp?.value)));
      if (knownExp.length) {
        const sorted = [...knownExp].sort((a, b) => {
          const expDiff = offerExperienceValue(b) - offerExperienceValue(a);
          if (Math.abs(expDiff) > 1e-9) return expDiff;
          const profitDiff = offerProfitValue(b) - offerProfitValue(a);
          if (Math.abs(profitDiff) > 1e-9) return profitDiff;
          return String(a.resourceName).localeCompare(String(b.resourceName), 'ru');
        });
        return { best: sorted[0], fallback: false };
      }
      const priced = valued.filter((offer) => Number.isFinite(Number(offer?.valuation?.total)));
      if (priced.length) {
        const sorted = [...priced].sort((a, b) => offerProfitValue(b) - offerProfitValue(a));
        return { best: sorted[0], fallback: true };
      }
      return { best: valued[0], fallback: true };
    }

    const priced = valued.filter((offer) => Number.isFinite(Number(offer?.valuation?.total)));
    if (priced.length) {
      const sorted = [...priced].sort((a, b) => offerProfitValue(b) - offerProfitValue(a));
      return { best: sorted[0], fallback: false };
    }
    return { best: null, fallback: false };
  }

  function renderInline(offers, offerContainer = null, precomputedChoices = null) {
    const valued = offers.map((offer) => ({
      ...offer,
      valuation: liquidationValue(offer.resourceId, offer.quantity),
      professionalExp: predictProfessionalExp(offer.resourceId, offer.quantity)
    }));

    const { best: chosenBest, fallback: experienceFallback } = chooseBestOffer(valued);
    const byResourceId = Object.fromEntries(valued.map((offer) => [offer.resourceId, offer]));
    const choices = Array.isArray(precomputedChoices) ? precomputedChoices : collectChoiceLinks(offers, offerContainer);
    const requiredChoices = offers.length === 1 ? 1 : 2;
    if (choices.length < requiredChoices) return false;

    // IMPORTANT: Haddan's native resource links are intentionally left completely
    // untouched. We do not change their text, class, title, dataset, children or
    // surrounding layout. All helper labels live in an isolated Shadow DOM overlay.
    clearDecorations();
    let bestLink = null;
    let bestOffer = null;

    for (const { link, offer } of choices) {
      const valuedOffer = byResourceId[offer.resourceId];
      if (!valuedOffer) continue;

      const { valuation } = valuedOffer;
      const isBest = !!chosenBest && chosenBest.resourceId === valuedOffer.resourceId;
      const label = valuation.total == null
        ? `(нет цены · ${expDisplay(valuedOffer.professionalExp)})${isBest ? ' ★' : ''}`
        : `(≈ ${formatNumber(valuation.total)} мн · ${expDisplay(valuedOffer.professionalExp)})${isBest ? ' ★' : ''}`;

      const details = [];
      if (valuation.average != null) details.push(`средняя скупка ${formatNumber(valuation.average)} / шт.`);
      if (valuation.uncovered > 0) details.push(`не покрыто ${formatNumber(valuation.uncovered, 0)} шт.`);
      if (valuedOffer.professionalExp) {
        details.push(valuedOffer.professionalExp.exact
          ? `проф. опыт: наблюдался ${valuedOffer.professionalExp.samples}×`
          : `проф. опыт: оценка по ${valuedOffer.professionalExp.samples} наблюдениям`);
      } else {
        details.push('проф. опыт: данных пока нет');
      }
      details.push(`уровень Жнеца: ${reaperProfile?.rank || automation.reaperRank}`);
      details.push(formatAge(market.updatedAt));
      addVisualAnnotation(link, label, `Haddan Market Helper: ${details.join(' · ')}`, isBest);

      if (isBest && !bestLink) {
        bestLink = link;
        bestOffer = valuedOffer;
        bestOffer.experienceFallback = experienceFallback;
      }
    }

    maybeAutoChoose(bestLink, bestOffer, offers);
    return true;
  }

  async function markPendingReward(bestOffer) {
    snapshotRewardBaseline();
    try {
      const stored = await chrome.storage.local.get(BOT_RUNTIME_KEY);
      const current = stored[BOT_RUNTIME_KEY] || {};
      const choiceAt = Date.now();
      const next = {
        ...current,
        pendingReward: true,
        pendingRewardSince: choiceAt,
        pendingRewardResource: bestOffer?.resourceName || '',
        pendingRewardResourceId: bestOffer?.resourceId || '',
        pendingRewardQuantity: Number(bestOffer?.quantity || 0),
        pendingRewardRankKey: profileRankKey(),
        rewardChoiceAt: choiceAt,
        rewardChoiceDocumentStartedAt: DOCUMENT_STARTED_AT,
        rewardChoiceFrameKey: frameContextKey(),
        fairyChoiceActiveUntil: 0,
        rewardAcknowledgingUntil: 0,
        rewardAckScheduledAt: 0,
        rewardAckStartedAt: 0,
        rewardAckFrameKey: '',
        rewardAckDocumentStartedAt: 0,
        lastRewardCapturedAt: 0,
        lastRewardCapturedExp: null,
        lastRewardCapturedResourceId: '',
        lastRewardCapturedQuantity: 0
      };
      runtime = { ...runtime, ...next };
      await chrome.storage.local.set({ [BOT_RUNTIME_KEY]: next });
    } catch (_) {}
  }

  async function registerActionableChoiceDocument(signature) {
    try {
      const stored = await chrome.storage.local.get(BOT_RUNTIME_KEY);
      const current = stored[BOT_RUNTIME_KEY] || {};
      const latest = Number(current.latestFairyActionableChoiceDocumentStartedAt || 0);

      // An older still-alive frame must not keep extending the global lock after a
      // newer actionable choice document has appeared.
      if (latest && DOCUMENT_STARTED_AT + 250 < latest) return false;

      const now = Date.now();
      const frameKey = frameContextKey();
      const next = {
        ...current,
        latestFairyActionableChoiceDocumentStartedAt: Math.max(latest, DOCUMENT_STARTED_AT),
        latestFairyActionableChoiceFrameKey: frameKey,
        latestFairyActionableChoiceSignature: signature,
        fairyChoiceActiveUntil: now + 5000
      };
      runtime = { ...runtime, ...next };
      await chrome.storage.local.set({ [BOT_RUNTIME_KEY]: next });
      return true;
    } catch (_) {
      return true;
    }
  }

  function maybeAutoChoose(bestLink, bestOffer, offers) {
    if (!bestLink || !bestOffer || !automation.running || !automation.collectResources || runtime.pauseReason === 'captcha' || automation.captureFairy) return;
    // A real Fairy choice response is a freshly loaded qa.php document. Never let
    // a choice page left alive from an older cycle submit a resource again.
    if (Date.now() - DOCUMENT_STARTED_AT > 30000) return;

    const signature = offers.map((o) => `${o.resourceId}:${o.quantity}`).sort().join('|');
    const href = bestLink.getAttribute('href') || '';
    const key = `${automation.resourceMode}|${automation.reaperRank}|${signature}|${bestOffer.resourceId}|${href}`;
    const now = Date.now();
    if (key === lastAutoChoiceKey && now - lastAutoChoiceAt < 10000) return;

    lastAutoChoiceKey = key;
    lastAutoChoiceAt = now;
    const value = bestOffer.valuation?.total;
    const expValue = bestOffer.professionalExp?.value;
    let statusText;
    if (automation.resourceMode === 'experience') {
      statusText = bestOffer.experienceFallback
        ? `Фея: нет данных опыта (${automation.reaperRank}), беру по выгоде · ${bestOffer.resourceName}`
        : `Фея: ${bestOffer.resourceName} · опыт ${formatNumber(expValue, 0)}${value != null ? ` · ≈ ${formatNumber(value)} мн` : ''}`;
    } else {
      statusText = `Фея: ${bestOffer.resourceName} ≈ ${formatNumber(value)} мн`;
    }
    chrome.storage.local.set({
      [BOT_STATUS_KEY]: {
        text: statusText,
        ts: now,
        frame: location.pathname
      }
    }).catch(() => {});

    const decisionMode = automation.resourceMode;
    const decisionRank = automation.reaperRank;

    // Pre-click watchdog. There is a narrow state before markPendingReward() where
    // the delayed native click can be abandoned because a frame/document lock
    // changed while the 1.2 s timer was waiting. In that case the ordinary
    // 15-second reward watchdog cannot help because pendingReward was never armed.
    // If THIS exact actionable choice document is still alive after 5 seconds and
    // no reward transaction exists, allow a fresh local decision/scan. A successful
    // navigation destroys this document, so the watchdog disappears naturally.
    setTimeout(async () => {
      if (!automation.running || !automation.collectResources || runtime.pauseReason === 'captcha') return;
      if (!bestLink.isConnected) {
        lastAutoChoiceKey = '';
        lastAutoChoiceAt = 0;
        scheduleScan();
        return;
      }

      try {
        const stored = await chrome.storage.local.get(BOT_RUNTIME_KEY);
        const current = stored[BOT_RUNTIME_KEY] || {};
        if (current.pendingReward) return;

        const latestChoiceDoc = Number(current.latestFairyActionableChoiceDocumentStartedAt || 0);
        const latestChoiceFrame = String(current.latestFairyActionableChoiceFrameKey || '');
        const latestChoiceSignature = String(current.latestFairyActionableChoiceSignature || '');
        if (latestChoiceDoc && DOCUMENT_STARTED_AT + 250 < latestChoiceDoc) return;
        if (latestChoiceFrame && latestChoiceFrame !== frameContextKey()) return;
        if (latestChoiceSignature && latestChoiceSignature !== signature) return;

        const currentOffer = findFairyOfferSet();
        if (!currentOffer) return;
        const currentSignature = currentOffer.offers
          .map((o) => `${o.resourceId}:${o.quantity}`)
          .sort()
          .join('|');
        if (currentSignature !== signature) return;

        lastAutoChoiceKey = '';
        lastAutoChoiceAt = 0;
        chrome.storage.local.set({
          [BOT_STATUS_KEY]: {
            text: `Фея: выбор ${bestOffer.resourceName} не начался за 5 с · повторяю`,
            ts: Date.now(),
            frame: location.pathname
          }
        }).catch(() => {});
        scheduleScan();
      } catch (_) {
        lastAutoChoiceKey = '';
        lastAutoChoiceAt = 0;
        scheduleScan();
      }
    }, 5000);

    setTimeout(async () => {
      if (!bestLink.isConnected || !automation.running || !automation.collectResources) return;
      if (automation.resourceMode !== decisionMode || automation.reaperRank !== decisionRank) return;
      try {
        // Multiple Haddan frames can survive at the same time. Only the newest
        // document that currently contains the Fairy offer may submit a choice.
        // This prevents a stale old resource link from being clicked first.
        const stored = await chrome.storage.local.get(BOT_RUNTIME_KEY);
        const current = stored[BOT_RUNTIME_KEY] || {};
        if (current.pendingReward) return;
        const latestChoiceDoc = Number(current.latestFairyActionableChoiceDocumentStartedAt || 0);
        const latestChoiceFrame = String(current.latestFairyActionableChoiceFrameKey || '');
        const latestChoiceSignature = String(current.latestFairyActionableChoiceSignature || '');
        if (latestChoiceDoc && DOCUMENT_STARTED_AT + 250 < latestChoiceDoc) return;
        if (latestChoiceFrame && latestChoiceFrame !== frameContextKey()) return;
        if (latestChoiceSignature && latestChoiceSignature !== signature) return;

        await markPendingReward(bestOffer);
        // One native click only. Retrying while qa.php is still loading can abort
        // the server response and erase the Fairy's XP message.
        bestLink.click();
      } catch (e) {
        console.warn('[Haddan Market Helper] auto Fairy click failed', e);
      }
    }, 1200);
  }

  async function scanFairyOffers() {
    scanTimer = null;
    if (!storageReady) return;

    try {
      const found = findFairyOfferSet();
      if (!found) {
        captureRewardObservation();
        return;
      }

      publishFairyOffers(found.offers);
      captureRewardObservation();

      const signature = found.offers
        .map((o) => `${o.resourceId}:${o.quantity}`)
        .sort()
        .join('|');

      // Establish the cross-frame choice lock BEFORE the delayed native click is
      // scheduled. Only a page with real resource qa.php links gets this lock.
      // Chat/history frames that merely repeat the list are ignored.
      const isCurrentActionableChoice = await registerActionableChoiceDocument(signature);
      if (!isCurrentActionableChoice) return;

      const renderKey = `${signature}@${market.updatedAt || 0}`;

      // If the DOM was replaced by Haddan, annotations disappear; render again even with same signature.
      // Even when the annotations are already present, run renderInline again: it also owns the
      // Auto Fairy decision. This avoids a startup race where prices were rendered before the
      // persisted RUNNING flag had been restored from chrome.storage.
      if (renderKey === lastRenderKey) {
        renderInline(found.offers, found.el, found.choices);
        return;
      }

      if (renderInline(found.offers, found.el, found.choices)) {
        lastRenderKey = renderKey;
      }
    } catch (e) {
      console.warn('[Haddan Market Helper] Fairy parser error', e);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanFairyOffers().catch((e) => console.warn('[Haddan Market Helper] Fairy async scan error', e));
    }, 120);
  }

  async function restoreMarket() {
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEY, AUTOMATION_KEY, BOT_RUNTIME_KEY, REAPER_EXP_KEY, REAPER_PROFILE_KEY]);
      const cached = stored[STORAGE_KEY];
      reaperProfile = stored[REAPER_PROFILE_KEY] || null;
      automation = normalizeAutomation(stored[AUTOMATION_KEY] || {}, reaperProfile?.rank || '');
      runtime = { pauseReason: '', ...(stored[BOT_RUNTIME_KEY] || {}) };
      const restoredExp = addExpectedExpToSamples(stored[REAPER_EXP_KEY] || { samples: [] });
      reaperExp = restoredExp.value;
      // One top-frame migration persists expectedExp and universal model details for historical rows. Other
      // frames receive the updated object through chrome.storage.onChanged.
      if (restoredExp.changed && window.top === window) {
        await chrome.storage.local.set({ [REAPER_EXP_KEY]: reaperExp });
      }
      if (cached?.data) {
        market = {
          updatedAt: cached.updatedAt || null,
          data: cached.data || {}
        };
      }
    } catch (e) {
      console.warn('[Haddan Market Helper] Fairy cache restore failed', e);
    }
    storageReady = true;
    lastRenderKey = '';
    scheduleScan();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[STORAGE_KEY]?.newValue) {
      const cached = changes[STORAGE_KEY].newValue;
      market = {
        updatedAt: cached.updatedAt || null,
        data: cached.data || {}
      };
      lastRenderKey = '';
    }
    if (changes[AUTOMATION_KEY]?.newValue) {
      automation = normalizeAutomation(changes[AUTOMATION_KEY].newValue || {}, reaperProfile?.rank || '');
      lastRenderKey = '';
      lastAutoChoiceKey = '';
      lastAutoChoiceAt = 0;
    }
    if (changes[REAPER_EXP_KEY]?.newValue) {
      reaperExp = changes[REAPER_EXP_KEY].newValue || { samples: [] };
      lastRenderKey = '';
    }
    if (changes[REAPER_PROFILE_KEY]) {
      reaperProfile = changes[REAPER_PROFILE_KEY].newValue || null;
      lastRenderKey = '';
      lastPublishedOfferKey = '';
    }
    if (changes[BOT_RUNTIME_KEY]?.newValue) {
      const wasPending = !!runtime.pendingReward;
      runtime = { pauseReason: '', ...changes[BOT_RUNTIME_KEY].newValue };
      if (!wasPending && runtime.pendingReward) snapshotRewardBaseline();
      if (wasPending && !runtime.pendingReward) {
        rewardBaselineArmed = false;
        rewardBaselineFull = new Map();
        rewardBaselineExp = new Map();
      }
      // CAPTCHA pauses automatic clicking but price annotations may remain visible.
      if (runtime.pauseReason === 'captcha') {
      }
    }
    scheduleScan();
  });

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener('scroll', scheduleScan, { passive: true });
  window.addEventListener('resize', scheduleScan, { passive: true });

  restoreMarket();
})();
