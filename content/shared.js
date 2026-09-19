(function initHmhShared(global) {
  'use strict';

  const STORAGE_KEYS = Object.freeze({
    market: 'hmh_market_v1',
    history: 'hmh_history_v1',
    panelPosition: 'hmh_panel_position_v1',
    automation: 'hmh_automation_v1',
    botStatus: 'hmh_bot_status_v1',
    botRuntime: 'hmh_bot_runtime_v1',
    fairyOffers: 'hmh_fairy_offers_v1',
    reaperExp: 'hmh_reaper_exp_v1',
    reaperProfile: 'hmh_reaper_profile_v1'
  });

  const RESOURCES = Object.freeze([
    Object.freeze({ id: '1044', name: 'Мухожор', aliases: Object.freeze(['Мухожор']) }),
    Object.freeze({ id: '5900', name: 'Подсолнух', aliases: Object.freeze(['Подсолнух']) }),
    Object.freeze({ id: '5901', name: 'Капустница', aliases: Object.freeze(['Капустница']) }),
    Object.freeze({ id: '1045', name: 'Мандрагора', aliases: Object.freeze(['Мандрагора']) }),
    Object.freeze({ id: '5902', name: 'Зеленая Массивка', aliases: Object.freeze(['Зеленая Массивка']) }),
    Object.freeze({ id: '5903', name: 'Колючник Черный', aliases: Object.freeze(['Колючник Черный', 'Черный Колючник']) }),
    Object.freeze({ id: '5904', name: 'Гертаниум', aliases: Object.freeze(['Гертаниум']) })
  ]);

  const REAPER_RANKS = Object.freeze([
    'Новичок',
    'Косарь',
    'Травник',
    'Гербалист',
    'Опытный Травник',
    'Опытный Гербологист',
    'Хранитель Полян',
    'Мастер',
    'Грандмастер',
    'Магистр',
    'Великий Магистр'
  ]);

  const DEFAULT_AUTOMATION = Object.freeze({
    running: false,
    collectResources: true,
    resourceMode: 'profit',
    reaperRank: 'Новичок',
    solveCaptcha: false,
    captchaApiToken: '',
    captureFairy: false,
    selectedFairy: null
  });

  const MAX_REAPER_EXP = 10;
  const MAX_HISTORY_PER_RESOURCE = 100;

  function normalizeText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/[\t\r]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  }

  function canonicalReaperRank(value) {
    const key = normalizeText(value).toLowerCase();
    return REAPER_RANKS.find((rank) => rank.toLowerCase() === key) || '';
  }

  function normalizeAutomation(raw = {}, detectedRank = '') {
    const collectResources = Object.prototype.hasOwnProperty.call(raw, 'collectResources')
      ? !!raw.collectResources
      : raw.autoFairy !== false;
    const rank = canonicalReaperRank(raw.reaperRank) || canonicalReaperRank(detectedRank) || DEFAULT_AUTOMATION.reaperRank;
    return {
      running: !!raw.running && collectResources,
      collectResources,
      resourceMode: raw.resourceMode === 'experience' ? 'experience' : 'profit',
      reaperRank: rank,
      solveCaptcha: !!raw.solveCaptcha,
      captchaApiToken: String(raw.captchaApiToken || ''),
      captureFairy: !!raw.captureFairy,
      selectedFairy: raw.selectedFairy || null
    };
  }

  function validReaperExp(value) {
    const exp = Number(value);
    return Number.isFinite(exp) && exp >= 0 && exp <= MAX_REAPER_EXP ? exp : null;
  }

  function sampleWeight(sample) {
    const count = Number(sample && sample.count);
    return Number.isFinite(count) && count > 0 ? Math.max(1, Math.floor(count)) : 1;
  }

  function weightedMedian(entries) {
    const sorted = entries
      .filter((entry) => Number.isFinite(entry && entry.value) && Number.isFinite(entry && entry.weight) && entry.weight > 0)
      .sort((a, b) => a.value - b.value);
    if (!sorted.length) return null;
    const totalWeight = sorted.reduce((sum, entry) => sum + entry.weight, 0);
    let acc = 0;
    for (const entry of sorted) {
      acc += entry.weight;
      if (acc >= totalWeight / 2) return entry.value;
    }
    return sorted[sorted.length - 1].value;
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
    const value = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    return { value, min, max, exact: true, samples: total };
  }

  function predictProfessionalExp(samples, resourceId, quantity, rankKey, limit = 800) {
    if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) return null;
    const scopedSamples = (Array.isArray(samples) ? samples : [])
      .filter((sample) => sample.resourceId === resourceId && sample.rankKey === rankKey)
      .slice(-limit);
    if (!scopedSamples.length) return null;

    const exact = exactExperienceSummary(scopedSamples, quantity);
    if (exact) return exact;

    const ratios = scopedSamples
      .map((sample) => {
        const exp = validReaperExp(sample.exp);
        const qty = Number(sample.quantity);
        return { value: exp != null && qty > 0 ? exp / qty : NaN, weight: sampleWeight(sample) };
      })
      .filter((entry) => Number.isFinite(entry.value));
    const ratio = weightedMedian(ratios);
    if (ratio == null) return null;
    return {
      value: Math.min(MAX_REAPER_EXP, Math.max(0, Math.round(Number(quantity) * ratio))),
      min: null,
      max: null,
      exact: false,
      samples: ratios.reduce((sum, entry) => sum + entry.weight, 0)
    };
  }

  function mapApiRunesToSiteRunes(apiRunes) {
    if (!Array.isArray(apiRunes) || apiRunes.length === 0) throw new Error('empty-runes');
    const mapped = apiRunes.map((value) => Number(value) - 1);
    if (mapped.some((value) => !Number.isInteger(value) || value < 0 || value > 8)) {
      throw new Error('mapped-rune-range');
    }
    return mapped;
  }

  function parseNumber(text) {
    if (text == null) return null;
    const normalized = String(text).replace(/\u00a0/g, '').replace(/\s+/g, '').replace(',', '.');
    if (!normalized || normalized.toLowerCase() === 'нет') return null;
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
  }

  function parseLimit(text) {
    const trimmed = String(text == null ? '' : text).trim().toLowerCase();
    if (!trimmed || trimmed === 'нет') return null;
    return parseNumber(trimmed);
  }

  function normalizeMarketOffers(rows, resource) {
    const offers = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const moneyLevel = String(row.moneyLevel || 'unknown');
      if (moneyLevel === 'copper') continue;

      const buyPrice = Number(row.buyPrice || 0);
      if (buyPrice <= 0) continue;

      offers.push({
        resourceId: String(resource && resource.id || row.resourceId || ''),
        resourceName: String(resource && resource.name || row.resourceName || ''),
        itemName: String(row.itemName || ''),
        shopName: String(row.shopName || ''),
        shopHref: String(row.shopHref || ''),
        moneyLevel,
        buyLimit: row.buyLimit == null ? null : Number(row.buyLimit),
        stock: Number(row.stock || 0),
        sellPrice: Number(row.sellPrice || 0),
        buyPrice
      });
    }

    offers.sort((a, b) => {
      if (b.buyPrice !== a.buyPrice) return b.buyPrice - a.buyPrice;
      const moneyRank = { gold: 2, silver: 1, unknown: 0 };
      return (moneyRank[b.moneyLevel] || 0) - (moneyRank[a.moneyLevel] || 0);
    });

    return offers;
  }

  const api = Object.freeze({
    STORAGE_KEYS,
    RESOURCES,
    REAPER_RANKS,
    DEFAULT_AUTOMATION,
    MAX_REAPER_EXP,
    MAX_HISTORY_PER_RESOURCE,
    normalizeText,
    canonicalReaperRank,
    normalizeAutomation,
    validReaperExp,
    sampleWeight,
    weightedMedian,
    exactExperienceSummary,
    predictProfessionalExp,
    mapApiRunesToSiteRunes,
    parseNumber,
    parseLimit,
    normalizeMarketOffers
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.HMH_SHARED = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
