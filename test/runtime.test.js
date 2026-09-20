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
  assert.equal(normalized.battleStartedAt, 0);
  assert.equal(normalized.battleReloadingUntil, 0);
  assert.equal(normalized.fairyCooldownLogicVersion, 3);
  assert.equal(normalized.fairyWaitKind, '');
  assert.equal(normalized.dialogInitRecoveryUntil, 0);
  assert.equal(normalized.rewardAckLogicVersion, 4);
  assert.equal(normalized.rewardAckScheduledAt, 0);
  assert.equal(normalized.rewardAckFrameKey, '');
  assert.equal(normalized.rewardThanksSeenAt, 0);
  assert.equal(normalized.rewardSurfaceLastSeenAt, 0);
  assert.equal(Object.hasOwn(normalized, 'unknownField'), false);
});

test('clearRewardRuntimePatch clears transaction locks without erasing captured reward evidence', () => {
  const patch = runtime.clearRewardRuntimePatch({ fairyWaitUntil: 777 });

  assert.equal(patch.pendingReward, false);
  assert.equal(patch.pendingRewardResource, '');
  assert.equal(patch.rewardChoiceFrameKey, '');
  assert.equal(patch.rewardAckScheduledAt, 0);
  assert.equal(patch.rewardAckStartedAt, 0);
  assert.equal(patch.rewardAckFrameKey, '');
  assert.equal(patch.rewardAckDocumentStartedAt, 0);
  assert.equal(patch.rewardThanksSeenAt, 0);
  assert.equal(patch.rewardSurfaceLastSeenAt, 0);
  assert.equal(patch.fairyWaitUntil, 777);
  assert.equal(Object.hasOwn(patch, 'lastRewardCapturedAt'), false);
});
