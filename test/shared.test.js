'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../content/shared.js');

test('normalizeAutomation migrates legacy autoFairy and blocks running when collection is off', () => {
  assert.deepEqual(shared.normalizeAutomation({ running: true, autoFairy: false }), {
    running: false,
    collectResources: false,
    resourceMode: 'profit',
    reaperRank: 'Новичок',
    solveCaptcha: false,
    captchaApiToken: '',
    captureFairy: false,
    selectedFairy: null
  });
});

test('normalizeAutomation canonicalizes rank and clamps resource mode', () => {
  const normalized = shared.normalizeAutomation({
    running: true,
    collectResources: true,
    resourceMode: 'bad',
    reaperRank: '  мастер ',
    solveCaptcha: true,
    captchaApiToken: 123
  });

  assert.equal(normalized.running, true);
  assert.equal(normalized.resourceMode, 'profit');
  assert.equal(normalized.reaperRank, 'Мастер');
  assert.equal(normalized.solveCaptcha, true);
  assert.equal(normalized.captchaApiToken, '123');
});

test('mapApiRunesToSiteRunes maps API range 1..9 to site range 0..8', () => {
  assert.deepEqual(shared.mapApiRunesToSiteRunes([1, '5', 9]), [0, 4, 8]);
  assert.throws(() => shared.mapApiRunesToSiteRunes([]), /empty-runes/);
  assert.throws(() => shared.mapApiRunesToSiteRunes([0]), /mapped-rune-range/);
  assert.throws(() => shared.mapApiRunesToSiteRunes([10]), /mapped-rune-range/);
});

test('predictProfessionalExp prefers exact weighted observations', () => {
  const samples = [
    { resourceId: '1044', rankKey: 'мастер', quantity: 10, exp: 4, count: 1 },
    { resourceId: '1044', rankKey: 'мастер', quantity: 10, exp: 6, count: 3 },
    { resourceId: '1044', rankKey: 'другой', quantity: 10, exp: 9, count: 99 }
  ];

  assert.deepEqual(shared.predictProfessionalExp(samples, '1044', 10, 'мастер'), {
    value: 6,
    min: 4,
    max: 6,
    exact: true,
    samples: 4
  });
});

test('predictProfessionalExp estimates unseen quantity and caps at 10', () => {
  const samples = [
    { resourceId: '1044', rankKey: 'мастер', quantity: 1, exp: 7, count: 1 },
    { resourceId: '1044', rankKey: 'мастер', quantity: 2, exp: 10, count: 1 }
  ];

  assert.deepEqual(shared.predictProfessionalExp(samples, '1044', 3, 'мастер'), {
    value: 10,
    min: null,
    max: null,
    exact: false,
    samples: 2
  });
});

test('parseNumber and parseLimit handle Haddan numeric cells', () => {
  assert.equal(shared.parseNumber('1 234,5'), 1234.5);
  assert.equal(shared.parseNumber('нет'), null);
  assert.equal(shared.parseLimit('нет'), null);
  assert.equal(shared.parseLimit(' 42 '), 42);
});

test('normalizeMarketOffers filters unsafe rows and sorts by price then money level', () => {
  const resource = { id: '5900', name: 'Подсолнух' };
  const offers = shared.normalizeMarketOffers([
    { moneyLevel: 'copper', shopName: 'Copper', buyPrice: 999 },
    { moneyLevel: 'silver', shopName: 'Silver tie', buyPrice: 50 },
    { moneyLevel: 'gold', shopName: 'Gold tie', buyPrice: 50 },
    { moneyLevel: 'gold', shopName: 'Zero', buyPrice: 0 },
    { moneyLevel: 'unknown', shopName: 'Best', buyPrice: 70, buyLimit: 12 }
  ], resource);

  assert.deepEqual(offers.map((offer) => offer.shopName), ['Best', 'Gold tie', 'Silver tie']);
  assert.equal(offers[0].resourceId, '5900');
  assert.equal(offers[0].resourceName, 'Подсолнух');
  assert.equal(offers[0].buyLimit, 12);
});
