/* ============================================================
   B站爬虫扩展 - 预览版弹窗逻辑（popup-preview）
   v2.2.0-preview
   与经典版共用：utils.js 工具库 + background 消息协议（port 'scraper'）
   视觉：玻璃拟态 + 弹性微交互 + 完成彩带庆祝
   ============================================================ */

import { applyTheme, extractBVID, getBiliCookies } from './utils.js';

(() => {
  'use strict';
  const $ = id => document.getElementById(id);

  let port = null;
  let running = false;
  let soundEnabled = true;
  const blobUrls = [];

  // ── 设置（local 优先，sync 兼容） ──
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

  // ── 音效（WebAudio 合成） ──
  let audioCtx = null;
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
      if (type === 'done') { note(880, 0, 0.18); note(1174.7, 0.12, 0.22); note(1568, 0.24, 0.3); }
      else if (type === 'ok') { note(660, 0, 0.15, 0.08); }
      else if (type === 'error') { note(220, 0, 0.3, 0.12); note(180, 0.15, 0.3, 0.12); }
      else if (type === 'click') { note(760, 0, 0.045, 0.06); }
      else if (type === 'switch') { note(520, 0, 0.05, 0.07); note(1040, 0.04, 0.06, 0.07); }
    } catch (e) { }
  }

  // 按钮 / 开关 / 任务卡 / chip 点击音效（全局捕获，与经典版一致的交互反馈）
  document.addEventListener('click', (e) => {
    if (e.target.closest('.pv-go') || e.target.closest('.pv-btn') || e.target.closest('.pv-icon-btn') || e.target.closest('.pv-file')) {
      playSound('click');
    } else if (e.target.closest('.pv-switch') || e.target.closest('.pv-task') || e.target.closest('.pv-chip')) {
      playSound('switch');
    }
  }, true);

  // ── Toast ──
  let toastTimer = null;
  function toast(msg, type = '') {
    const el = $('pv-toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'pv-toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3400);
  }

  // ── 彩带粒子（轻量 canvas，完成庆祝） ──
  const confetti = (() => {
    let canvas = null, ctx = null, particles = [], raf = null;
    function ensure() {
      canvas = document.getElementById('pv-confetti');
      if (canvas) { ctx = canvas.getContext('2d'); resize(); }
    }
    function resize() {
      if (!canvas) return;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    function tick() {
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles = particles.filter(p => p.life > 0 && p.y < canvas.height + 40);
      for (const p of particles) {
        p.x += p.vx; p.y += p.vy; p.vy += p.g; p.rot += p.vr; p.life -= 0.009;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
        ctx.restore();
      }
      if (particles.length) raf = requestAnimationFrame(tick);
      else { ctx.clearRect(0, 0, canvas.width, canvas.height); raf = null; }
    }
    function burst() {
      ensure();
      if (!ctx) return;
      const colors = ['#00c8ff', '#7c5cff', '#34d399', '#fbbf24', '#f472b6', '#ffffff', '#38bdf8'];
      for (let i = 0; i < 100; i++) {
        particles.push({
          x: window.innerWidth / 2 + (Math.random() - 0.5) * 220,
          y: window.innerHeight * 0.42,
          vx: (Math.random() - 0.5) * 9.5,
          vy: -Math.random() * 11 - 3,
          g: 0.28 + Math.random() * 0.16,
          size: 4 + Math.random() * 5.5,
          color: colors[Math.floor(Math.random() * colors.length)],
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 0.32,
          life: 1,
        });
      }
      if (!raf) raf = requestAnimationFrame(tick);
    }
    return { burst };
  })();

  // ── 任务卡 / chip 视觉状态 ──
  function syncTasks() {
    const tasks = [
      ['pv-chk-dm', 'pv-task-dm'], ['pv-chk-cm', 'pv-task-cm'], ['pv-chk-sub', 'pv-task-sub'],
    ];
    for (const [boxId, cardId] of tasks) {
      const card = $(cardId), box = $(boxId);
      if (card && box) card.classList.toggle('on', box.checked);
    }
    for (const chipId of ['pv-chip-cloud', 'pv-chip-up', 'pv-chip-ai', 'pv-chip-ai-dm', 'pv-chip-ai-cm', 'pv-chip-replies']) {
      const chip = $(chipId);
      if (!chip) continue;
      const input = chip.querySelector('input');
      chip.classList.toggle('on', !!(input && input.checked));
    }
  }

  // 依赖联动：热词↔弹幕，AI总结↔字幕，AI弹幕↔弹幕，AI评论↔评论
  function syncOptionStates() {
    const dmOn = $('pv-chk-dm').checked;
    const subOn = $('pv-chk-sub').checked;
    const cmOn = $('pv-chk-cm').checked;
    for (const id of ['pv-chip-cloud', 'pv-chip-ai-dm']) $(id).classList.toggle('pv-hidden', !dmOn);
    $('pv-chip-ai').classList.toggle('pv-hidden', !subOn);
    $('pv-chip-ai-cm').classList.toggle('pv-hidden', !cmOn);
    if (!dmOn) { $('pv-chk-cloud').checked = false; $('pv-chk-ai-dm').checked = false; }
    if (!subOn) $('pv-chk-ai').checked = false;
    if (!cmOn) $('pv-chk-ai-cm').checked = false;
    syncTasks();
  }

  // 按设置控制分区显隐
  function applyVisibility(cfg) {
    const map = [
      ['pv-batch', cfg.showBatch !== false],
      ['pv-chip-cloud', cfg.showOptsRow !== false],
      ['pv-chip-up', cfg.showOptsRow !== false],
      ['pv-chip-ai', cfg.showOptsRow !== false],
      ['pv-chip-ai-dm', cfg.showOptsRow !== false],
      ['pv-chip-ai-cm', cfg.showOptsRow !== false],
      ['pv-chip-replies', cfg.showOptsRow !== false],
      ['pv-adv', cfg.showAdvancedRow !== false],
      ['pv-sec-cookie', cfg.showCookie !== false],
    ];
    for (const [id, show] of map) {
      const el = $(id);
      if (el) el.style.display = show ? '' : 'none';
    }
  }

  // ── 日志 ──
  function appendLog(text, cls = 'log-progress') {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    $('pv-log').appendChild(el);
    $('pv-log').scrollTop = $('pv-log').scrollHeight;
  }
  function clearLog() { $('pv-log').innerHTML = ''; }

  // ── 进度（v2.3.0：rAF 插值平滑过渡，丝滑不跳变） ──
  let animPct = 0;
  let animRaf = null;
  function setProgress(percent) {
    $('pv-progress').classList.add('show');
    const target = Math.max(0, Math.min(100, percent));
    if (animRaf) cancelAnimationFrame(animRaf);
    const step = () => {
      animPct += (target - animPct) * 0.28;
      if (Math.abs(target - animPct) < 0.3) animPct = target;
      $('pv-fill').style.width = animPct + '%';
      $('pv-progress-pct').textContent = Math.round(animPct) + '%';
      if (animPct !== target) animRaf = requestAnimationFrame(step);
      else animRaf = null;
    };
    step();
  }
  function setProgressLabel(text) { $('pv-progress-label').textContent = text; }

  // ── 点击涟漪（轻量，指针坐标生成扩散圆） ──
  function addRipple(e) {
    const btn = e.currentTarget;
    if (btn.disabled || !e.clientX) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.1;
    const span = document.createElement('span');
    span.className = 'pv-ripple';
    span.style.width = span.style.height = size + 'px';
    span.style.left = (e.clientX - rect.left - size / 2) + 'px';
    span.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(span);
    setTimeout(() => span.remove(), 600);
  }

  // ── 文件 ──
  function addDownload(filename, content, mimeType) {
    const wrap = document.createElement('div');
    wrap.style.display = 'inline-flex';
    const btn = document.createElement('button');
    btn.className = 'pv-file';
    btn.textContent = '📎 ' + filename;
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    blobUrls.push(url);
    btn.onclick = () => {
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
    };
    wrap.appendChild(btn);
    $('pv-dl').appendChild(wrap);
  }
  function clearDownloads() {
    $('pv-dl').innerHTML = '';
    while (blobUrls.length) URL.revokeObjectURL(blobUrls.pop());
  }

  // ── 复制 ──
  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = '✅ 已复制';
      setTimeout(() => { btn.textContent = old; }, 1400);
    } catch (e) { }
  }

  // ── 结果面板 ──
  function showPanel(id) {
    const el = $(id);
    if (el && !el.classList.contains('show')) el.classList.add('show');
  }
  function showThinking(thinkId, bodyId, thinking) {
    const thinkEl = $(thinkId);
    if (!thinking) { thinkEl.style.display = 'none'; return; }
    thinkEl.style.display = '';
    $(bodyId).textContent = thinking;
  }

  // ── 状态 ──
  function setRunning(state) {
    running = state;
    const btn = $('pv-btn-start');
    btn.disabled = state;
    btn.textContent = state ? '⏳ 正在爬取...' : '🚀 开始爬取';
    $('pv-btn-cancel').style.display = state ? 'block' : 'none';
    $('pv-dot').classList.toggle('running', state);
  }

  // ── 批量解析 ──
  function parseBvidList() {
    const lines = $('pv-batch-list').value
      .split(/\r?\n/)
      .map(l => extractBVID(l))
      .filter(Boolean);
    return [...new Set(lines)];
  }

  // ── 启动任务 ──
  async function startTask() {
    const bvid = extractBVID($('pv-bvid').value);
    const batch = parseBvidList();
    if (!bvid && batch.length === 0) {
      toast('❌ 请输入有效的 BV 号或视频链接', 'err');
      playSound('error');
      return;
    }
    clearLog();
    clearDownloads();
    for (const id of ['pv-panel-up', 'pv-panel-cloud', 'pv-panel-summary',
                      'pv-panel-ai-dm', 'pv-panel-ai-cm']) {
      $(id).classList.remove('show');
    }
    $('pv-progress').classList.remove('show');
    setRunning(true);

    if (!port) connect();

    const cfg = await getSettings();
    try { await chrome.storage.session.set({ lastBvid: bvid || batch[0] }); } catch (e) { }
    const params = {
      danmaku: $('pv-chk-dm').checked,
      comments: $('pv-chk-cm').checked,
      subtitle: $('pv-chk-sub').checked,
      wordCloud: $('pv-chk-cloud').checked,
      upInfo: $('pv-chk-up').checked,
      aiSummary: $('pv-chk-ai').checked,
      aiDanmaku: $('pv-chk-ai-dm').checked,
      aiComments: $('pv-chk-ai-cm').checked,
      withReplies: $('pv-chk-replies').checked,
      maxPages: parseInt($('pv-max-pages').value) || 0,
      maxComments: parseInt($('pv-max-comments').value) || 0,
      commentRateDelay: parseInt($('pv-rate-delay').value) || 400,
      subLan: $('pv-sub-lan').value,
      saveFormat: $('pv-save-fmt').value,
      cookie: $('pv-cookie').value || '',
      subtitleTimeFormat: cfg.subtitleTimeFormat || 'seconds',
      cloudTopN: cfg.cloudTopN || 30,
    };
    if (batch.length > 0) {
      params.bvidList = bvid ? [...new Set([bvid, ...batch])] : batch;
      appendLog(`📚 批量模式：${params.bvidList.length} 个视频`, 'log-info');
    }
    port.postMessage({ action: 'start', bvid: bvid || batch[0], params });
  }

  function cancelTask() {
    if (port) port.postMessage({ action: 'cancel' });
    appendLog('⛔ 正在取消...', 'log-error');
  }

  // ── 连接 ──
  function connect() {
    if (port) try { port.disconnect(); } catch (e) { }
    port = chrome.runtime.connect({ name: 'scraper' });

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'progress':
          appendLog(msg.message, 'log-progress');
          setProgressLabel(msg.message.replace(/\s+/g, ' ').slice(0, 60));
          if (typeof msg.percent === 'number') setProgress(msg.percent);
          break;
        case 'info': appendLog(msg.message, 'log-info'); break;
        case 'success':
          appendLog(msg.message, 'log-success');
          playSound('ok');
          break;
        case 'error': appendLog(msg.message, 'log-error'); break;
        case 'file': addDownload(msg.filename, msg.content, msg.mimeType); break;
        case 'up': showUp(msg.up); break;
        case 'cloud': showCloud(msg.words); break;
        case 'summary': showAiPanel('pv-panel-summary', 'pv-summary-body', msg.partial,
                                    msg.done !== false, 'pv-summary-think', 'pv-summary-think-body', msg.thinking); break;
        case 'ai-dm': showAiPanel('pv-panel-ai-dm', 'pv-ai-dm-body', msg.partial,
                                  msg.done !== false, 'pv-ai-dm-think', 'pv-ai-dm-think-body', msg.thinking); break;
        case 'ai-cm': showAiPanel('pv-panel-ai-cm', 'pv-ai-cm-body', msg.partial,
                                  msg.done !== false, 'pv-ai-cm-think', 'pv-ai-cm-think-body', msg.thinking); break;
        case 'done':
          appendLog('✅ ' + msg.message, 'log-success');
          setRunning(false);
          setProgress(100);
          $('pv-progress').classList.add('done');
          setTimeout(() => $('pv-progress').classList.remove('done'), 1400);
          playSound('done');
          confetti.burst();
          toast('✅ ' + msg.message, 'ok');
          $('pv-btn-start').classList.add('pv-celebrate');
          setTimeout(() => $('pv-btn-start').classList.remove('pv-celebrate'), 1400);
          break;
        case 'abort':
          appendLog('⛔ ' + msg.message, 'log-error');
          setRunning(false);
          playSound('error');
          toast('⛔ ' + msg.message, 'err');
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

    port.onDisconnect.addListener(() => { port = null; });
    try { port.postMessage({ action: 'status' }); } catch (e) { }
  }

  function showUp(up) {
    const parts = [`👤 ${up.name}`];
    if (up.fans != null) parts.push(`粉丝 ${up.fans.toLocaleString()}`);
    if (up.archives != null) parts.push(`投稿 ${up.archives}`);
    if (up.level != null) parts.push(`Lv${up.level}`);
    if (up.official) parts.push(up.official);
    if (up.sign) parts.push(`— ${up.sign}`);
    $('pv-up').textContent = parts.join('  ·  ');
    showPanel('pv-panel-up');
  }

  function showCloud(words) {
    const box = $('pv-cloud');
    box.innerHTML = '';
    if (!words || !words.length) {
      box.textContent = '（无足够弹幕文本）';
    } else {
      const max = words[0].count, min = words[words.length - 1].count;
      for (const { word, count } of words) {
        const span = document.createElement('span');
        const size = max === min ? 14 : 12 + Math.round(((count - min) / (max - min)) * 17);
        span.style.fontSize = size + 'px';
        span.style.color = `hsl(${(word.length * 47) % 360}, 65%, 72%)`;
        span.textContent = `${word}(${count})`;
        span.title = `${word}: ${count} 次`;
        box.appendChild(span);
      }
    }
    showPanel('pv-panel-cloud');
  }

  const lastTexts = {};
  function showAiPanel(panelId, bodyId, text, done, thinkId, thinkBodyId, thinking) {
    if (done) lastTexts[panelId] = text;
    $(bodyId).textContent = text;
    showThinking(thinkId, thinkBodyId, thinking);
    if (!done && text) $(bodyId).scrollTop = $(bodyId).scrollHeight;
    showPanel(panelId);
  }

  // ── Cookie ──
  async function fillCookieAuto() {
    try {
      const cookies = await getBiliCookies();
      if (cookies.length > 0) {
        $('pv-cookie').value = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        $('pv-cookie-status').textContent = `✅ 已读取 ${cookies.length} 项`;
        return true;
      }
      $('pv-cookie-status').textContent = '⚠️ 浏览器中无B站Cookie，请先在浏览器登录B站';
      return false;
    } catch (e) {
      $('pv-cookie-status').textContent = '❌ 读取失败: ' + e.message;
      return false;
    }
  }

  // ── 全选 ──
  function selectAll() {
    for (const id of ['pv-chk-dm', 'pv-chk-cm', 'pv-chk-sub', 'pv-chk-cloud', 'pv-chk-up',
                      'pv-chk-ai', 'pv-chk-ai-dm', 'pv-chk-ai-cm', 'pv-chk-replies']) {
      $(id).checked = true;
    }
    syncOptionStates();
    toast('🪄 已全选所有任务', 'ok');
  }

  // ── 初始化 ──
  (async function init() {
    // 动态版本号 + 主题
    try {
      const ver = chrome.runtime.getManifest().version;
      if (ver) $('pv-version').textContent = 'v' + ver;
    } catch (e) { }
    applyTheme((await getSettings()).theme);

    // 自动识别当前页 BV
    let tabBvid = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tabs[0]?.url;
      if (url) {
        const m = extractBVID(url);
        if (m) {
          tabBvid = m;
          $('pv-bvid').value = m;
          $('pv-hint-detect').textContent = `✅ 已自动识别: ${m}`;
        } else if (url.includes('bilibili.com')) {
          $('pv-hint-detect').textContent = '📌 当前在B站但未检测到视频BV号';
        }
      }
    } catch (e) { }

    // 记忆上次输入的 BV
    if (!tabBvid) {
      try {
        const s = await chrome.storage.session.get('lastBvid');
        if (s.lastBvid) {
          $('pv-bvid').value = s.lastBvid;
          $('pv-hint-detect').textContent = `🔁 已恢复上次: ${s.lastBvid}`;
        }
      } catch (e) { }
    }

    // 加载用户设置
    try {
      const cfg = await getSettings();
      soundEnabled = cfg.soundEnabled !== false;
      applyTheme(cfg.theme);
      $('pv-chk-dm').checked = cfg.defaultDanmaku !== undefined ? cfg.defaultDanmaku : true;
      $('pv-chk-cm').checked = !!cfg.defaultComments;
      $('pv-chk-sub').checked = !!cfg.defaultSubtitle;
      $('pv-chk-replies').checked = !!cfg.defaultReplies;
      $('pv-max-pages').value = cfg.defaultMaxPages || 0;
      $('pv-max-comments').value = cfg.commentMaxItems || 0;
      $('pv-rate-delay').value = cfg.commentRateDelay || 400;
      if (cfg.defaultFormat) $('pv-save-fmt').value = cfg.defaultFormat;
      if (cfg.defaultSubLan) $('pv-sub-lan').value = cfg.defaultSubLan;
      applyVisibility(cfg);
      syncOptionStates();
      if (cfg.autoCookie) fillCookieAuto();
    } catch (e) { }
  })();

  // ── 事件绑定 ──
  $('pv-btn-start').addEventListener('click', startTask);
  $('pv-btn-cancel').addEventListener('click', cancelTask);
  $('pv-btn-settings').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

  // 一键切回经典版（background 监听 storage 变化自动切换 popup）
  $('pv-btn-classic').addEventListener('click', async () => {
    try {
      const s = await chrome.storage.local.get('settings');
      const settings = s.settings || {};
      settings.mode = 'classic';
      await chrome.storage.local.set({ settings });
      try { await chrome.storage.sync.set({ settings }); } catch (e) { }
    } catch (e) { }
    window.close();
  });
  $('pv-btn-copy').addEventListener('click', (e) => copyText($('pv-bvid').value.trim(), e.currentTarget));
  $('pv-btn-cookie').addEventListener('click', async () => {
    $('pv-btn-cookie').disabled = true;
    try { await fillCookieAuto(); } finally { $('pv-btn-cookie').disabled = false; }
  });
  $('pv-btn-select-all').addEventListener('click', selectAll);

  for (const id of ['pv-chk-dm', 'pv-chk-cm', 'pv-chk-sub']) {
    $(id).addEventListener('change', syncOptionStates);
  }
  for (const id of ['pv-chk-cloud', 'pv-chk-up', 'pv-chk-ai', 'pv-chk-ai-dm', 'pv-chk-ai-cm', 'pv-chk-replies']) {
    $(id).addEventListener('change', syncTasks);
  }

  // 任务卡整卡点击切换（开关区域由 label 原生处理）
  for (const id of ['pv-task-dm', 'pv-task-cm', 'pv-task-sub']) {
    $(id).addEventListener('click', (e) => {
      if (e.target.closest('.pv-switch')) return;
      const input = $(id).querySelector('input');
      if (!input) return;
      input.checked = !input.checked;
      syncOptionStates();
    });
  }

  // 复制 AI / 热词结果
  $('pv-btn-cloud-copy').addEventListener('click', (e) => {
    const words = [...$('pv-cloud').querySelectorAll('span')].map(s => s.textContent);
    copyText(words.join('\n'), e.currentTarget);
  });
  $('pv-btn-summary-copy').addEventListener('click', (e) => copyText(lastTexts['pv-panel-summary'] || '', e.currentTarget));
  $('pv-btn-ai-dm-copy').addEventListener('click', (e) => copyText(lastTexts['pv-panel-ai-dm'] || '', e.currentTarget));
  $('pv-btn-ai-cm-copy').addEventListener('click', (e) => copyText(lastTexts['pv-panel-ai-cm'] || '', e.currentTarget));

  // 清空日志 / 文件
  $('pv-btn-clear-log').addEventListener('click', clearLog);
  $('pv-btn-clear-dl').addEventListener('click', clearDownloads);

  // 回车开始
  $('pv-bvid').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !running) startTask();
  });

  // v2.3.0：点击涟漪
  for (const id of ['pv-btn-start', 'pv-btn-copy', 'pv-btn-cookie', 'pv-btn-select-all',
                    'pv-btn-settings', 'pv-btn-classic', 'pv-btn-clear-log', 'pv-btn-clear-dl']) {
    const el = $(id);
    if (el) el.addEventListener('click', addRipple);
  }

  // 连接
  connect();
})();
