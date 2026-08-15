import { applyTheme, extractBVID, getBiliCookies } from './utils.js';

(() => {
  const $ = id => document.getElementById(id);
  const logBox = $('log');
  const btnStart = $('btn-start');
  const btnCancel = $('btn-cancel');
  const downloadArea = $('download-area');
  const statusDot = $('status-dot');

  let port = null;
  let running = false;
  let soundEnabled = true;
  let audioCtx = null;
  const blobUrls = [];

  // ---- 音效（WebAudio 合成，无需音频文件）----
  function playSound(type) {
    if (!soundEnabled) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime;
      const note = (freq, delay, dur, vol = 0.1) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(vol, t0 + delay);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + delay + dur);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t0 + delay); o.stop(t0 + delay + dur + 0.05);
      };
      if (type === 'done') { note(880, 0, 0.18); note(1174.7, 0.12, 0.22); }
      else if (type === 'ok') { note(660, 0, 0.15, 0.08); }
      else if (type === 'error') { note(220, 0, 0.3, 0.12); note(180, 0.15, 0.3, 0.12); }
      else if (type === 'click') { note(760, 0, 0.045, 0.06); }
      else if (type === 'switch') { note(520, 0, 0.05, 0.07); note(1040, 0.04, 0.06, 0.07); }
    } catch (e) { }
  }

  // 按钮/开关点击音效（全局捕获，轻量）
  document.addEventListener('click', (e) => {
    if (e.target.closest('button')) playSound('click');
    else if (e.target.closest('.switch')) playSound('switch');
  }, true);

  // ---- Settings storage（local 优先，sync 兼容旧数据）----
  async function getSettings() {
    try {
      const s = await chrome.storage.local.get('settings');
      if (s.settings) return s.settings;
    } catch (e) { }
    try {
      const s = await chrome.storage.sync.get('settings');
      return s.settings || {};
    } catch (e) { }
    return {};
  }

  // ---- 依赖勾选联动：热词↔弹幕，AI总结↔字幕，AI弹幕↔弹幕，AI评论↔评论 ----
  function syncOptionStates() {
    const dmOn = $('chk-danmaku').checked;
    const subOn = $('chk-subtitle').checked;
    const cmOn = $('chk-comments').checked;
    $('opt-cloud').classList.toggle('opt-hide', !dmOn);
    $('opt-ai-dm').classList.toggle('opt-hide', !dmOn);
    $('opt-ai').classList.toggle('opt-hide', !subOn);
    $('opt-ai-cm').classList.toggle('opt-hide', !cmOn);
    if (!dmOn) { $('chk-cloud').checked = false; $('chk-ai-dm').checked = false; }
    if (!subOn) $('chk-ai').checked = false;
    if (!cmOn) $('chk-ai-cm').checked = false;
    syncTaskCards();
  }

  // ---- 任务卡 / 功能 chip 视觉状态同步（1.2.0 新 UI） ----
  function syncTaskCards() {
    const cardMap = [
      ['chk-danmaku', 'task-card-dm'],
      ['chk-comments', 'task-card-cm'],
      ['chk-subtitle', 'task-card-sub'],
    ];
    for (const [boxId, cardId] of cardMap) {
      const card = $(cardId);
      const box = $(boxId);
      if (card && box) card.classList.toggle('on', box.checked);
    }
    for (const chipId of ['opt-cloud', 'opt-up', 'opt-ai', 'opt-ai-dm', 'opt-ai-cm']) {
      const chip = $(chipId);
      if (!chip) continue;
      const input = chip.querySelector('input');
      chip.classList.toggle('on', !!(input && input.checked));
    }
  }

  // ---- 按设置控制主界面分区显隐 ----
  function applyVisibility(cfg) {
    const map = [
      ['sec-batch', cfg.showBatch !== false],
      ['row-opts', cfg.showOptsRow !== false],
      ['row-advanced', cfg.showAdvancedRow !== false],
      ['sec-cookie', cfg.showCookie !== false]
    ];
    for (const [id, show] of map) {
      const el = $(id);
      if (el) el.style.display = show ? '' : 'none';
    }
  }

  // ---- Load settings and apply defaults ----
  (async function init() {
    let tabBvid = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab?.url) {
        const m = extractBVID(tab.url); // 与 utils.js 一致的精确 10 位 BV 匹配
        if (m) {
          tabBvid = m;
          $('bvid').value = m;
          $('auto-detect-hint').textContent = `✅ 已自动识别: ${m}`;
        } else if (tab.url.includes('bilibili.com')) {
          $('auto-detect-hint').textContent = '📌 当前在B站但未检测到视频BV号';
        }
      }
    } catch (e) { }

    // 记忆上次输入的 BV（当前页无 BV 时恢复）
    if (!tabBvid) {
      try {
        const s = await chrome.storage.session.get('lastBvid');
        if (s.lastBvid) {
          $('bvid').value = s.lastBvid;
          $('auto-detect-hint').textContent = `🔁 已恢复上次: ${s.lastBvid}`;
        }
      } catch (e) { }
    }

    // Load user settings
    try {
      const cfg = await getSettings();
      soundEnabled = cfg.soundEnabled !== false;
      applyTheme(cfg.theme);
      $('chk-danmaku').checked = cfg.defaultDanmaku !== undefined ? cfg.defaultDanmaku : true;
      $('chk-comments').checked = !!cfg.defaultComments;
      $('chk-subtitle').checked = !!cfg.defaultSubtitle;
      $('chk-replies').checked = !!cfg.defaultReplies;
      $('max-pages').value = cfg.defaultMaxPages || 0;
      $('max-comments').value = cfg.commentMaxItems || 0;
      $('rate-delay').value = cfg.commentRateDelay || 400;
      if (cfg.defaultFormat) $('save-fmt').value = cfg.defaultFormat;
      if (cfg.defaultSubLan) $('sub-lan').value = cfg.defaultSubLan;
      syncOptionStates();
      applyVisibility(cfg);
      syncTaskCards();

      // Auto-cookie
      if (cfg.autoCookie) {
        await fillCookieAuto();
      }
    } catch (e) { }

    // 动态版本号（1.2.0）
    try {
      const ver = chrome.runtime.getManifest().version;
      if (ver) $('version-tag').textContent = 'v' + ver;
    } catch (e) { }
  })();

  // ---- Cookie 自动填充（返回是否成功）----
  async function fillCookieAuto() {
    try {
      const cookies = await getBiliCookies();
      const parts = cookies.map(c => `${c.name}=${c.value}`);
      const status = $('cookie-status');
      if (parts.length > 0) {
        $('cookie').value = parts.join('; ');
        $('auto-detect-hint').textContent += ' 🍪Cookie已自动填充';
        status.textContent = `✅ 已读取 ${cookies.length} 项`;
        status.style.color = '#4caf50';
        return true;
      }
      $('auto-detect-hint').textContent += ' ⚠️ 未找到B站Cookie';
      status.textContent = '⚠️ 浏览器中无B站Cookie，请先在浏览器登录B站';
      status.style.color = '#ff9800';
      return false;
    } catch (e) {
      const status = $('cookie-status');
      $('auto-detect-hint').textContent += ' ⚠️ Cookie读取失败';
      status.textContent = '❌ 读取失败: ' + e.message;
      status.style.color = '#f44336';
      return false;
    }
  }

  // Settings button
  $('btn-settings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // 一键切换到预览版（background 监听 storage 变化自动切换 popup）
  const btnPreview = $('btn-preview');
  if (btnPreview) {
    btnPreview.addEventListener('click', async () => {
      try {
        const s = await chrome.storage.local.get('settings');
        const settings = s.settings || {};
        settings.mode = 'preview';
        await chrome.storage.local.set({ settings });
        try { await chrome.storage.sync.set({ settings }); } catch (e) { }
      } catch (e) { }
      window.close();
    });
  }

  // Manual cookie read
  $('btn-read-cookie').addEventListener('click', async () => {
    $('btn-read-cookie').disabled = true;
    try {
      await fillCookieAuto();
    } finally {
      $('btn-read-cookie').disabled = false;
    }
  });

  // ---- Connection management ----
  function connect() {
    if (port) try { port.disconnect(); } catch (e) { }
    port = chrome.runtime.connect({ name: 'scraper' });

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'progress':
          appendLog(msg.message, 'log-progress');
          if (typeof msg.percent === 'number') setProgress(msg.percent);
          break;
        case 'info':
          appendLog(msg.message, 'log-info');
          break;
        case 'success':
          appendLog(msg.message, 'log-success');
          playSound('ok');
          break;
        case 'error':
          appendLog(msg.message, 'log-error');
          break;
        case 'file':
          addDownload(msg.task, msg.filename, msg.content, msg.mimeType);
          break;
        case 'up':
          showUpInfo(msg.bvid, msg.up);
          break;
        case 'cloud':
          showCloud(msg.bvid, msg.words);
          break;
        case 'summary':
          showSummary(msg.bvid, msg.partial, msg.done !== false, msg.thinking);
          break;
        case 'ai-dm':
          showAiDm(msg.bvid, msg.partial, msg.done !== false, msg.thinking);
          break;
        case 'ai-cm':
          showAiCm(msg.bvid, msg.partial, msg.done !== false, msg.thinking);
          break;
        case 'done':
          appendLog('✅ ' + msg.message, 'log-success');
          setRunning(false);
          setProgress(100);
          playSound('done');
          break;
        case 'abort':
          appendLog('⛔ ' + msg.message, 'log-error');
          setRunning(false);
          playSound('error');
          break;
        case 'status':
          if (msg.running && !running) {
            appendLog('⏳ 检测到后台任务正在运行...', 'log-progress');
            setRunning(true);
          } else if (!msg.running && running) {
            setRunning(false);
          }
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      // 不改变 running 状态：任务在后台继续，重新打开 popup 时会通过 status 同步
    });

    try { port.postMessage({ action: 'status' }); } catch (e) { }
  }

  // ---- Logging ----
  function appendLog(text, cls = 'log-progress') {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    logBox.appendChild(el);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function clearLog() { logBox.innerHTML = ''; }

  // ---- Progress ----
  function setProgress(percent) {
    $('progress-wrap').classList.add('show');
    $('progress-text').classList.add('show');
    $('progress-bar').style.width = Math.max(0, Math.min(100, percent)) + '%';
    $('progress-text').textContent = `进度 ${Math.round(percent)}%`;
  }

  // ---- Result panels ----
  function showUpInfo(bvid, up) {
    const info = [`👤 ${up.name}`];
    if (up.fans != null) info.push(`粉丝 ${up.fans.toLocaleString()}`);
    if (up.archives != null) info.push(`投稿 ${up.archives}`);
    if (up.level != null) info.push(`Lv${up.level}`);
    if (up.official) info.push(up.official);
    if (up.sign) info.push(`— ${up.sign}`);
    $('up-info').textContent = `${info.join(' | ')} (${bvid})`;
    $('panel-up').classList.add('show');
  }

  function showCloud(bvid, words) {
    const box = $('cloud-box');
    box.innerHTML = '';
    if (!words || !words.length) {
      box.textContent = '（无足够弹幕文本）';
    } else {
      const max = words[0].count;
      const min = words[words.length - 1].count;
      for (const { word, count } of words) {
        const span = document.createElement('span');
        const size = max === min ? 14 : 12 + Math.round(((count - min) / (max - min)) * 16);
        span.style.fontSize = size + 'px';
        span.style.color = `hsl(${(word.length * 47) % 360}, 60%, 70%)`;
        span.textContent = `${word}(${count})`;
        span.title = `${word}: ${count} 次`;
        box.appendChild(span);
      }
    }
    $('panel-cloud').querySelector('h3').title = `弹幕热词 - ${bvid}`;
    $('panel-cloud').classList.add('show');
  }

  let lastSummaryText = '';
  // 展示 AI 正文 + 思考过程（reasoning_content）
  function showThinking(thinkEl, bodyEl, thinking) {
    if (!thinking) {
      thinkEl.style.display = 'none';
      bodyEl.textContent = '';
      return;
    }
    thinkEl.style.display = '';
    bodyEl.textContent = thinking;
    if (thinkEl.open) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function showSummary(bvid, text, done, thinking) {
    lastSummaryText = done ? text : lastSummaryText;
    $('summary-body').textContent = text;
    showThinking($('summary-think'), $('summary-think-body'), thinking);
    if (!done && text) {
      $('summary-body').scrollTop = $('summary-body').scrollHeight;
    }
    if (!$('panel-summary').classList.contains('show')) {
      $('panel-summary').querySelector('h3').title = `AI 总结 - ${bvid}`;
      $('panel-summary').classList.add('show');
    }
  }

  let lastAiDmText = '';
  function showAiDm(bvid, text, done, thinking) {
    lastAiDmText = done ? text : lastAiDmText;
    $('ai-dm-body').textContent = text;
    showThinking($('ai-dm-think'), $('ai-dm-think-body'), thinking);
    if (!done && text) {
      $('ai-dm-body').scrollTop = $('ai-dm-body').scrollHeight;
    }
    if (!$('panel-ai-dm').classList.contains('show')) {
      $('panel-ai-dm').querySelector('h3').title = `AI 弹幕分析 - ${bvid}`;
      $('panel-ai-dm').classList.add('show');
    }
  }

  let lastAiCmText = '';
  function showAiCm(bvid, text, done, thinking) {
    lastAiCmText = done ? text : lastAiCmText;
    $('ai-cm-body').textContent = text;
    showThinking($('ai-cm-think'), $('ai-cm-think-body'), thinking);
    if (!done && text) {
      $('ai-cm-body').scrollTop = $('ai-cm-body').scrollHeight;
    }
    if (!$('panel-ai-cm').classList.contains('show')) {
      $('panel-ai-cm').querySelector('h3').title = `AI 评论分析 - ${bvid}`;
      $('panel-ai-cm').classList.add('show');
    }
  }

  // ---- Copy buttons ----
  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '✅ 已复制';
      setTimeout(() => { btn.textContent = '📋 复制'; }, 1500);
    } catch (e) {
      btn.textContent = '❌ 失败';
      setTimeout(() => { btn.textContent = '📋 复制'; }, 1500);
    }
  }

  $('btn-cloud-copy').addEventListener('click', (e) => {
    const words = [...$('cloud-box').querySelectorAll('span')].map(s => s.textContent);
    copyText(words.join('\n'), e.target);
  });
  $('btn-summary-copy').addEventListener('click', (e) => {
    copyText(lastSummaryText, e.target);
  });
  $('btn-ai-dm-copy').addEventListener('click', (e) => {
    copyText(lastAiDmText, e.target);
  });
  $('btn-ai-cm-copy').addEventListener('click', (e) => {
    copyText(lastAiCmText, e.target);
  });
  $('btn-copy-bvid').addEventListener('click', (e) => {
    copyText($('bvid').value.trim(), e.target);
  });

  // ---- Download & Copy ----
  function addDownload(task, filename, content, mimeType) {
    const wrap = document.createElement('div');
    wrap.style.display = 'inline-flex';
    wrap.style.gap = '4px';
    wrap.style.margin = '3px';

    const icons = { danmaku: '💬', comments: '📝', subtitle: '📄', cloud: '☁️', up: '👤', summary: '🤖', 'summary-json': '🧠', analysis: '🧠', 'analysis-json': '🧠', 'comment-analysis': '💬🧠', 'comment-analysis-json': '💬🧠' };
    const label = `${icons[task] || '📎'} ${filename}`;
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    blobUrls.push(url);

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
  }

  function clearDownloads() {
    downloadArea.innerHTML = '';
    while (blobUrls.length) URL.revokeObjectURL(blobUrls.pop());
  }

  // ---- State ----
  function setRunning(state) {
    running = state;
    btnStart.disabled = state;
    btnStart.textContent = state ? '⏳ 正在爬取...' : '🚀 开始爬取';
    btnCancel.style.display = state ? 'block' : 'none';
    if (statusDot) statusDot.classList.toggle('running', state);
  }

  // ---- Parse batch list ----
  function parseBvidList() {
    const lines = $('batch-list').value
      .split(/\r?\n/)
      .map(l => extractBVID(l))
      .filter(Boolean);
    return [...new Set(lines)];
  }

  // ---- Start task ----
  async function startTask() {
    const bvid = extractBVID($('bvid').value);
    const batch = parseBvidList();
    if (!bvid && batch.length === 0) {
      appendLog('❌ 请输入有效的BV号或视频链接', 'log-error');
      return;
    }

    clearLog();
    clearDownloads();
    $('panel-up').classList.remove('show');
    $('panel-cloud').classList.remove('show');
    $('panel-summary').classList.remove('show');
    $('panel-ai-dm').classList.remove('show');
    $('panel-ai-cm').classList.remove('show');
    $('progress-wrap').classList.remove('show');
    $('progress-text').classList.remove('show');
    setRunning(true);

    if (!port) connect();

    const cfg = await getSettings();
    try { await chrome.storage.session.set({ lastBvid: bvid || batch[0] }); } catch (e) { }
    const params = {
      danmaku: $('chk-danmaku').checked,
      comments: $('chk-comments').checked,
      subtitle: $('chk-subtitle').checked,
      wordCloud: $('chk-cloud').checked,
      upInfo: $('chk-up').checked,
      aiSummary: $('chk-ai').checked,
      aiDanmaku: $('chk-ai-dm').checked,
      aiComments: $('chk-ai-cm').checked,
      withReplies: $('chk-replies').checked,
      maxPages: parseInt($('max-pages').value) || 0,
      maxComments: parseInt($('max-comments').value) || 0,
      commentRateDelay: parseInt($('rate-delay').value) || 400,
      subLan: $('sub-lan').value,
      saveFormat: $('save-fmt').value,
      cookie: $('cookie').value || '',
      subtitleTimeFormat: cfg.subtitleTimeFormat || 'seconds',
      cloudTopN: cfg.cloudTopN || 30
    };

    if (batch.length > 0) {
      params.bvidList = bvid ? [...new Set([bvid, ...batch])] : batch;
      appendLog(`📚 批量模式：${params.bvidList.length} 个视频`, 'log-info');
    }

    port.postMessage({ action: 'start', bvid: bvid || batch[0], params });
  }

  // ---- Cancel ----
  function cancelTask() {
    if (port) {
      port.postMessage({ action: 'cancel' });
      appendLog('⛔ 正在取消...', 'log-error');
    }
  }

  // ---- 一键全选 ----
  function selectAllTasks() {
    $('chk-danmaku').checked = true;
    $('chk-comments').checked = true;
    $('chk-subtitle').checked = true;
    $('chk-cloud').checked = true;
    $('chk-up').checked = true;
    $('chk-ai').checked = true;
    $('chk-ai-dm').checked = true;
    $('chk-ai-cm').checked = true;
    $('chk-replies').checked = true;
    syncOptionStates();
    appendLog('🪄 已全选所有任务', 'log-info');
  }

  // ---- Event listeners ----
  btnStart.addEventListener('click', startTask);
  btnCancel.addEventListener('click', cancelTask);
  $('btn-select-all').addEventListener('click', selectAllTasks);
  $('chk-danmaku').addEventListener('change', syncOptionStates);
  $('chk-subtitle').addEventListener('change', syncOptionStates);
  $('chk-comments').addEventListener('change', syncOptionStates);

  // 任务卡整卡点击切换（开关区域由 label 原生处理，避免双重切换）
  for (const id of ['task-card-dm', 'task-card-cm', 'task-card-sub']) {
    const card = $(id);
    if (!card) continue;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.switch')) return;
      const input = card.querySelector('input');
      if (!input) return;
      input.checked = !input.checked;
      syncOptionStates();
    });
  }

  // 功能 chip 勾选变化同步视觉状态
  for (const id of ['chk-cloud', 'chk-up', 'chk-ai', 'chk-ai-dm', 'chk-ai-cm', 'chk-replies']) {
    const el = $(id);
    if (el) el.addEventListener('change', syncTaskCards);
  }

  // 清空日志 / 清空文件
  const btnClearLog = $('btn-clear-log');
  if (btnClearLog) btnClearLog.addEventListener('click', clearLog);
  const btnClearDl = $('btn-clear-dl');
  if (btnClearDl) btnClearDl.addEventListener('click', () => clearDownloads());

  // Enter key to start
  $('bvid').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !running) startTask();
  });

  // Connect on load
  connect();
})();
