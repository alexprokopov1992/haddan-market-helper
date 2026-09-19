async function send(type) {
  const status = document.getElementById('status');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/(www\.|ru\.)?haddan\.ru\//i.test(tab.url || '')) {
      status.textContent = 'Открой Haddan в активной вкладке.';
      return;
    }
    await chrome.tabs.sendMessage(tab.id, { type });
    status.textContent = type === 'HMH_REFRESH' ? 'Обновление запущено.' : 'Готово.';
  } catch (e) {
    status.textContent = 'Перезагрузи страницу Haddan после установки расширения.';
  }
}

document.getElementById('toggle').addEventListener('click', () => send('HMH_TOGGLE'));
document.getElementById('refresh').addEventListener('click', () => send('HMH_REFRESH'));
