(() => {
  const $ = id => document.getElementById(id);
  const logBox = $('log');
  const btnStart = $('btn-start');
  const btnCancel = $('btn-cancel');
  const downloadArea = $('download-area');

  let port = null;
  let running = false;

  // ---- Load settings and apply defaults ----
  (async function init() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab?.url) {
        const m = tab.url.match(/BV[a-zA-Z0-9]+/);
        if (m) {
          $('bvid').value = m[0];
          $('auto-detect-hint').textContent = `✅ 已自动识别: ${m[0]}`;
        } else if (tab.url.includes('bilibili.com')) {
          $('auto-detect-hint').textContent = '📌 当前在B站但未检测到视频BV号';
        }
      }
    } catch (e) {}

    // Load user settings
    try {
      const s = await chrome.storage.sync.get('settings');
      const cfg = s.settings || {};
      $('chk-danmaku').checked = cfg.defaultDanmaku !== undefined ? cfg.defaultDanmaku : true;
      $('chk-comments').checked = !!cfg.defaultComments;
      $('chk-subtitle').checked = !!cfg.defaultSubtitle;
      $('chk-replies').checked = !!cfg.defaultReplies;
      $('max-pages').value = cfg.defaultMaxPages || 0;
      if (cfg.defaultFormat) $('save-fmt').value = cfg.defaultFormat;
      if (cfg.defaultSubLan) $('sub-lan').value = cfg.defaultSubLan;

      // Auto-cookie
      if (cfg.autoCookie) {
        try {
          const cookies = await chrome.cookies.getAll({ domain: '.bilibili.com' });
          const parts = cookies.map(c => `${c.name}=${c.value}`);
          if (parts.length > 0) {
            $('cookie').value = parts.join('; ');
            $('auto-detect-hint').textContent += ' 🍪Cookie已自动填充';
          }
        } catch (e) {}
      }
    } catch (e) {}
  })();

  // Settings button
  $('btn-settings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // ---- Connection management ----
  function connect() {
    if (port) try { port.disconnect(); } catch(e) {}
    port = chrome.runtime.connect({ name: 'scraper' });

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'progress':
          appendLog(msg.message, 'log-progress');
          break;
        case 'info':
          appendLog(msg.message, 'log-info');
          break;
        case 'success':
          appendLog(msg.message, 'log-success');
          break;
        case 'error':
          appendLog(msg.message, 'log-error');
          break;
        case 'file':
          addDownload(msg.task, msg.filename, msg.content, msg.mimeType);
          break;
        case 'done':
          appendLog('✅ ' + msg.message, 'log-success');
          setRunning(false);
          break;
        case 'abort':
          appendLog('⛔ ' + msg.message, 'log-error');
          setRunning(false);
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      if (running) {
        appendLog('⚠️ 连接已断开', 'log-error');
        setRunning(false);
      }
      port = null;
    });
  }

  // ---- Logging ----
  function appendLog(text, cls = 'log-progress') {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    logBox.appendChild(el);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function clearLog() {
    logBox.innerHTML = '';
  }

  function scrollLogToBottom() {
    logBox.scrollTop = logBox.scrollHeight;
  }

  // ---- Download & Copy ----
  function addDownload(task, filename, content, mimeType) {
    const wrap = document.createElement('div');
    wrap.style.display = 'inline-flex';
    wrap.style.gap = '4px';
    wrap.style.margin = '3px';

    const icons = { danmaku: '💬', comments: '📝', subtitle: '📄' };
    const label = `${icons[task] || '📎'} ${filename}`;
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    // Download button
    const dlBtn = document.createElement('button');
    dlBtn.className = 'download-btn';
    dlBtn.innerHTML = label;
    dlBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
    };
    wrap.appendChild(dlBtn);

    // Copy button
    const cpBtn = document.createElement('button');
    cpBtn.className = 'download-btn';
    cpBtn.textContent = '📋';
    cpBtn.title = '复制到剪贴板';
    cpBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(content);
        cpBtn.textContent = '✅';
        cpBtn.style.borderColor = '#4caf50';
        cpBtn.style.color = '#4caf50';
        setTimeout(() => { cpBtn.textContent = '📋'; cpBtn.style.borderColor = ''; cpBtn.style.color = ''; }, 1500);
      } catch (e) {
        cpBtn.textContent = '❌';
        setTimeout(() => { cpBtn.textContent = '📋'; }, 1500);
      }
    };
    wrap.appendChild(cpBtn);

    downloadArea.appendChild(wrap);
    scrollLogToBottom();
  }

  function clearDownloads() {
    downloadArea.innerHTML = '';
  }

  // ---- State ----
  function setRunning(state) {
    running = state;
    btnStart.disabled = state;
    btnStart.textContent = state ? '⏳ 正在爬取...' : '🚀 开始爬取';
    btnCancel.style.display = state ? 'block' : 'none';
  }

  // ---- Start task ----
  async function startTask() {
    const bvid = extractBVID($('bvid').value);
    if (!bvid) {
      appendLog('❌ 请输入有效的BV号或视频链接', 'log-error');
      return;
    }

    clearLog();
    clearDownloads();
    setRunning(true);

    if (!port) connect();

    const s = await chrome.storage.sync.get('settings');
    const cfg = (s.settings || {});
    const params = {
      danmaku: $('chk-danmaku').checked,
      comments: $('chk-comments').checked,
      subtitle: $('chk-subtitle').checked,
      withReplies: $('chk-replies').checked,
      maxPages: parseInt($('max-pages').value) || 0,
      subLan: $('sub-lan').value,
      saveFormat: $('save-fmt').value,
      cookie: $('cookie').value || '',
      subtitleTimeFormat: cfg.subtitleTimeFormat || 'seconds'
    };

    port.postMessage({ action: 'start', bvid, params });
  }

  // ---- Cancel ----
  function cancelTask() {
    if (port) {
      port.postMessage({ action: 'cancel' });
      appendLog('⛔ 正在取消...', 'log-error');
    }
  }

  // ---- Event listeners ----
  btnStart.addEventListener('click', startTask);
  btnCancel.addEventListener('click', cancelTask);

  // Enter key to start
  $('bvid').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !running) startTask();
  });

  // Connect on load
  connect();
})();
