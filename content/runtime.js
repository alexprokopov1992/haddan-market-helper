(function initHmhRuntime(global) {
  'use strict';

  const DEFAULT_RUNTIME = Object.freeze({
    fairyWaitUntil: 0,
    fairyCooldownLogicVersion: 2,
    fairyCooldownMinDocumentStartedAt: 0,
    fairyCooldownTransitionUntil: 0,
    dialogInitRecoveryUntil: 0,
    pendingReward: false,
    pendingRewardSince: 0,
    pendingRewardResource: '',
    pendingRewardResourceId: '',
    pendingRewardQuantity: 0,
    pendingRewardRankKey: '',
    latestFairyChoiceDocumentStartedAt: 0,
    latestFairyActionableChoiceDocumentStartedAt: 0,
    latestFairyActionableChoiceFrameKey: '',
    latestFairyActionableChoiceSignature: '',
    fairyChoiceActiveUntil: 0,
    rewardChoiceAt: 0,
    rewardChoiceDocumentStartedAt: 0,
    rewardChoiceFrameKey: '',
    lastRewardCapturedAt: 0,
    lastRewardCapturedExp: null,
    lastRewardCapturedResourceId: '',
    lastRewardCapturedQuantity: 0,
    rewardAcknowledgingUntil: 0,
    rewardAckLogicVersion: 3,
    rewardAckScheduledAt: 0,
    rewardAckStartedAt: 0,
    rewardAckFrameKey: '',
    rewardAckDocumentStartedAt: 0,
    rewardThanksSeenAt: 0,
    battleExpectedUntil: 0,
    battleStartLogicVersion: 2,
    battleStartRequestedAt: 0,
    battleStartRequestFrameKey: '',
    battleStartRequestDocumentStartedAt: 0,
    battleStartAttempts: 0,
    battleActive: false,
    battleRecoveryLastClickAt: 0,
    battleRecoveryAttempts: 0,
    pauseReason: '',
    captchaDetectedAt: 0,
    captchaLastSeenAt: 0,
    captchaSignalAt: 0
  });

  function normalizeRuntime(raw = {}) {
    const result = {};
    for (const key of Object.keys(DEFAULT_RUNTIME)) {
      result[key] = Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : DEFAULT_RUNTIME[key];
    }
    return result;
  }

  function clearRewardRuntimePatch(extra = {}) {
    return {
      pendingReward: false,
      pendingRewardSince: 0,
      pendingRewardResource: '',
      pendingRewardResourceId: '',
      pendingRewardQuantity: 0,
      pendingRewardRankKey: '',
      rewardChoiceAt: 0,
      rewardChoiceDocumentStartedAt: 0,
      rewardChoiceFrameKey: '',
      rewardAcknowledgingUntil: 0,
      rewardAckScheduledAt: 0,
      rewardAckStartedAt: 0,
      rewardAckFrameKey: '',
      rewardAckDocumentStartedAt: 0,
      rewardThanksSeenAt: 0,
      ...extra
    };
  }

  const api = Object.freeze({
    DEFAULT_RUNTIME,
    normalizeRuntime,
    clearRewardRuntimePatch
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.HMH_RUNTIME = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
