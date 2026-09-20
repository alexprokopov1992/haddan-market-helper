'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../content/runtime.js');

test('normalizeRuntime keeps known values and fills missing defaults', () => {
  const normalized = runtime.normalizeRuntime({
    pendingReward: true,
    pendingRewardResource: 'Капустница',
    rewardChoiceAt: 123,
    unknownField: 'ignored'
  });

  assert.equal(normalized.pendingReward, true);
  assert.equal(normalized.pendingRewardResource, 'Капустница');
  assert.equal(normalized.rewardChoiceAt, 123);
  assert.equal(normalized.battleActive, false);
  assert.equal(normalized.fairyCooldownLogicVersion, 2);
  assert.equal(Object.hasOwn(normalized, 'unknownField'), false);
});

test('clearRewardRuntimePatch clears transaction locks without erasing captured reward evidence', () => {
  const patch = runtime.clearRewardRuntimePatch({ fairyWaitUntil: 777 });

  assert.equal(patch.pendingReward, false);
  assert.equal(patch.pendingRewardResource, '');
  assert.equal(patch.rewardChoiceFrameKey, '');
  assert.equal(patch.rewardAckStartedAt, 0);
  assert.equal(patch.fairyWaitUntil, 777);
  assert.equal(Object.hasOwn(patch, 'lastRewardCapturedAt'), false);
});
