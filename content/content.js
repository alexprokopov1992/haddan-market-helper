(() => {
  'use strict';

  if (window.top !== window) return;
  if (document.getElementById('hmh-root')) return;

  const {
    STORAGE_KEYS,
    RESOURCES,
    REAPER_RANKS,
    DEFAULT_AUTOMATION,
    MAX_HISTORY_PER_RESOURCE,
    MAX_REAPER_EXP,
    canonicalReaperRank,
    reaperProgress,
    normalizeAutomation,
    normalizeText,
    validReaperExp,
    sampleWeight,
    weightedMedian,
    parseNumber,
    parseLimit,
    normalizeMarketOffers
  } = window.HMH_SHARED;
  const STORAGE_KEY = STORAGE_KEYS.market;
  const HISTORY_KEY = STORAGE_KEYS.history;
  const POSITION_KEY = STORAGE_KEYS.panelPosition;
  const AUTOMATION_KEY = STORAGE_KEYS.automation;
  const BOT_STATUS_KEY = STORAGE_KEYS.botStatus;
  const BOT_RUNTIME_KEY = STORAGE_KEYS.botRuntime;
  const FAIRY_OFFERS_KEY = STORAGE_KEYS.fairyOffers;
  const REAPER_EXP_KEY = STORAGE_KEYS.reaperExp;
  const REAPER_PROFILE_KEY = STORAGE_KEYS.reaperProfile;

  let automation = { ...DEFAULT_AUTOMATION };
  let botStatus = { text: 'Остановлен', ts: 0 };
  let fairyOffers = { updatedAt: 0, offers: [] };
  let reaperExp = { samples: [] };
  let reaperProfile = null;

  let state = {
    loading: false,
    updatedAt: null,
    data: Object.create(null),
    error: null
  };

  const root = document.createElement('div');
  root.id = 'hmh-root';
  root.innerHTML = `
    <div class="hmh-head">
      <div>
        <div class="hmh-title">Haddan Market Helper</div>
        <div class="hmh-subtitle">Жнец · лучшие цены скупки</div>
      </div>
      <button class="hmh-icon-btn" id="hmh-collapse" title="Свернуть">−</button>
      <button class="hmh-icon-btn" id="hmh-close" title="Скрыть">×</button>
    </div>
    <div class="hmh-body">
      <div class="hmh-toolbar">
        <button class="hmh-refresh" id="hmh-refresh">Обновить цены</button>
        <div class="hmh-status" id="hmh-status">Готово к сканированию</div>
      </div>
      <div class="hmh-auto-box">
        <div class="hmh-auto-head">
          <b>Поляна Auto</b>
          <span id="hmh-bot-status">Остановлен</span>
        </div>
        <label class="hmh-check hmh-main-check"><input type="checkbox" id="hmh-collect-resources"> Собирать ресурсы</label>
        <div class="hmh-resource-options" id="hmh-resource-options">
          <label class="hmh-radio"><input type="radio" name="hmh-resource-mode" value="profit"> Максимальная выгода</label>
          <label class="hmh-radio"><input type="radio" name="hmh-resource-mode" value="experience"> Максимальный опыт</label>
          <div class="hmh-rank-row">
            <span>Жнец:</span>
            <span id="hmh-reaper-profile" class="hmh-reaper-profile">определится при START</span>
          </div>
        </div>
        <div class="hmh-captcha-settings">
          <label class="hmh-check hmh-main-check"><input type="checkbox" id="hmh-solve-captcha"> Решать CAPTCHA</label>
          <label class="hmh-api-row">
            <span>API token:</span>
            <input type="password" id="hmh-captcha-api-token" autocomplete="off" spellcheck="false" placeholder="token">
          </label>
          <div class="hmh-captcha-dev-note">При появлении проверки здесь будет показан ход распознавания и ввода.</div>
          <div class="hmh-captcha-progress" id="hmh-captcha-progress" hidden>
            <div class="hmh-captcha-progress-head">
              <span id="hmh-captcha-progress-title">CAPTCHA</span>
              <span id="hmh-captcha-progress-step"></span>
            </div>
            <div class="hmh-captcha-progress-track"><span id="hmh-captcha-progress-bar"></span></div>
            <div class="hmh-captcha-progress-detail" id="hmh-captcha-progress-detail"></div>
          </div>
        </div>
        <div class="hmh-skill-row">
          <span class="hmh-skill-label">Фея:</span>
          <span id="hmh-fairy-name" class="hmh-skill-name">автопоиск</span>
          <button id="hmh-capture-fairy" class="hmh-small-btn">Выбрать</button>
        </div>
        <div class="hmh-auto-actions">
          <button id="hmh-bot-start" class="hmh-start-btn">START</button>
          <button id="hmh-bot-stop" class="hmh-stop-btn">STOP</button>
        </div>
        <div class="hmh-auto-hint" id="hmh-auto-hint">Бой проводит штатный автобой Haddan. Плагин ждёт его завершения и продолжает цикл Поляны.</div>
      </div>
      <div class="hmh-note">Магазины с <b>coin-copper</b> полностью игнорируются.</div>
      <div id="hmh-content"></div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const $ = (selector) => root.querySelector(selector);
  const refreshButton = $('#hmh-refresh');
  const statusEl = $('#hmh-status');
  const contentEl = $('#hmh-content');
  const headEl = root.querySelector('.hmh-head');
  const collectResourcesEl = $('#hmh-collect-resources');
  const resourceModeEls = [...root.querySelectorAll('input[name="hmh-resource-mode"]')];
  const resourceOptionsEl = $('#hmh-resource-options');
  const reaperProfileEl = $('#hmh-reaper-profile');
  const solveCaptchaEl = $('#hmh-solve-captcha');
  const captchaApiTokenEl = $('#hmh-captcha-api-token');
  const captchaProgressEl = $('#hmh-captcha-progress');
  const captchaProgressTitleEl = $('#hmh-captcha-progress-title');
  const captchaProgressStepEl = $('#hmh-captcha-progress-step');
  const captchaProgressBarEl = $('#hmh-captcha-progress-bar');
  const captchaProgressDetailEl = $('#hmh-captcha-progress-detail');
  const fairyNameEl = $('#hmh-fairy-name');
  const captureFairyEl = $('#hmh-capture-fairy');
  const botStartEl = $('#hmh-bot-start');
  const botStopEl = $('#hmh-bot-stop');
  const botStatusEl = $('#hmh-bot-status');
  const autoHintEl = $('#hmh-auto-hint');

  initDragging();
  initAutomationUi();


  function actionDisplayName(action) {
    if (!action) return 'автопоиск';
    return action.label || action.title || action.value || action.hrefPath || 'выбранное действие';
  }

  function captchaUiState() {
    const text = String(botStatus?.text || '');
    if (botStatus?.kind === 'captcha') return botStatus;
    if (!/captcha/i.test(text)) return null;
    return {
      kind: 'captcha',
      phase: /ручн|manual/i.test(text) ? 'manual' : 'waiting',
      progress: 0,
      text,
      detail: text
    };
  }

  function captchaShortLabel(state) {
    const phase = String(state?.phase || '');
    const current = Number(state?.current || 0);
    const total = Number(state?.total || 0);
    if (phase === 'preparing') return 'CAPTCHA · подготовка';
    if (phase === 'api') return 'CAPTCHA · API';
    if (phase === 'decoded') return 'CAPTCHA · распознано';
    if (phase === 'verifying') return 'CAPTCHA · проверка';
    if (phase === 'input') return total ? `CAPTCHA · ввод ${current}/${total}` : 'CAPTCHA · ввод';
    if (phase === 'submitting') return 'CAPTCHA · отправка';
    if (phase === 'waiting') return 'CAPTCHA · жду переход';
    if (phase === 'done') return 'CAPTCHA · пройдена';
    if (phase === 'error') return 'CAPTCHA · ошибка';
    if (phase === 'manual') return 'CAPTCHA · вручную';
    return 'CAPTCHA';
  }

  function renderCaptchaProgress(state) {
    const active = !!state && automation.running;
    captchaProgressEl.hidden = !active;
    if (!active) return;

    const phase = String(state.phase || '');
    const progress = Math.max(0, Math.min(100, Number(state.progress || 0)));
    const current = Number(state.current || 0);
    const total = Number(state.total || 0);

    captchaProgressEl.classList.toggle('hmh-captcha-progress-error', phase === 'error');
    captchaProgressEl.classList.toggle('hmh-captcha-progress-manual', phase === 'manual');
    captchaProgressEl.classList.toggle('hmh-captcha-progress-done', phase === 'done');
    captchaProgressTitleEl.textContent = automation.solveCaptcha && phase !== 'manual'
      ? 'CAPTCHA · авто'
      : 'CAPTCHA · ручной режим';
    captchaProgressStepEl.textContent = total && current
      ? `${current}/${total}`
      : (progress ? `${Math.round(progress)}%` : '');
    captchaProgressBarEl.style.width = `${progress}%`;
    captchaProgressDetailEl.textContent = String(state.detail || state.text || captchaShortLabel(state));
  }

  function renderAutomationUi() {
    collectResourcesEl.checked = !!automation.collectResources;
    for (const radio of resourceModeEls) radio.checked = radio.value === automation.resourceMode;
    for (const radio of resourceModeEls) radio.disabled = !automation.collectResources;
    const currentProfile = reaperProfile && Number.isFinite(Number(reaperProfile.exp))
      ? reaperProfile
      : null;
    if (currentProfile) {
      const progress = reaperProgress(currentProfile.exp, currentProfile.rank);
      const sessionGain = Number(currentProfile.sessionGainedExp || 0);
      const suffix = progress?.nextExp != null
        ? `${formatNumber(progress.exp, 0)} / ${formatNumber(progress.nextExp, 0)} · до «${progress.nextRank}» ${formatNumber(progress.remaining, 0)}`
        : `${formatNumber(progress?.exp ?? currentProfile.exp, 0)} · максимальный ранг`;
      const sourceMark = currentProfile.sessionStartedAt
        ? (currentProfile.sessionSource === 'cache' ? ' · кеш' : '')
        : '';
      const gainMark = currentProfile.sessionStartedAt && sessionGain > 0 ? ` · +${formatNumber(sessionGain, 0)} за сеанс` : '';
      reaperProfileEl.textContent = `${progress?.rank || currentProfile.rank} · ${suffix}${gainMark}${sourceMark}`;
      reaperProfileEl.title = currentProfile.sessionStartedAt
        ? `Снимок при START: ${formatNumber(currentProfile.sessionStartExp, 0)} опыта. Во время сеанса опыт и ранг считаются локально, без дополнительных запросов.`
        : 'Последние известные данные профиля. При START профиль будет перечитан.';
    } else {
      reaperProfileEl.textContent = 'определится при START';
      reaperProfileEl.title = 'При START расширение один раз прочитает профиль персонажа.';
    }
    solveCaptchaEl.checked = !!automation.solveCaptcha;
    captchaApiTokenEl.value = automation.captchaApiToken || '';
    captchaApiTokenEl.disabled = !automation.solveCaptcha;
    resourceOptionsEl.classList.toggle('hmh-options-disabled', !automation.collectResources);
    fairyNameEl.textContent = automation.selectedFairy ? actionDisplayName(automation.selectedFairy) : 'автопоиск';
    fairyNameEl.title = automation.selectedFairy ? JSON.stringify(automation.selectedFairy) : 'Плагин попробует найти Фею по названию автоматически';
    captureFairyEl.textContent = automation.captureFairy ? 'Кликни Фею…' : (automation.selectedFairy ? 'Сменить' : 'Выбрать');
    captureFairyEl.classList.toggle('hmh-capture-active', !!automation.captureFairy);
    botStartEl.disabled = !!automation.running || !automation.collectResources;
    botStopEl.disabled = !automation.running && !automation.captureFairy;
    const captchaState = captchaUiState();
    botStatusEl.textContent = automation.captureFairy
      ? 'ожидаю Фею'
      : (automation.running ? (captchaState ? captchaShortLabel(captchaState) : (botStatus.text || 'Работает')) : 'Остановлен');
    root.classList.toggle('hmh-bot-running', !!automation.running);
    const captchaPause = automation.running && !!captchaState;
    const captchaProblem = captchaPause && ['manual', 'error'].includes(String(captchaState?.phase || ''));
    const captchaDone = captchaPause && String(captchaState?.phase || '') === 'done';
    root.classList.toggle('hmh-captcha-pause', captchaPause);
    root.classList.toggle('hmh-captcha-auto', captchaPause && !captchaProblem && !captchaDone);
    root.classList.toggle('hmh-captcha-problem', captchaProblem);
    root.classList.toggle('hmh-captcha-done', captchaDone);
    renderCaptchaProgress(captchaState);

    if (captchaPause) {
      autoHintEl.textContent = String(captchaState.detail || captchaState.text || 'CAPTCHA: обработка проверки…');
    } else if (automation.captureFairy) {
      autoHintEl.textContent = 'Теперь один раз нажми на Фею. Клик пройдет в игру и одновременно сохранится.';
    } else if (automation.running) {
      if (!automation.collectResources) {
        autoHintEl.textContent = 'Сбор ресурсов выключен. Плагин ничего не нажимает на Поляне.';
      } else if (automation.resourceMode === 'experience') {
        autoHintEl.textContent = `Бот активен. Выбор: максимальный опыт для текущего ранга «${reaperProfile?.rank || automation.reaperRank}»; опыт и переход ранга считаются локально.`;
      } else {
        autoHintEl.textContent = 'Бот активен. Выбор: максимальная рыночная выгода. Бой проводит штатный автобой Haddan.';
      }
    } else if (!automation.collectResources) {
      autoHintEl.textContent = 'Сбор ресурсов выключен. START недоступен, автоматические переходы и клики отключены.';
    } else if (automation.resourceMode === 'experience') {
      autoHintEl.textContent = 'При START расширение один раз читает профиль Жнеца; дальше опыт и ранг считаются локально по полученным наградам.';
    } else {
      autoHintEl.textContent = 'Цены не обновляются автоматически: Фея использует последний рыночный кеш. Бой оставлен штатному автобою Haddan.';
    }
  }

  async function saveAutomation(patch) {
    automation = normalizeAutomation({ ...automation, ...patch });
    await chrome.storage.local.set({ [AUTOMATION_KEY]: automation });
    renderAutomationUi();
  }

  async function clearTransientAutomationRuntime() {
    try {
      const stored = await chrome.storage.local.get(BOT_RUNTIME_KEY);
      const current = stored[BOT_RUNTIME_KEY] || {};
      await chrome.storage.local.set({
        [BOT_RUNTIME_KEY]: {
          ...current,
          pendingReward: false,
          pendingRewardSince: 0,
          pendingRewardResource: '',
          pendingRewardResourceId: '',
          pendingRewardQuantity: 0,
          pendingRewardRankKey: '',
          rewardChoiceAt: 0,
          rewardChoiceDocumentStartedAt: 0,
          rewardAcknowledgingUntil: 0,
          rewardAckStartedAt: 0,
          lastRewardCapturedAt: 0,
          lastRewardCapturedExp: null,
          lastRewardCapturedResourceId: '',
          lastRewardCapturedQuantity: 0,
          battleExpectedUntil: 0,
          battleActive: false,
          battleRecoveryLastClickAt: 0,
          battleRecoveryAttempts: 0,
          fairyCooldownTransitionUntil: 0
        }
      });
    } catch (e) {
      console.warn('[Haddan Market Helper] runtime reset failed', e);
    }
  }

  async function initAutomationUi() {
    try {
      const stored = await chrome.storage.local.get([AUTOMATION_KEY, BOT_STATUS_KEY, REAPER_PROFILE_KEY]);
      const rawAutomation = stored[AUTOMATION_KEY] || {};
      const detectedRank = stored[REAPER_PROFILE_KEY]?.rank || '';
      automation = normalizeAutomation(rawAutomation, detectedRank);
      botStatus = stored[BOT_STATUS_KEY] || botStatus;

      const needsMigration = Object.prototype.hasOwnProperty.call(rawAutomation, 'autoFairy') ||
        !Object.prototype.hasOwnProperty.call(rawAutomation, 'collectResources') ||
        !Object.prototype.hasOwnProperty.call(rawAutomation, 'resourceMode') ||
        !Object.prototype.hasOwnProperty.call(rawAutomation, 'solveCaptcha') ||
        !Object.prototype.hasOwnProperty.call(rawAutomation, 'captchaApiToken') ||
        !canonicalReaperRank(rawAutomation.reaperRank);
      if (needsMigration) await chrome.storage.local.set({ [AUTOMATION_KEY]: automation });
    } catch (e) {
      console.warn('[Haddan Market Helper] automation restore failed', e);
    }
    renderAutomationUi();

    collectResourcesEl.addEventListener('change', async () => {
      const enabled = collectResourcesEl.checked;
      await saveAutomation({
        collectResources: enabled,
        // Turning off the master checkbox must stop every automatic click.
        running: enabled ? automation.running : false,
        captureFairy: enabled ? automation.captureFairy : false
      });
      if (!enabled) await clearTransientAutomationRuntime();
    });
    for (const radio of resourceModeEls) {
      radio.addEventListener('change', () => {
        if (radio.checked) saveAutomation({ resourceMode: radio.value });
      });
    }
    solveCaptchaEl.addEventListener('change', () => saveAutomation({ solveCaptcha: solveCaptchaEl.checked }));
    captchaApiTokenEl.addEventListener('change', () => saveAutomation({ captchaApiToken: captchaApiTokenEl.value.trim() }));

    captureFairyEl.addEventListener('click', async () => {
      if (automation.captureFairy) {
        await saveAutomation({ captureFairy: false });
        return;
      }
      await saveAutomation({ running: false, captureFairy: true });
    });

    botStartEl.addEventListener('click', async () => {
      botStartEl.disabled = true;
      await chrome.storage.local.set({
        [BOT_STATUS_KEY]: { text: 'Жнец: читаю профиль перед START…', ts: Date.now() }
      });

      const freshProfile = await refreshReaperProfile({ startSession: true });
      let sessionProfile = freshProfile;
      if (!sessionProfile && reaperProfile && Number.isFinite(Number(reaperProfile.exp))) {
        sessionProfile = beginReaperSession(reaperProfile, 'cache');
        reaperProfile = sessionProfile;
        await chrome.storage.local.set({ [REAPER_PROFILE_KEY]: sessionProfile });
      }

      if (!sessionProfile) {
        await chrome.storage.local.set({
          [BOT_STATUS_KEY]: { text: 'START отменён: не удалось определить опыт Жнеца', ts: Date.now() }
        });
        renderAutomationUi();
        return;
      }

      await saveAutomation({
        running: true,
        captureFairy: false,
        reaperRank: sessionProfile.rank
      });
    });

    botStopEl.addEventListener('click', async () => {
      await saveAutomation({ running: false, captureFairy: false });
      await clearTransientAutomationRuntime();
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes[AUTOMATION_KEY]?.newValue) {
        automation = normalizeAutomation(changes[AUTOMATION_KEY].newValue || {}, reaperProfile?.rank || '');
        render();
      }
      if (changes[BOT_STATUS_KEY]?.newValue) {
        botStatus = changes[BOT_STATUS_KEY].newValue;
      }
      if (changes[FAIRY_OFFERS_KEY]) {
        fairyOffers = changes[FAIRY_OFFERS_KEY].newValue || { updatedAt: 0, offers: [] };
        render();
      }
      if (changes[REAPER_EXP_KEY]) {
        reaperExp = changes[REAPER_EXP_KEY].newValue || { samples: [] };
        render();
      }
      if (changes[REAPER_PROFILE_KEY]) {
        reaperProfile = changes[REAPER_PROFILE_KEY].newValue || null;
        render();
      }
      renderAutomationUi();
    });
  }

  function clampPanelPosition(left, top) {
    const rect = root.getBoundingClientRect();
    const width = rect.width || 430;
    const height = rect.height || 44;
    const minVisible = 48;
    const maxLeft = Math.max(0, window.innerWidth - minVisible);
    const minLeft = Math.min(0, minVisible - width);
    const maxTop = Math.max(0, window.innerHeight - minVisible);

    return {
      left: Math.min(maxLeft, Math.max(minLeft, left)),
      top: Math.min(maxTop, Math.max(0, top))
    };
  }

  function applyPanelPosition(position) {
    if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return;
    const next = clampPanelPosition(position.left, position.top);
    root.style.left = `${next.left}px`;
    root.style.top = `${next.top}px`;
    root.style.right = 'auto';
  }

  async function savePanelPosition() {
    const rect = root.getBoundingClientRect();
    const next = clampPanelPosition(rect.left, rect.top);
    try {
      await chrome.storage.local.set({ [POSITION_KEY]: next });
    } catch (e) {
      console.warn('[Haddan Market Helper] position save failed', e);
    }
  }

  async function restorePanelPosition() {
    try {
      const stored = await chrome.storage.local.get(POSITION_KEY);
      applyPanelPosition(stored[POSITION_KEY]);
    } catch (e) {
      console.warn('[Haddan Market Helper] position restore failed', e);
    }
  }

  async function resetPanelPosition() {
    root.style.left = '';
    root.style.top = '28px';
    root.style.right = '12px';
    try {
      await chrome.storage.local.remove(POSITION_KEY);
    } catch (e) {
      console.warn('[Haddan Market Helper] position reset failed', e);
    }
  }

  function initDragging() {
    let dragging = false;
    let pointerId = null;
    let grabX = 0;
    let grabY = 0;

    headEl.title = 'Перетащи окно мышью. Двойной клик — вернуть позицию.';

    headEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('button, a, input, select, textarea')) return;

      const rect = root.getBoundingClientRect();
      dragging = true;
      pointerId = event.pointerId;
      grabX = event.clientX - rect.left;
      grabY = event.clientY - rect.top;
      root.classList.add('hmh-dragging');
      headEl.setPointerCapture?.(pointerId);
      event.preventDefault();
    });

    headEl.addEventListener('pointermove', (event) => {
      if (!dragging || event.pointerId !== pointerId) return;
      const next = clampPanelPosition(event.clientX - grabX, event.clientY - grabY);
      root.style.left = `${next.left}px`;
      root.style.top = `${next.top}px`;
      root.style.right = 'auto';
      event.preventDefault();
    });

    const stopDragging = (event) => {
      if (!dragging || (event && event.pointerId != null && event.pointerId !== pointerId)) return;
      dragging = false;
      root.classList.remove('hmh-dragging');
      if (pointerId != null) {
        try { headEl.releasePointerCapture?.(pointerId); } catch (_) {}
      }
      pointerId = null;
      savePanelPosition();
    };

    headEl.addEventListener('pointerup', stopDragging);
    headEl.addEventListener('pointercancel', stopDragging);

    headEl.addEventListener('dblclick', (event) => {
      if (event.target.closest('button, a, input, select, textarea')) return;
      resetPanelPosition();
    });

    window.addEventListener('resize', () => {
      if (!root.style.left) return;
      const rect = root.getBoundingClientRect();
      applyPanelPosition({ left: rect.left, top: rect.top });
      savePanelPosition();
    });

    restorePanelPosition();
  }

  $('#hmh-collapse').addEventListener('click', () => {
    root.classList.toggle('hmh-collapsed');
    $('#hmh-collapse').textContent = root.classList.contains('hmh-collapsed') ? '+' : '−';
  });

  $('#hmh-close').addEventListener('click', () => {
    root.style.display = 'none';
  });

  refreshButton.addEventListener('click', () => scanAll());

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'HMH_TOGGLE') {
      root.style.display = root.style.display === 'none' ? '' : 'none';
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'HMH_REFRESH') {
      scanAll().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
  });

  function detectMoneyLevel(row) {
    const img = row.querySelector('td:first-child img');
    const src = (img?.getAttribute('src') || '').toLowerCase();
    const alt = (img?.getAttribute('alt') || '').toLowerCase();

    if (src.includes('coin-copper') || alt.includes('мало денег')) return 'copper';
    if (src.includes('coin-silver') || alt.includes('немного денег')) return 'silver';
    if (src.includes('coin-gold') || alt.includes('много денег')) return 'gold';
    return 'unknown';
  }

  function parseMarketHtml(html, resource) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = [...doc.querySelectorAll('#mainTableBody > tr')];

    const rawOffers = [];

    for (const row of rows) {
      const cells = row.querySelectorAll(':scope > td');
      if (cells.length < 7) continue;

      const moneyLevel = detectMoneyLevel(row);

      const shopLink = cells[1].querySelector('a');
      const shopName = (shopLink?.textContent || cells[1].textContent || '').replace(/\s+/g, ' ').trim();
      const shopHref = shopLink?.getAttribute('href') || '';
      const itemName = (cells[2].textContent || '').replace(/\s+/g, ' ').trim();
      const buyLimit = parseLimit(cells[3].textContent);
      const stock = parseNumber(cells[4].textContent) ?? 0;
      const sellPrice = parseNumber(cells[5].textContent) ?? 0;
      const buyPrice = parseNumber(cells[6].textContent) ?? 0;

      rawOffers.push({
        itemName,
        shopName,
        shopHref,
        moneyLevel,
        buyLimit,
        stock,
        sellPrice,
        buyPrice
      });
    }

    return normalizeMarketOffers(rawOffers, resource);
  }

  async function fetchTextWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      return { response, text };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`таймаут запроса ${Math.round(timeoutMs / 1000)} с`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchResource(resource) {
    const body = new URLSearchParams();
    body.set('needle', resource.name);
    body.set('thingType', resource.id);

    const endpoint = new URL('/room/func/shopsearch.php', location.origin).toString();
    const { response, text: html } = await fetchTextWithTimeout(endpoint, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
      },
      body: body.toString()
    }, 15000);

    if (!response.ok) {
      throw new Error(`${resource.name}: HTTP ${response.status}`);
    }

    if (!html.includes('mainTableBody')) {
      throw new Error(`${resource.name}: ответ не похож на страницу поиска (возможно, сессия закончилась)`);
    }

    return parseMarketHtml(html, resource);
  }

  async function scanAll() {
    if (state.loading) return;

    state.loading = true;
    state.error = null;
    refreshButton.disabled = true;
    refreshButton.textContent = 'Сканирование…';
    render();

    const nextData = Object.create(null);

    try {
      for (let i = 0; i < RESOURCES.length; i++) {
        const resource = RESOURCES[i];
        statusEl.textContent = `${i + 1}/${RESOURCES.length}: ${resource.name}`;
        nextData[resource.id] = await fetchResource(resource);
        if (i < RESOURCES.length - 1) await sleep(160);
      }

      state.data = nextData;
      state.updatedAt = Date.now();
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          updatedAt: state.updatedAt,
          data: state.data
        }
      });
      await appendHistory(nextData, state.updatedAt);
    } catch (error) {
      console.error('[Haddan Market Helper]', error);
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false;
      refreshButton.disabled = false;
      refreshButton.textContent = 'Обновить цены';
      render();
    }
  }

  async function appendHistory(data, timestamp) {
    const stored = await chrome.storage.local.get(HISTORY_KEY);
    const history = stored[HISTORY_KEY] || {};

    for (const resource of RESOURCES) {
      const offers = data[resource.id] || [];
      const best = offers[0];
      if (!best) continue;

      const arr = Array.isArray(history[resource.id]) ? history[resource.id] : [];
      arr.push({
        ts: timestamp,
        buyPrice: best.buyPrice,
        shopName: best.shopName,
        moneyLevel: best.moneyLevel,
        buyLimit: best.buyLimit
      });
      history[resource.id] = arr.slice(-MAX_HISTORY_PER_RESOURCE);
    }

    await chrome.storage.local.set({ [HISTORY_KEY]: history });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatNumber(value, maximumFractionDigits = 2) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return Number(value).toLocaleString('ru-RU', { maximumFractionDigits });
  }

  function profileRankKey() {
    return normalizeText(reaperProfile?.rank || automation.reaperRank || '').toLowerCase() || 'unknown';
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
    const value = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    return { value, min, max, exact: true, samples: total };
  }

  function predictProfessionalExp(resourceId, quantity) {
    if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) return null;
    const rankKey = profileRankKey();
    const samples = (Array.isArray(reaperExp?.samples) ? reaperExp.samples : [])
      .filter((sample) => sample.resourceId === resourceId && sample.rankKey === rankKey)
      .slice(-800);
    if (!samples.length) return null;

    const exact = exactExperienceSummary(samples, quantity);
    if (exact) return exact;

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
      value: Math.min(MAX_REAPER_EXP, Math.max(0, Math.round(Number(quantity) * ratio))),
      min: null,
      max: null,
      exact: false,
      samples: ratios.reduce((sum, entry) => sum + entry.weight, 0)
    };
  }

  function currentFairyOffer(resourceId) {
    const age = Date.now() - Number(fairyOffers?.updatedAt || 0);
    if (age > 20 * 60 * 1000) return null;
    return (Array.isArray(fairyOffers?.offers) ? fairyOffers.offers : []).find((offer) => offer.resourceId === resourceId) || null;
  }

  function formatProfessionalExpCell(resourceId) {
    const offer = currentFairyOffer(resourceId);
    if (!offer) return '<span class="hmh-muted">—</span>';
    const prediction = predictProfessionalExp(resourceId, Number(offer.quantity));
    if (!prediction) {
      return `<div class="hmh-exp-cell" title="Сейчас Фея предлагает ${formatNumber(offer.quantity, 0)} шт. Точных данных по проф. опыту ещё нет."><b>?</b><small>${formatNumber(offer.quantity, 0)} шт.</small></div>`;
    }
    let value;
    if (prediction.exact && prediction.min !== prediction.max) {
      value = `${formatNumber(prediction.min, 0)}–${formatNumber(prediction.max, 0)}`;
    } else {
      value = `${prediction.exact ? '' : '≈'}${formatNumber(prediction.value, 0)}`;
    }
    const source = prediction.exact
      ? `Фактические наблюдения: ${prediction.samples}`
      : `Оценка по ${prediction.samples} прошлым наградам этого ресурса на выбранном ранге`;
    return `<div class="hmh-exp-cell" title="${escapeHtml(`Фея: ${offer.quantity} шт. · ${source}`)}"><b>${escapeHtml(value)}</b><small>${formatNumber(offer.quantity, 0)} шт.</small></div>`;
  }

  function parseReaperProfile(text) {
    const src = normalizeText(text);
    const match = src.match(/Жнец\s*:\s*([^()]{2,60}?)\s*\(\s*Опыт\s*:\s*([\d\s]+)\s*\)/i);
    if (!match) return null;
    const serverRank = canonicalReaperRank(normalizeText(match[1]));
    const exp = Number(String(match[2]).replace(/\s+/g, ''));
    if (!serverRank || !Number.isFinite(exp)) return null;
    const progress = reaperProgress(exp, serverRank);
    if (!progress) return null;
    return {
      rank: progress.rank,
      exp: progress.exp,
      nextRank: progress.nextRank,
      nextExp: progress.nextExp,
      remaining: progress.remaining,
      updatedAt: Date.now()
    };
  }

  function beginReaperSession(profile, source = 'profile') {
    if (!profile || !Number.isFinite(Number(profile.exp))) return null;
    const progress = reaperProgress(profile.exp, profile.rank);
    if (!progress) return null;
    const now = Date.now();
    return {
      ...profile,
      rank: progress.rank,
      exp: progress.exp,
      nextRank: progress.nextRank,
      nextExp: progress.nextExp,
      remaining: progress.remaining,
      updatedAt: now,
      sessionStartedAt: now,
      sessionStartExp: progress.exp,
      sessionGainedExp: 0,
      sessionRewards: 0,
      sessionSource: source,
      lastAppliedRewardKey: '',
      rankChangedAt: 0
    };
  }

  async function refreshReaperProfile({ startSession = false } = {}) {
    try {
      const { response, text: html } = await fetchTextWithTimeout(new URL('/info/info.php', location.origin), {
        credentials: 'include', cache: 'no-store'
      }, 12000);
      if (!response.ok) return null;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      let profile = parseReaperProfile(doc.body?.innerText || doc.body?.textContent || '');
      if (!profile) return null;
      if (startSession) profile = beginReaperSession(profile, 'profile');
      reaperProfile = profile;
      await chrome.storage.local.set({ [REAPER_PROFILE_KEY]: profile });
      render();
      renderAutomationUi();
      return profile;
    } catch (_) {
      return null;
    }
  }

  function formatLimit(value) {
    return value == null ? 'без лимита*' : formatNumber(value, 0);
  }

  function moneyLabel(level) {
    if (level === 'gold') return '<span class="hmh-money hmh-money-gold">● много</span>';
    if (level === 'silver') return '<span class="hmh-money hmh-money-silver">● немного</span>';
    return '<span class="hmh-money">● ?</span>';
  }

  function render() {
    if (state.loading && !Object.keys(state.data).length) {
      contentEl.innerHTML = '<div class="hmh-empty">Получаю данные рынка…</div>';
      return;
    }

    if (state.error) {
      statusEl.innerHTML = `<span class="hmh-error">${escapeHtml(state.error)}</span>`;
    } else if (state.updatedAt) {
      statusEl.textContent = `Обновлено ${new Date(state.updatedAt).toLocaleTimeString('ru-RU')}`;
    } else {
      statusEl.textContent = 'Готово к сканированию';
    }

    const hasData = RESOURCES.some((r) => Array.isArray(state.data[r.id]));
    if (!hasData) {
      contentEl.innerHTML = '<div class="hmh-empty">Нажми «Обновить цены».</div>';
      return;
    }

    const rows = [];
    for (const resource of RESOURCES) {
      const offers = state.data[resource.id] || [];
      const best = offers[0];
      const detailId = `hmh-details-${resource.id}`;

      if (!best) {
        rows.push(`
          <tr class="hmh-row" data-details="${detailId}">
            <td>${escapeHtml(resource.name)}</td>
            <td>${formatProfessionalExpCell(resource.id)}</td>
            <td class="hmh-muted">—</td>
            <td class="hmh-muted">—</td>
            <td class="hmh-muted">нет скупки</td>
          </tr>
          <tr class="hmh-details" id="${detailId}"><td colspan="5"><div class="hmh-details-wrap">Подходящих магазинов нет.</div></td></tr>
        `);
        continue;
      }

      const topOffers = offers.slice(0, 8);
      const details = topOffers.map((offer) => {
        const href = offer.shopHref ? new URL(offer.shopHref, location.origin).toString() : '';
        const shop = href
          ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(offer.shopName)}</a>`
          : escapeHtml(offer.shopName);
        return `
          <div class="hmh-shop-line">
            <div>${moneyLabel(offer.moneyLevel)}</div>
            <div class="hmh-shop">${shop}</div>
            <div class="hmh-price">${formatNumber(offer.buyPrice)}</div>
            <div title="Лимит скупки">${formatLimit(offer.buyLimit)}</div>
          </div>
        `;
      }).join('');

      rows.push(`
        <tr class="hmh-row" data-details="${detailId}">
          <td>${escapeHtml(resource.name)}</td>
          <td>${formatProfessionalExpCell(resource.id)}</td>
          <td class="hmh-price">${formatNumber(best.buyPrice)}</td>
          <td>${formatLimit(best.buyLimit)}</td>
          <td title="${escapeHtml(best.shopName)}">${escapeHtml(best.shopName)}</td>
        </tr>
        <tr class="hmh-details" id="${detailId}">
          <td colspan="5">
            <div class="hmh-details-wrap">
              ${details}
              ${offers.length > topOffers.length ? `<div class="hmh-muted" style="padding-top:5px">Ещё магазинов: ${offers.length - topOffers.length}</div>` : ''}
            </div>
          </td>
        </tr>
      `);
    }

    contentEl.innerHTML = `
      <table class="hmh-table">
        <thead>
          <tr><th>Ресурс</th><th>Проф. опыт</th><th>Скупка</th><th>Лимит</th><th>Магазин</th></tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
      </table>
      <div class="hmh-note">Проф. опыт показывается для текущего автоматически определённого ранга Жнеца: <b>${escapeHtml(reaperProfile?.rank || automation.reaperRank)}</b>. При START профиль читается один раз, затем опыт и переход ранга считаются локально. <b>≈</b> — оценка по уже полученным наградам; <b>?</b> — данных ещё нет.</div>
      <div class="hmh-note">* «нет» в колонке лимита пока трактуется как отсутствие числового лимита. Это отдельно проверим на поведении магазина.</div>
    `;

    contentEl.querySelectorAll('.hmh-row').forEach((row) => {
      row.addEventListener('click', () => {
        const details = document.getElementById(row.dataset.details);
        details?.classList.toggle('hmh-open');
      });
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function restore() {
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEY, FAIRY_OFFERS_KEY, REAPER_EXP_KEY, REAPER_PROFILE_KEY, AUTOMATION_KEY]);
      const cached = stored[STORAGE_KEY];
      if (cached?.data) {
        state.data = cached.data;
        state.updatedAt = cached.updatedAt || null;
      }
      fairyOffers = stored[FAIRY_OFFERS_KEY] || { updatedAt: 0, offers: [] };
      reaperExp = stored[REAPER_EXP_KEY] || { samples: [] };
      reaperProfile = stored[REAPER_PROFILE_KEY] || null;
      automation = normalizeAutomation(stored[AUTOMATION_KEY] || {}, reaperProfile?.rank || '');
    } catch (e) {
      console.warn('[Haddan Market Helper] cache restore failed', e);
    }
    render();
    renderAutomationUi();
  }

  restore();
})();
