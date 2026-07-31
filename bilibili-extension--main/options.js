const DEFAULTS = {
  autoCookie: false,
  defaultDanmaku: true,
  defaultComments: false,
  defaultSubtitle: false,
  defaultReplies: false,
  defaultFormat: 'json',
  defaultSubLan: 'ai-zh',
  defaultMaxPages: 0,
  subtitleTimeFormat: 'seconds',
  devMode: false,
  aiApiKey: '',
  aiBaseUrl: 'https://api.deepseek.com',
  aiModel: 'deepseek-chat',
  aiPrompt: '你是视频字幕分析助手。请用中文总结以下视频字幕，输出三部分：\n1. 主题概述（2-3句话）\n2. 核心要点（编号列表）\n3. 亮点金句（如有）\n\n字幕内容：\n{text}',
  showBatch: true,
  showOptsRow: true,
  showAdvancedRow: true,
  showCookie: true,
  showFloatingBall: true,
  theme: 'aurora',
  soundEnabled: true,
  aiStream: true,
  aiSaveJson: true,
  aiTextOnly: true,
  aiMaxItems: 0,
  aiDanmakuPrompt: '你是B站弹幕分析助手。请分析以下弹幕（每行一条），用中文输出四部分：\n1. 弹幕情绪倾向（正面/负面/中立的大致占比）\n2. 热议话题（弹幕最关注的几个点）\n3. 名场面 / 高能时刻（被反复刷屏的梗或事件）\n4. 有趣弹幕精选（最多5条）\n\n弹幕内容：\n{text}',
  aiDanmakuMaxItems: 500,
  cloudTopN: 30
};

const $ = id => document.getElementById(id);

// ---- Settings storage ----
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

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
  try { await chrome.storage.sync.set({ settings }); } catch (e) { }
}

// ---- Cookies ----
async function refreshCookieDisplay() {
  const ta = $('cookie-display');
  const status = $('cookie-status');
  try {
    const cookies = await getBiliCookies();
    if (cookies.length === 0) {
      ta.value = '(未登录B站，无Cookie)';
      status.textContent = '⚠️ 无Cookie';
      status.className = 'status-line warn';
      return;
    }
    const parts = cookies.map(c => `${c.name}=${c.value}`);
    ta.value = parts.join(';\n');
    status.textContent = `✅ 已读取 ${cookies.length} 项`;
    status.className = 'status-line ok';
  } catch (e) {
    ta.value = '(读取失败: ' + e.message + ')';
    status.textContent = '❌ 错误';
    status.className = 'status-line err';
  }
}

// ---- AI: 获取模型列表 ----
let modelFetchTimer = null;
let lastFetchedBase = '';
let lastFetchedKey = '';

function setAiStatus(text, cls = '') {
  const el = $('ai-status');
  el.textContent = text;
  el.className = 'status-line ' + cls;
}

async function fetchModels(manual = false) {
  const key = $('ai-api-key').value.trim();
  const base = $('ai-base-url').value.trim();
  if (!key) {
    if (manual) setAiStatus('⚠️ 请先填写 API Key', 'warn');
    return;
  }
  const btn = $('btn-fetch-models');
  btn.disabled = true;
  setAiStatus('⏳ 正在获取模型列表...');
  try {
    const models = await fetchModelList(base, key);
    if (!models.length) throw new Error('返回为空');
    const dl = $('ai-models');
    dl.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      dl.appendChild(opt);
    }
    const current = $('ai-model').value.trim();
    if (!current || !models.includes(current)) $('ai-model').value = models[0];
    setAiStatus(`✅ 已获取 ${models.length} 个模型: ${models.join(', ')}`, 'ok');
    lastFetchedBase = base;
    lastFetchedKey = key;
  } catch (e) {
    setAiStatus(`❌ 获取失败: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function fetchBalanceNow() {
  const key = $('ai-api-key').value.trim();
  const base = $('ai-base-url').value.trim();
  if (!key) { setAiStatus('⚠️ 请先填写 API Key', 'warn'); return; }
  $('btn-balance').disabled = true;
  setAiStatus('⏳ 正在查询余额...');
  try {
    const b = await fetchBalance(base, key);
    const parts = [];
    if (b.total != null) parts.push(`总余额 ${b.total}${b.currency}`);
    if (b.granted != null) parts.push(`赠送 ${b.granted}${b.currency}`);
    if (b.toppedUp != null) parts.push(`充值 ${b.toppedUp}${b.currency}`);
    setAiStatus(`✅ ${parts.join(' · ') || '查询成功'}`, b.isAvailable === false ? 'warn' : 'ok');
  } catch (e) {
    setAiStatus(`❌ 余额查询失败（部分平台不支持）: ${e.message}`, 'err');
  } finally {
    $('btn-balance').disabled = false;
  }
}

// ---- 主题色板 ----
let currentTheme = DEFAULTS.theme;
function selectTheme(theme, silent = false) {
  currentTheme = theme;
  applyTheme(theme);
  document.querySelectorAll('.swatch-wrap').forEach(w => {
    w.classList.toggle('active', w.dataset.theme === theme);
  });
  if (!silent) markDirty();
}
document.querySelectorAll('.swatch-wrap').forEach(w => {
  w.addEventListener('click', () => selectTheme(w.dataset.theme));
});

// ---- 音效试听（与弹窗一致的合成音）----
let audioCtx = null;
function playTestSound() {
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
    note(880, 0, 0.18);
    note(1174.7, 0.12, 0.22);
    note(520, 0.3, 0.05, 0.07);
    note(1040, 0.34, 0.06, 0.07);
  } catch (e) { }
}

// ---- 备份与恢复 ----
async function exportSettings() {
  const cfg = { ...DEFAULTS, ...(await getSettings()) };
  try {
    await navigator.clipboard.writeText(JSON.stringify(cfg, null, 2));
    setImportStatus('✅ 已复制设置 JSON 到剪贴板', 'ok');
  } catch (e) {
    setImportStatus('❌ 复制失败: ' + e.message, 'err');
  }
}

function setImportStatus(text, cls = '') {
  const el = $('import-status');
  el.textContent = text;
  el.className = cls === 'ok' ? 'ok' : (cls === 'err' ? 'err' : '');
}

async function importSettings() {
  const raw = $('import-box').value.trim();
  if (!raw) { setImportStatus('⚠️ 请先粘贴 JSON', 'warn'); return; }
  try {
    const parsed = JSON.parse(raw);
    const cfg = { ...DEFAULTS, ...parsed };
    await saveSettings(cfg);
    dirty = false;
    setImportStatus(`✅ 已导入 ${Object.keys(parsed).length} 项设置`);
    $('import-box').value = '';
    await load();
  } catch (e) {
    setImportStatus('❌ JSON 解析失败: ' + e.message, 'err');
  }
}

// ---- Load settings ----
async function load() {
  const cfg = { ...DEFAULTS, ...(await getSettings()) };
  $('auto-cookie').checked = cfg.autoCookie;
  $('def-dm').checked = cfg.defaultDanmaku;
  $('def-cm').checked = cfg.defaultComments;
  $('def-sub').checked = cfg.defaultSubtitle;
  $('def-replies').checked = cfg.defaultReplies;
  $('def-format').value = cfg.defaultFormat;
  $('def-sub-lan').value = cfg.defaultSubLan;
  $('def-max-pages').value = cfg.defaultMaxPages;
  $('sub-time-format').value = cfg.subtitleTimeFormat || 'seconds';
  $('ai-api-key').value = cfg.aiApiKey || '';
  $('ai-base-url').value = cfg.aiBaseUrl || DEFAULTS.aiBaseUrl;
  $('ai-model').value = cfg.aiModel || DEFAULTS.aiModel;
  $('ai-prompt').value = cfg.aiPrompt || DEFAULTS.aiPrompt;
  $('dev-mode').checked = cfg.devMode;
  $('show-batch').checked = cfg.showBatch !== false;
  $('show-opts').checked = cfg.showOptsRow !== false;
  $('show-advanced').checked = cfg.showAdvancedRow !== false;
  $('show-cookie').checked = cfg.showCookie !== false;
  $('show-ball').checked = cfg.showFloatingBall !== false;
  $('sound-enabled').checked = cfg.soundEnabled !== false;
  $('ai-stream').checked = cfg.aiStream !== false;
  $('ai-save-json').checked = cfg.aiSaveJson !== false;
  $('ai-text-only').checked = cfg.aiTextOnly !== false;
  $('ai-max-items').value = cfg.aiMaxItems || 0;
  $('ai-danmaku-prompt').value = cfg.aiDanmakuPrompt || DEFAULTS.aiDanmakuPrompt;
  $('ai-danmaku-max-items').value = cfg.aiDanmakuMaxItems || 500;
  $('cloud-top-n').value = cfg.cloudTopN || 30;
  selectTheme(cfg.theme || 'aurora', true);
  await refreshCookieDisplay();
  if (cfg.aiApiKey) fetchModels();
}

// ---- Save settings ----
async function save() {
  const settings = {
    autoCookie: $('auto-cookie').checked,
    defaultDanmaku: $('def-dm').checked,
    defaultComments: $('def-cm').checked,
    defaultSubtitle: $('def-sub').checked,
    defaultReplies: $('def-replies').checked,
    defaultFormat: $('def-format').value,
    defaultSubLan: $('def-sub-lan').value,
    defaultMaxPages: parseInt($('def-max-pages').value) || 0,
    subtitleTimeFormat: $('sub-time-format').value,
    aiApiKey: $('ai-api-key').value.trim(),
    aiBaseUrl: $('ai-base-url').value.trim(),
    aiModel: $('ai-model').value.trim(),
    aiPrompt: $('ai-prompt').value.trim(),
    devMode: $('dev-mode').checked,
    showBatch: $('show-batch').checked,
    showOptsRow: $('show-opts').checked,
    showAdvancedRow: $('show-advanced').checked,
    showCookie: $('show-cookie').checked,
    showFloatingBall: $('show-ball').checked,
    theme: currentTheme,
    soundEnabled: $('sound-enabled').checked,
    aiStream: $('ai-stream').checked,
    aiSaveJson: $('ai-save-json').checked,
    aiTextOnly: $('ai-text-only').checked,
    aiMaxItems: parseInt($('ai-max-items').value) || 0,
    aiDanmakuPrompt: $('ai-danmaku-prompt').value.trim(),
    aiDanmakuMaxItems: Math.min(2000, Math.max(10, parseInt($('ai-danmaku-max-items').value) || 500)),
    cloudTopN: Math.min(60, Math.max(10, parseInt($('cloud-top-n').value) || 30))
  };
  try {
    await saveSettings(settings);
    dirty = false;
    const msg = $('msg');
    msg.textContent = '✅ 已保存';
    msg.className = 'status-line ok';
    setTimeout(() => { msg.textContent = ''; }, 2000);
  } catch (e) {
    const msg = $('msg');
    msg.textContent = '❌ 保存失败: ' + e.message;
    msg.className = 'status-line err';
  }
}

// ---- 未保存更改提示 ----
let dirty = false;
function markDirty() { dirty = true; }
document.addEventListener('input', markDirty, true);
document.addEventListener('change', markDirty, true);
window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---- Events ----
$('btn-save').addEventListener('click', save);
$('btn-refresh-cookie').addEventListener('click', refreshCookieDisplay);
$('btn-fetch-models').addEventListener('click', () => fetchModels(true));
$('btn-balance').addEventListener('click', fetchBalanceNow);
$('btn-sound-test').addEventListener('click', playTestSound);
$('btn-export').addEventListener('click', exportSettings);
$('btn-import').addEventListener('click', importSettings);

// 输入 API Key 后自动获取模型列表（防抖 800ms）
$('ai-api-key').addEventListener('input', () => {
  clearTimeout(modelFetchTimer);
  modelFetchTimer = setTimeout(() => fetchModels(), 800);
});
$('ai-base-url').addEventListener('change', () => {
  clearTimeout(modelFetchTimer);
  modelFetchTimer = setTimeout(() => fetchModels(), 300);
});

document.addEventListener('DOMContentLoaded', load);
