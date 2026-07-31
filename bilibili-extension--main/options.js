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
  devMode: false
};

const $ = id => document.getElementById(id);

// ---- Settings storage ----
// 优先读 local（可靠），回退读 sync（兼容旧版本保存的数据）
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

// 写入 local（可靠），同时尝试同步到 sync（失败不影响）
async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
  try { await chrome.storage.sync.set({ settings }); } catch (e) { }
}

// ---- Load current cookies ----
async function refreshCookieDisplay() {
  const ta = $('cookie-display');
  const status = $('cookie-status');
  try {
    const cookies = await getBiliCookies();
    if (cookies.length === 0) {
      ta.value = '(未登录B站，无Cookie)';
      ta.style.color = '#666';
      status.textContent = '⚠️ 无Cookie';
      return;
    }
    const parts = cookies.map(c => `${c.name}=${c.value}`);
    ta.value = parts.join(';\n');
    ta.style.color = '#4caf50';
    status.textContent = `✅ 已读取 ${cookies.length} 项`;
  } catch (e) {
    ta.value = '(读取失败: ' + e.message + ')';
    ta.style.color = '#f44336';
    status.textContent = '❌ 错误';
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
  $('dev-mode').checked = cfg.devMode;
  await refreshCookieDisplay();
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
    devMode: $('dev-mode').checked
  };
  try {
    await saveSettings(settings);
    const msg = $('msg');
    msg.textContent = '✅ 已保存';
    msg.className = 'msg-success';
    setTimeout(() => { msg.textContent = ''; }, 2000);
  } catch (e) {
    const msg = $('msg');
    msg.textContent = '❌ 保存失败: ' + e.message;
    msg.className = 'msg-error';
  }
}

$('btn-save').addEventListener('click', save);
$('btn-refresh-cookie').addEventListener('click', refreshCookieDisplay);
document.addEventListener('DOMContentLoaded', load);
