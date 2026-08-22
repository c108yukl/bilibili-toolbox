/* ============================================================
   B站爬虫扩展 - 弹窗逻辑（popup-preview，唯一 UI）
   依赖：utils.js 工具库 + background 消息协议（port 'scraper'）
   视觉：Aurora Console —— App-Shell 常驻操作栏、阶段时间线、
   AI LIVE 徽章、批量实时解析、主题感知派生色
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

  // 按钮 / 开关 / 任务卡 / chip 点击音效（全局捕获）
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
      const styles = getComputedStyle(document.documentElement);
      const colors = [
        styles.getPropertyValue('--accent').trim() || '#00c8ff',
        styles.getPropertyValue('--accent2').trim() || '#7c5cff',
        '#34d399', '#fbbf24', '#f472b6', '#ffffff',
      ];
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
      if (card && box) {
        card.classList.toggle('on', box.checked);
        card.setAttribute('aria-pressed', box.checked ? 'true' : 'false');
      }
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

  // ══════════════════════════════════════════
  // 阶段时间线：从进度消息前缀解析当前阶段
  // 视频 → 弹幕 → 字幕 → 评论 → AI
  // ══════════════════════════════════════════
  const STAGE_ORDER = ['video', 'dm', 'sub', 'cm', 'ai'];
  const STAGE_RULES = [
    ['video', /^\[视频\]|▶️\s*\[/],
    ['dm', /^\[弹幕\]/],
    ['sub', /^\[字幕\]/],
    ['cm', /^\[评论\]|^第\d+页/],
    ['ai', /^🤖/],
  ];
  let curStage = -1;

  function stageEls() { return STAGE_ORDER.map(id => $('pv-stage-' + id)); }
  function resetStages() {
    curStage = -1;
    for (const el of stageEls()) {
      el.classList.remove('active', 'done');
      const dot = el.querySelector('.pv-stage-dot');
      if (dot) dot.textContent = '';
    }
  }
  function setStage(id) {
    const idx = STAGE_ORDER.indexOf(id);
    if (idx < 0) return;
    if (id === 'video' && curStage >= 0) resetStages(); // 批量：新视频从头开始
    curStage = Math.max(curStage, idx);
    STAGE_ORDER.forEach((sid, i) => {
      const el = $('pv-stage-' + sid);
      const dot = el.querySelector('.pv-stage-dot');
      if (i < curStage) { el.classList.add('done'); el.classList.remove('active'); if (dot) dot.textContent = '✓'; }
      else if (i === curStage) { el.classList.add('active'); el.classList.remove('done'); if (dot) dot.textContent = ''; }
      else { el.classList.remove('active', 'done'); if (dot) dot.textContent = ''; }
    });
  }
  function allStagesDone() {
    curStage = STAGE_ORDER.length;
    for (const el of stageEls()) {
      el.classList.add('done');
      el.classList.remove('active');
      const dot = el.querySelector('.pv-stage-dot');
      if (dot) dot.textContent = '✓';
    }
  }
  function parseStageMsg(text) {
    const t = String(text || '').trim();
    for (const [id, re] of STAGE_RULES) if (re.test(t)) return id;
    return null;
  }

  // ── 进度（rAF 插值平滑过渡，写入底栏 HUD） ──
  let animPct = 0;
  let animRaf = null;
  function setProgress(percent) {
    const target = Math.max(0, Math.min(100, percent));
    if (animRaf) cancelAnimationFrame(animRaf);
    const step = () => {
      animPct += (target - animPct) * 0.28;
      if (Math.abs(target - animPct) < 0.3) animPct = target;
      $('pv-pfill').style.width = animPct + '%';
      $('pv-progress-pct').textContent = Math.round(animPct) + '%';
      $('pv-pbar').setAttribute('aria-valuenow', String(Math.round(animPct)));
      if (animPct !== target) animRaf = requestAnimationFrame(step);
      else animRaf = null;
    };
    step();
  }
  function setProgressLabel(text) { $('pv-progress-label').textContent = text; }

  // ── 底栏状态机：空闲（主按钮）↔ 运行（进度 HUD） ──
  let doneRevertTimer = null;
  function setRunning(state) {
    running = state;
    if (!state && doneRevertTimer) { clearTimeout(doneRevertTimer); doneRevertTimer = null; }
    $('pv-foot-idle').hidden = state;
    $('pv-foot-run').hidden = !state;
    if (state) {
      $('pv-foot-run').classList.remove('done');
      $('pv-btn-start').classList.remove('pv-celebrate');
    }
    $('pv-dot').classList.toggle('running', state);
  }

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

  // ── 鼠标聚光灯：卡片跟随光晕（rAF 节流，写 CSS 变量） ──
  let spotRaf = 0;
  document.addEventListener('mousemove', (e) => {
    if (spotRaf) return;
    const t = e.target, x = e.clientX, y = e.clientY;
    spotRaf = requestAnimationFrame(() => {
      spotRaf = 0;
      const card = t && t.closest && t.closest('.pv-glass');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (x - r.left) + 'px');
      card.style.setProperty('--my', (y - r.top) + 'px');
    });
  }, { passive: true });

  // ── 批量实时解析：计数 + chip 预览（点 × 移除） ──
  function parseBvidList() {
    const lines = $('pv-batch-list').value
      .split(/\r?\n/)
      .map(l => extractBVID(l))
      .filter(Boolean);
    return [...new Set(lines)];
  }
  function refreshBatch() {
    const list = parseBvidList();
    const countEl = $('pv-batch-count');
    const chipsEl = $('pv-batch-chips');
    countEl.textContent = list.length ? `已识别 ${list.length} 个 BV` : '尚无有效 BV';
    countEl.style.color = list.length ? 'var(--accent, #00c8ff)' : '';
    chipsEl.innerHTML = '';
    list.slice(0, 5).forEach(bv => {
      const chip = document.createElement('span');
      chip.className = 'pv-bchip';
      const b = document.createElement('b');
      b.textContent = bv;
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = '移除 ' + bv;
      x.setAttribute('aria-label', '移除 ' + bv);
      x.addEventListener('click', () => {
        const rest = parseBvidList().filter(v => v !== bv);
        $('pv-batch-list').value = rest.join('\n');
        refreshBatch();
      });
      chip.append(b, x);
      chipsEl.appendChild(chip);
    });
    if (list.length > 5) {
      const more = document.createElement('span');
      more.className = 'pv-bchip';
      more.textContent = `+${list.length - 5} more`;
      chipsEl.appendChild(more);
    }
  }
  let batchDeb = null;
  $('pv-batch-list').addEventListener('input', () => {
    clearTimeout(batchDeb);
    batchDeb = setTimeout(refreshBatch, 250);
  });

  // ══════════════════════════════════════════
  // AI 面板：三态 LIVE 徽章（排队中/生成中/完成）+ 计时
  // ══════════════════════════════════════════
  const AI_PANELS = {
    'summary': { chk: 'pv-chk-ai', wait: '⏳ 等待字幕抓取，AI 排队中…' },
    'ai-dm': { chk: 'pv-chk-ai-dm', wait: '⏳ 等待弹幕抓取，AI 排队中…' },
    'ai-cm': { chk: 'pv-chk-ai-cm', wait: '⏳ 等待评论抓取，AI 排队中…' },
  };
  const aiClock = {}; // key -> { start, iv }

  function fmtElapsed(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function setAiState(key, state) {
    const badge = $('pv-live-' + key);
    const timerEl = $('pv-timer-' + key);
    if (!badge) return;
    badge.hidden = false;
    badge.className = 'pv-live ' + state;
    badge.querySelector('.pv-live-txt').textContent =
      state === 'wait' ? '排队中' : state === 'live' ? '生成中' : '✓ 完成';
    if (state === 'wait') {
      timerEl.hidden = false;
      timerEl.textContent = '00:00';
      stopClock(key, true);
      aiClock[key] = { start: 0, iv: null };
    } else if (state === 'live') {
      timerEl.hidden = false;
      if (!aiClock[key] || !aiClock[key].start) {
        stopClock(key, true);
        const c = { start: Date.now(), iv: null };
        c.iv = setInterval(() => { timerEl.textContent = fmtElapsed(Date.now() - c.start); }, 500);
        aiClock[key] = c;
        timerEl.textContent = '00:00';
      }
    } else if (state === 'done') {
      const c = aiClock[key];
      const final = c && c.start ? fmtElapsed(Date.now() - c.start) : null;
      stopClock(key);
      if (final) { timerEl.hidden = false; timerEl.textContent = final; }
      else timerEl.hidden = true;
    }
  }
  function stopClock(key, keepHidden) {
    const c = aiClock[key];
    if (c && c.iv) clearInterval(c.iv);
    if (keepHidden && c) c.iv = null;
  }
  function resetAiPanels() {
    for (const key of Object.keys(AI_PANELS)) {
      const cfg = AI_PANELS[key];
      const panel = $('pv-panel-' + key);
      const body = $('pv-' + key + '-body');
      const think = $('pv-' + key + '-think');
      stopClock(key);
      if ($(cfg.chk).checked) {
        body.textContent = cfg.wait;
        body.classList.add('wait');
        think.style.display = 'none';
        setAiState(key, 'wait');
        panel.classList.add('show');
      } else {
        panel.classList.remove('show');
      }
    }
  }

  const lastTexts = {};
  function showAiPanel(key, text, done, thinking) {
    const body = $('pv-' + key + '-body');
    body.classList.remove('wait');
    const clock = aiClock[key];
    if (!clock || !clock.start) setAiState(key, 'live'); // 首个 token 到达：开始计时
    if (done) {
      setAiState(key, 'done');
      lastTexts['pv-panel-' + key] = text;
    }
    body.textContent = text;
    const thinkEl = $('pv-' + key + '-think');
    if (!thinking) thinkEl.style.display = 'none';
    else { thinkEl.style.display = ''; $('pv-' + key + '-think-body').textContent = thinking; }
    if (!done && text) body.scrollTop = body.scrollHeight;
    $('pv-panel-' + key).classList.add('show');
  }

  // ── 文件（格式徽章 + 大小） ──
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function addDownload(filename, content, mimeType) {
    const btn = document.createElement('button');
    btn.className = 'pv-file';
    const ext = (filename.includes('.') ? filename.split('.').pop() : '').toLowerCase();
    btn.dataset.ext = ext;
    const extEl = document.createElement('span');
    extEl.className = 'pv-file-ext';
    extEl.textContent = (ext || 'FILE').toUpperCase();
    const nameEl = document.createElement('span');
    nameEl.className = 'pv-file-name';
    nameEl.textContent = filename;
    nameEl.title = filename;
    const sizeEl = document.createElement('span');
    sizeEl.className = 'pv-file-size';
    sizeEl.textContent = fmtSize(typeof content === 'string' ? content.length : 0);
    btn.append(extEl, nameEl, sizeEl);
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    blobUrls.push(url);
    sizeEl.textContent = fmtSize(blob.size);
    btn.onclick = () => {
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
    };
    $('pv-dl').appendChild(btn);
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
    for (const id of ['pv-panel-up', 'pv-panel-cloud']) $(id).classList.remove('show');
    resetAiPanels();
    resetStages();
    animPct = 0;
    setProgressLabel('准备中...');
    setProgress(0);
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
        case 'progress': {
          appendLog(msg.message, 'log-progress');
          setProgressLabel(msg.message.replace(/\s+/g, ' ').slice(0, 60));
          const stage = parseStageMsg(msg.message);
          if (stage) setStage(stage);
          if (typeof msg.percent === 'number') setProgress(msg.percent);
          break;
        }
        case 'info': appendLog(msg.message, 'log-info'); break;
        case 'success':
          appendLog(msg.message, 'log-success');
          playSound('ok');
          break;
        case 'error': appendLog(msg.message, 'log-error'); break;
        case 'file': addDownload(msg.filename, msg.content, msg.mimeType); break;
        case 'up': showUp(msg.up); break;
        case 'cloud': showCloud(msg.words); break;
        case 'summary': showAiPanel('summary', msg.partial, msg.done !== false, msg.thinking); break;
        case 'ai-dm': showAiPanel('ai-dm', msg.partial, msg.done !== false, msg.thinking); break;
        case 'ai-cm': showAiPanel('ai-cm', msg.partial, msg.done !== false, msg.thinking); break;
        case 'done':
          appendLog('✅ ' + msg.message, 'log-success');
          setProgressLabel('✅ ' + msg.message.replace(/\s+/g, ' ').slice(0, 40));
          setProgress(100);
          allStagesDone();
          $('pv-foot-run').classList.add('done');
          playSound('done');
          confetti.burst();
          toast('✅ ' + msg.message, 'ok');
          $('pv-btn-start').classList.add('pv-celebrate');
          setTimeout(() => $('pv-btn-start').classList.remove('pv-celebrate'), 1400);
          doneRevertTimer = setTimeout(() => setRunning(false), 2600);
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
            setProgressLabel('⏳ 后台任务运行中...');
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
    const box = $('pv-up');
    box.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'pv-up-row';
    const name = document.createElement('span');
    name.className = 'pv-up-name';
    name.id = 'pv-up-name';
    name.textContent = '👤 ' + (up.name || '未知UP主');
    row.appendChild(name);
    if (up.level != null) {
      const lv = document.createElement('span');
      lv.className = 'pv-up-lv';
      lv.textContent = 'Lv' + up.level;
      row.appendChild(lv);
    }
    if (up.official) {
      const off = document.createElement('span');
      off.className = 'pv-up-official';
      off.textContent = up.official;
      row.appendChild(off);
    }
    box.appendChild(row);

    const stats = document.createElement('div');
    stats.className = 'pv-up-stats';
    const items = [
      [up.fans != null ? up.fans.toLocaleString() : null, '粉丝'],
      [up.archives != null ? String(up.archives) : null, '投稿'],
    ];
    for (const [val, label] of items) {
      if (val == null) continue;
      const stat = document.createElement('div');
      stat.className = 'pv-up-stat';
      const b = document.createElement('b');
      b.textContent = val;
      const s = document.createElement('span');
      s.textContent = label;
      stat.append(b, s);
      stats.appendChild(stat);
    }
    if (stats.children.length) box.appendChild(stats);

    if (up.sign) {
      const sign = document.createElement('div');
      sign.className = 'pv-up-sign';
      sign.textContent = '「' + up.sign + '」';
      box.appendChild(sign);
    }
    showPanel('pv-panel-up');
  }

  function showCloud(words) {
    const box = $('pv-cloud');
    box.innerHTML = '';
    if (!words || !words.length) {
      box.textContent = '（无足够弹幕文本）';
    } else {
      const max = words[0].count, min = words[words.length - 1].count;
      words.forEach(({ word, count }, i) => {
        const span = document.createElement('span');
        const size = max === min ? 14 : 12 + Math.round(((count - min) / (max - min)) * 17);
        span.style.fontSize = size + 'px';
        // 主题感知渐变：accent2 → accent 按排名插值
        const p = words.length > 1 ? Math.round((i / (words.length - 1)) * 100) : 0;
        span.style.color = `color-mix(in srgb, var(--accent2, #7c5cff) ${p}%, var(--accent, #00c8ff))`;
        span.style.animationDelay = Math.min(i * 35, 900) + 'ms';
        span.textContent = `${word}(${count})`;
        span.title = `${word}: ${count} 次`;
        box.appendChild(span);
      });
    }
    showPanel('pv-panel-cloud');
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

    refreshBatch();
  })();

  // ── 事件绑定 ──
  $('pv-btn-start').addEventListener('click', startTask);
  $('pv-btn-cancel').addEventListener('click', cancelTask);
  $('pv-btn-settings').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

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

  // 任务卡整卡点击 / 键盘切换（开关区域由 label 原生处理）
  for (const id of ['pv-task-dm', 'pv-task-cm', 'pv-task-sub']) {
    $(id).addEventListener('click', (e) => {
      if (e.target.closest('.pv-switch')) return;
      const input = $(id).querySelector('input');
      if (!input) return;
      input.checked = !input.checked;
      syncOptionStates();
    });
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
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

  // 清空日志 / 文件（阻止 summary 默认折叠切换）
  $('pv-btn-clear-log').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); clearLog(); });
  $('pv-btn-clear-dl').addEventListener('click', clearDownloads);

  // 快捷键：回车开始 / Esc 取消
  $('pv-bvid').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !running) startTask();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && running) cancelTask();
  });

  // 点击涟漪
  for (const id of ['pv-btn-start', 'pv-btn-copy', 'pv-btn-cookie', 'pv-btn-select-all',
                    'pv-btn-settings', 'pv-btn-clear-log', 'pv-btn-clear-dl',
                    'pv-btn-cancel']) {
    const el = $(id);
    if (el) el.addEventListener('click', addRipple);
  }

  // 连接
  connect();
})();
