// 默认设置统一在 utils.js（DEFAULTS），供安装补齐与设置页共用
import {
  DEFAULTS,
  applyTheme,
  ensureAiHostPermission,
  fetchBalance,
  fetchModelList,
  getAiKey,
  getBiliCookies,
  setAiKey,
} from './utils.js';

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
    if (parsed.aiApiKey) {
      await setAiKey(String(parsed.aiApiKey).trim());
      delete parsed.aiApiKey;
    }
    const cfg = { ...DEFAULTS, ...parsed };
    await saveSettings(cfg);
    clearDirty();
    setImportStatus(`✅ 已导入 ${Object.keys(parsed).length} 项设置`);
    $('import-box').value = '';
    await load();
  } catch (e) {
    setImportStatus('❌ JSON 解析失败: ' + e.message, 'err');
  }
}

// ---- Load settings ----
async function load() {
  const stored = await getSettings();
  const cfg = { ...DEFAULTS, ...stored };
  // 把缺失的默认项（含全部默认勾选项）补齐写入 storage，保证设置永远完整
  if (Object.keys(DEFAULTS).some(k => !(k in stored))) {
    try { await saveSettings(cfg); } catch (e) { }
  }
  $('auto-cookie').checked = cfg.autoCookie;
  const modeSwitch = $('ui-mode');
  modeSwitch.checked = cfg.mode !== 'classic';
  $('mode-label').textContent = modeSwitch.checked ? '预览版' : '经典版';
  $('def-dm').checked = cfg.defaultDanmaku;
  $('def-cm').checked = cfg.defaultComments;
  $('def-sub').checked = cfg.defaultSubtitle;
  $('def-replies').checked = cfg.defaultReplies;
  $('def-format').value = cfg.defaultFormat;
  $('def-sub-lan').value = cfg.defaultSubLan;
  $('def-max-pages').value = cfg.defaultMaxPages;
  $('comment-max-items').value = cfg.commentMaxItems || 0;
  $('comment-rate-delay').value = cfg.commentRateDelay || 400;
  $('sub-time-format').value = cfg.subtitleTimeFormat || 'seconds';
  $('ai-api-key').value = (await getAiKey()) || '';
  $('ai-api-key').setAttribute('placeholder', cfg.aiKeyPersist ? '已开启永久保存（明文存于本机浏览器）' : '仅保存在本浏览器会话中（浏览器重启后需重新输入）');
  $('ai-key-persist').checked = !!cfg.aiKeyPersist;
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
  $('ai-thinking').checked = cfg.aiThinking !== false;
  $('ai-max-tokens').value = cfg.aiMaxTokens || 4000;
  $('ai-sub-start').value = cfg.aiSubStart || '';
  $('ai-sub-end').value = cfg.aiSubEnd || '';
  $('ai-dm-start').value = cfg.aiDmStart || '';
  $('ai-dm-end').value = cfg.aiDmEnd || '';
  $('ai-save-json').checked = cfg.aiSaveJson !== false;
  $('ai-text-only').checked = cfg.aiTextOnly !== false;
  $('ai-max-items').value = cfg.aiMaxItems || 0;
  $('ai-danmaku-prompt').value = cfg.aiDanmakuPrompt || DEFAULTS.aiDanmakuPrompt;
  $('ai-danmaku-max-items').value = cfg.aiDanmakuMaxItems || 500;
  $('ai-comment-prompt').value = cfg.aiCommentPrompt || DEFAULTS.aiCommentPrompt;
  $('ai-comment-max-items').value = cfg.aiCommentMaxItems || 300;
  $('cloud-top-n').value = cfg.cloudTopN || 30;
  $('service-enabled').checked = !!cfg.serviceEnabled;
  $('service-port').value = cfg.servicePort || 8765;
  refreshMcpStatus();
  $('ball-msg-enabled').checked = cfg.ballMsgEnabled !== false;
  $('ball-msg-custom').value = cfg.ballMsgCustom || '';
  selectTheme(cfg.theme || 'aurora', true);
  await refreshCookieDisplay();
  if (await getAiKey()) fetchModels();
}

// ---- Save settings ----
async function save() {
  const settings = {
    mode: $('ui-mode').checked ? 'preview' : 'classic',
    serviceEnabled: $('service-enabled').checked,
    servicePort: Math.min(65535, Math.max(1024, parseInt($('service-port').value) || 8765)),
    autoCookie: $('auto-cookie').checked,
    defaultDanmaku: $('def-dm').checked,
    defaultComments: $('def-cm').checked,
    defaultSubtitle: $('def-sub').checked,
    defaultReplies: $('def-replies').checked,
    defaultFormat: $('def-format').value,
    defaultSubLan: $('def-sub-lan').value,
    defaultMaxPages: parseInt($('def-max-pages').value) || 0,
    commentMaxItems: Math.max(0, parseInt($('comment-max-items').value) || 0),
    commentRateDelay: Math.min(10000, Math.max(100, parseInt($('comment-rate-delay').value) || 400)),
    subtitleTimeFormat: $('sub-time-format').value,
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
    aiThinking: $('ai-thinking').checked,
    aiKeyPersist: $('ai-key-persist').checked,
    aiMaxTokens: Math.min(16000, Math.max(1000, parseInt($('ai-max-tokens').value) || 4000)),
    aiDmStart: $('ai-dm-start').value.trim(),
    aiDmEnd: $('ai-dm-end').value.trim(),
    aiSubStart: $('ai-sub-start').value.trim(),
    aiSubEnd: $('ai-sub-end').value.trim(),
    ballMsgEnabled: $('ball-msg-enabled').checked,
    ballMsgCustom: $('ball-msg-custom').value,
    aiSaveJson: $('ai-save-json').checked,
    aiTextOnly: $('ai-text-only').checked,
    aiMaxItems: parseInt($('ai-max-items').value) || 0,
    aiDanmakuPrompt: $('ai-danmaku-prompt').value.trim(),
    aiDanmakuMaxItems: Math.min(2000, Math.max(10, parseInt($('ai-danmaku-max-items').value) || 500)),
    aiCommentPrompt: $('ai-comment-prompt').value.trim(),
    aiCommentMaxItems: Math.min(5000, Math.max(10, parseInt($('ai-comment-max-items').value) || 300)),
    cloudTopN: Math.min(60, Math.max(10, parseInt($('cloud-top-n').value) || 30))
  };
  try {
    await saveSettings(settings);
    await setAiKey($('ai-api-key').value.trim());
    if ($('ai-api-key').value.trim() && $('ai-base-url').value.trim()) {
      await ensureAiHostPermission($('ai-base-url').value.trim());
    }
    clearDirty();
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
function markDirty() {
  dirty = true;
  const badge = $('dirty-badge');
  if (badge) badge.classList.add('show');
}
function clearDirty() {
  dirty = false;
  const badge = $('dirty-badge');
  if (badge) badge.classList.remove('show');
}
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

// 界面模式开关：即时更新标签文案（保存时才会真正切换 popup）
$('ui-mode').addEventListener('change', () => {
  $('mode-label').textContent = $('ui-mode').checked ? '预览版' : '经典版';
  markDirty();
});

// ============ MCP 服务状态（v2.3.0） ============
function updateMcpCmd() {
  const port = parseInt($('service-port').value) || 8765;
  const cmd = `python mcp_server.py --port ${port}`;
  $('service-cmd').textContent = cmd;
  return { cmd, port };
}
updateMcpCmd();
$('service-port').addEventListener('change', updateMcpCmd);

function setMcpStatus(text, ok = null) {
  $('service-status').textContent = text;
  const dot = $('service-dot');
  dot.style.background = ok === true ? '#34d399' : (ok === false ? '#f87171' : '#3a4266');
  dot.style.boxShadow = ok === true ? '0 0 8px #34d399' : 'none';
}

async function refreshMcpStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'mcpStatus' });
    if (!res) { setMcpStatus('扩展后台不可用'); return; }
    if (!res.enabled) {
      setMcpStatus('MCP 服务未启用（保存设置后生效）');
      return;
    }
    if (res.connected) {
      setMcpStatus(`✅ 已连接本地桥接 ${res.url || ''}`, true);
    } else {
      setMcpStatus('⏳ 未连接：请确认已运行 python mcp_server.py --port <端口>（4 秒自动重连）', false);
    }
  } catch (e) {
    setMcpStatus('状态查询失败');
  }
}
setInterval(refreshMcpStatus, 2000);

$('btn-copy-cmd').addEventListener('click', async (e) => {
  const { cmd } = updateMcpCmd();
  try {
    await navigator.clipboard.writeText(cmd);
    e.currentTarget.textContent = '✅ 已复制';
    setTimeout(() => { e.currentTarget.textContent = '📋 复制启动命令'; }, 1500);
  } catch (err) {
    e.currentTarget.textContent = '❌ 复制失败';
  }
});

// ---- API Key 永久保存：隐私声明确认弹窗（需等待 3 秒） ----
let persistCountdown = null;
function openKeyPersistModal() {
  const modal = $('key-persist-modal');
  const btn = $('key-persist-confirm');
  modal.hidden = false;
  btn.disabled = true;
  let left = 3;
  btn.textContent = `我已知晓并同意（${left}）`;
  clearInterval(persistCountdown);
  persistCountdown = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(persistCountdown);
      btn.disabled = false;
      btn.textContent = '我已知晓并同意';
    } else {
      btn.textContent = `我已知晓并同意（${left}）`;
    }
  }, 1000);
}
function closeKeyPersistModal(confirmed) {
  clearInterval(persistCountdown);
  $('key-persist-modal').hidden = true;
  if (!confirmed) $('ai-key-persist').checked = false; // 取消则回滚开关
}
$('ai-key-persist').addEventListener('change', () => {
  if ($('ai-key-persist').checked) {
    openKeyPersistModal();
  }
});
$('key-persist-confirm').addEventListener('click', () => closeKeyPersistModal(true));
$('key-persist-cancel').addEventListener('click', () => closeKeyPersistModal(false));
$('key-persist-modal').addEventListener('click', (e) => {
  if (e.target === $('key-persist-modal')) closeKeyPersistModal(false); // 点遮罩=取消
});

// 输入 API Key 后自动获取模型列表（防抖 800ms）
$('ai-api-key').addEventListener('input', () => {
  clearTimeout(modelFetchTimer);
  modelFetchTimer = setTimeout(() => fetchModels(), 800);
});
$('ai-base-url').addEventListener('change', () => {
  clearTimeout(modelFetchTimer);
  modelFetchTimer = setTimeout(() => fetchModels(), 300);
});

document.addEventListener('DOMContentLoaded', () => {
  // 动态版本号（v2.1.0）
  try {
    const ver = chrome.runtime.getManifest().version;
    if (ver) $('version-tag').textContent = ver;
  } catch (e) { }
  load();
});

// ---- 左侧标签页切换（记住上次所在页）----
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-page').forEach(p => {
    p.classList.toggle('active', p.dataset.tab === name);
  });
  try { sessionStorage.setItem('optsTab', name); } catch (e) { }
}
document.querySelectorAll('.tab-btn').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});
try {
  const saved = sessionStorage.getItem('optsTab');
  if (saved && document.querySelector(`.tab-btn[data-tab="${saved}"]`)) switchTab(saved);
} catch (e) { }
