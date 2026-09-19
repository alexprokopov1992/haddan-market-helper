'use strict';

let audioContext = null;

function getAudioContext() {
  if (!audioContext) {
    const Ctx = self.AudioContext || self.webkitAudioContext;
    if (!Ctx) return null;
    audioContext = new Ctx();
  }
  return audioContext;
}

async function playCaptchaAlert() {
  const ctx = getAudioContext();
  if (!ctx) return false;

  try {
    if (ctx.state === 'suspended') await ctx.resume();
    const start = ctx.currentTime + 0.02;
    const tones = [880, 1175, 880];

    tones.forEach((frequency, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t0 = start + index * 0.24;
      const t1 = t0 + 0.16;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t1);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    });
    return true;
  } catch (e) {
    console.warn('[Haddan Market Helper] captcha sound failed', e);
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'HMH_OFFSCREEN_CAPTCHA_SOUND') return;
  playCaptchaAlert().then((ok) => sendResponse({ ok })).catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
