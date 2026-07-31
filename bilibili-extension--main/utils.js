// ============ MD5 (public domain) ============
const md5 = (function () {
  function md5cycle(x, k) {
    let a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
  }
  function cmn(q, a, b, x, s, t) { a = add32(add32(a, q), add32(x, t)); return add32((a << s) | (a >>> (32 - s)), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function add32(a, b) { return (a + b) & 0xFFFFFFFF; }
  function md5string(s) {
    const n = s.length;
    const m = [];
    for (let i = 0; i < 64; i++) m[i] = 0;
    for (let i = 0; i < n; i++) m[i >> 2] |= s.charCodeAt(i) << ((i % 4) * 8);
    m[n >> 2] |= 0x80 << ((n % 4) * 8);
    m[(((n + 8) >> 6) << 4) + 14] = n * 8;
    const a = [1732584193, -271733879, -1732584194, 271733878];
    for (let i = 0; i < m.length; i += 16) {
      const b = a.slice();
      md5cycle(b, m.slice(i, i + 16));
      a[0] = add32(a[0], b[0]); a[1] = add32(a[1], b[1]);
      a[2] = add32(a[2], b[2]); a[3] = add32(a[3], b[3]);
    }
    const hex = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < 4; i++) {
      out += hex.charAt((a[i] >> 4) & 0xF) + hex.charAt(a[i] & 0xF)
        + hex.charAt((a[i] >> 12) & 0xF) + hex.charAt((a[i] >> 8) & 0xF)
        + hex.charAt((a[i] >> 20) & 0xF) + hex.charAt((a[i] >> 16) & 0xF)
        + hex.charAt((a[i] >> 28) & 0xF) + hex.charAt((a[i] >> 24) & 0xF);
    }
    return out;
  }
  return md5string;
})();

// ============ WBI Signing ============
let wbiKeysCache = null;
let serverTimeOffset = 0; // 服务器时间 - 本地时间（毫秒）

// 获取服务器时间偏移（用于 wts 校准）
async function syncServerTime() {
  try {
    const before = Date.now();
    const resp = await fetch('https://api.bilibili.com/x/report/web/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'platform=web',
      credentials: 'omit'
    });
    const data = await resp.json();
    if (data.data && data.data.timestamp) {
      const rtt = Date.now() - before;
      serverTimeOffset = (data.data.timestamp * 1000 - before) + Math.floor(rtt / 2);
    }
  } catch (e) { /* 校准失败则使用本地时间 */ }
}

function nowServer() { return Date.now() + serverTimeOffset; }

async function getWbiKeys() {
  if (wbiKeysCache && nowServer() - wbiKeysCache.time < 3600000) return wbiKeysCache;
  const resp = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com/',
      'Origin': 'https://www.bilibili.com',
      'Accept': 'application/json, text/plain, */*',
    }
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error('获取WBI密钥失败: ' + (data.message || ''));
  const img = data.data.wbi_img.img_url.split('/').pop().split('.')[0];
  const sub = data.data.wbi_img.sub_url.split('/').pop().split('.')[0];
  wbiKeysCache = { img, sub, time: nowServer() };
  return wbiKeysCache;
}

// WBI 64-element shuffle table (from bilibili-api-python)
const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 37, 12, 46, 61, 7,
  20, 55, 17, 60, 11, 36, 39, 56, 22, 1, 62, 13, 30, 16, 44, 24,
  34, 51, 41, 4, 52, 25, 57, 40, 23, 21, 62, 34, 0, 38, 54, 6
];

function getMixKey(img, sub) {
  const raw = img + sub;
  let mix = '';
  for (let i = 0; i < 32; i++) mix += raw[MIXIN_TABLE[i]];
  return mix;
}

function encryptWbi(params, mixKey) {
  const wts = Math.floor(nowServer() / 1000);
  const all = { ...params, wts };
  const keys = Object.keys(all).sort();
  const str = keys.map(k => `${k}=${all[k]}`).join('&') + mixKey;
  const w_rid = md5(str);
  return { ...all, w_rid };
}

// ============ BV ID Extraction ============
const BV_RE = /BV[a-zA-Z0-9]{10}/;

function extractBVID(raw) {
  if (!raw) return null;
  raw = String(raw).trim().replace(/\/+$/, '');
  const m = raw.match(BV_RE);
  return m ? m[0] : null;
}

// ============ Cookies ============
// 读取 B站 Cookie。优先按 domain 过滤，兜底全量抓取后筛选
// （不同 Chromium 版本对带前导点号的 domain 匹配行为不一致）
async function getBiliCookies() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'bilibili.com' });
    if (cookies.length > 0) return cookies;
  } catch (e) { }
  try {
    const all = await chrome.cookies.getAll({});
    return all.filter(c => (c.domain || '').includes('bilibili.com'));
  } catch (e) { }
  return [];
}

// ============ 弹幕热词 ============
// 高频停用词（常见口语/虚词）
const CLOUD_STOP_WORDS = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '什么', '怎么', '自己', '可以', '一个',
  '真的', '还是', '没有', '不是', '就是', '现在', '时候', '知道', '已经', '这样', '那样',
  '所以', '但是', '然后', '因为', '如果', '虽然', '而且', '或者', '于是', '不过', '还有',
  '大家', '不要', '不会', '不能', '可能', '应该', '东西', '为什么', '一下', '一会',
  '哈哈哈', '哈哈哈哈', '笑死', '无语', 'awsl', 'nb', 'wc', 'yyds'
]);

// 提取文本 token：拉丁词(≥2位) + 中文二元组
function extractTokens(text) {
  const tokens = [];
  const norm = String(text || '').normalize('NFKC').toLowerCase();
  for (const m of norm.matchAll(/[a-z0-9]{2,}/g)) tokens.push(m[0]);
  for (const m of norm.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0];
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

// 弹幕 → 热词频率 [{word, count}]，按频率降序
function danmakuWordCloud(dms, topN = 30) {
  const freq = new Map();
  for (const d of dms || []) {
    for (const t of extractTokens(d.text || '')) {
      if (CLOUD_STOP_WORDS.has(t)) continue;
      if (t.length === 2 && t[0] === t[1]) continue; // 哈哈/喔喔 类叠词
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word, count]) => ({ word, count }));
}

// ============ 主题色 ============
const THEMES = {
  aurora: ['#00c8ff', '#7c5cff'],
  ocean: ['#38bdf8', '#2563eb'],
  forest: ['#4ade80', '#0d9488'],
  candy: ['#f472b6', '#a855f7'],
  sunset: ['#fb923c', '#ef4444']
};

// 应用主题色到当前页面（popup / options / content 共用）
function applyTheme(theme) {
  const [a, b] = THEMES[theme] || THEMES.aurora;
  const root = document.documentElement.style;
  root.setProperty('--accent', a);
  root.setProperty('--accent2', b);
  root.setProperty('--accent-grad', `linear-gradient(135deg, ${a}, ${b})`);
}

// ============ AI 字幕总结（OpenAI 兼容接口） ============
const AI_DEFAULTS = {
  aiBaseUrl: 'https://api.deepseek.com',
  aiModel: 'deepseek-chat',
  aiPrompt: '你是视频字幕分析助手。请用中文总结以下视频字幕，输出三部分：\n1. 主题概述（2-3句话）\n2. 核心要点（编号列表）\n3. 亮点金句（如有）\n\n字幕内容：\n{text}',
  aiDanmakuPrompt: '你是B站弹幕分析助手。请分析以下弹幕（每行一条），用中文输出四部分：\n1. 弹幕情绪倾向（正面/负面/中立的大致占比）\n2. 热议话题（弹幕最关注的几个点）\n3. 名场面 / 高能时刻（被反复刷屏的梗或事件）\n4. 有趣弹幕精选（最多5条）\n\n弹幕内容：\n{text}'
};

// ============ AI API Key（仅存 chrome.storage.session，浏览器会话级，不落盘不同步） ============
// 明文 Key 不进 storage.local/sync，避免同步到云端或长期落盘
async function getAiKey() {
  try {
    const s = await chrome.storage.session.get('aiApiKey');
    if (s.aiApiKey) return s.aiApiKey;
  } catch (e) { }
  // 兼容旧版本：从 local/sync 迁移一次后清理
  for (const area of ['local', 'sync']) {
    try {
      const s = await chrome.storage[area].get('settings');
      if (s.settings && s.settings.aiApiKey) {
        const key = s.settings.aiApiKey;
        try { await chrome.storage.session.set({ aiApiKey: key }); } catch (e) { }
        delete s.settings.aiApiKey;
        try { await chrome.storage[area].set({ settings: s.settings }); } catch (e) { }
        return key;
      }
    } catch (e) { }
  }
  return '';
}

async function setAiKey(key) {
  try { await chrome.storage.session.set({ aiApiKey: key || '' }); } catch (e) { }
}

// 确保对自定义 AI 服务地址有宿主权限（optional_host_permissions）。
// 需在用户手势下调用（设置页保存/点击）；后台无手势时抛明确错误提示
async function ensureAiHostPermission(baseUrl) {
  let origin = null;
  try { origin = new URL(String(baseUrl || '')).origin + '/*'; } catch (e) { return; }
  try {
    if (!await chrome.permissions.contains({ origins: [origin] })) {
      await chrome.permissions.request({ origins: [origin] });
    }
  } catch (e) {
    throw new Error(`AI 服务地址未授权: ${origin.replace('/*', '')}（请打开设置页，在 AI 配置中保存一次以授权）`);
  }
}

// AI 调用统一入口：取 Key + 校验地址权限
async function resolveAiCfg(cfg) {
  const merged = { ...AI_DEFAULTS, ...(cfg || {}) };
  const key = await getAiKey();
  if (!key) throw new Error('未配置 AI API Key（设置 → AI 总结，仅保存在本浏览器会话）');
  await ensureAiHostPermission(merged.aiBaseUrl);
  return { cfg: merged, key };
}

// 构建发送给 AI 的字幕文本（按设置省 token）
// aiTextOnly: 仅文本（默认） / 否则带时间戳；aiMaxItems: 条数上限(0=全部)
function buildAIText(subs, cfg = {}) {
  let items = subs || [];
  if (cfg.aiMaxItems > 0) items = items.slice(0, cfg.aiMaxItems);
  const text = items
    .map(s => cfg.aiTextOnly === false ? `[${fmtFullTime(s.from)}] ${s.content}` : s.content)
    .join('\n');
  return text.slice(0, 20000);
}

// 把字幕片段拼成文本供 AI 使用
function subtitlesToText(subs) {
  return (subs || []).map(s => `[${fmtFullTime(s.from)}] ${s.content}`).join('\n');
}

async function aiSummarize(subs, aiCfg) {
  const { cfg, key } = await resolveAiCfg(aiCfg);
  const text = buildAIText(subs, cfg);
  const content = cfg.aiPrompt.replace(/\{text\}/g, text);
  const base = cfg.aiBaseUrl.replace(/\/+$/, '');
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: cfg.aiModel || 'deepseek-chat',
      messages: [{ role: 'user', content }],
      temperature: 0.4,
      max_tokens: 2000
    })
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json()).error?.message || ''; } catch (e) { }
    throw new Error(`AI 接口错误(HTTP ${resp.status})${detail ? ': ' + detail : ''}`);
  }
  const data = await resp.json();
  const summary = data.choices?.[0]?.message?.content || '';
  if (!summary) throw new Error('AI 返回为空');
  return summary.trim();
}

// 构建发送给 AI 的弹幕文本（去重 + 条数上限）
function buildDanmakuText(dms, maxItems = 500) {
  const seen = new Set();
  const out = [];
  for (const d of dms || []) {
    const t = String(d.text || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= maxItems) break;
  }
  return out.join('\n').slice(0, 20000);
}

// 流式 AI 调用：text 为已构建文本，prompt 支持 {text} 占位符
// onChunk(chunk, fullText) 实时回调；signal 用于取消
async function aiStream(text, prompt, aiCfg, onChunk, signal) {
  const { cfg, key } = await resolveAiCfg(aiCfg);
  const content = String(prompt || '').replace(/\{text\}/g, text || '');
  const base = cfg.aiBaseUrl.replace(/\/+$/, '');
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: cfg.aiModel || 'deepseek-chat',
      messages: [{ role: 'user', content }],
      temperature: 0.4,
      max_tokens: 2000,
      stream: true
    })
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json()).error?.message || ''; } catch (e) { }
    throw new Error(`AI 接口错误(HTTP ${resp.status})${detail ? ': ' + detail : ''}`);
  }
  if (!resp.body) throw new Error('该环境不支持流式输出');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let finished = false;

  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') { finished = true; break; }
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          if (onChunk) onChunk(delta, full);
        }
      } catch (e) { /* 跳过非 JSON 行 */ }
    }
  }
  return full.trim();
}

async function aiSummarize(subs, aiCfg) {
  const { cfg, key } = await resolveAiCfg(aiCfg);
  const text = buildAIText(subs, cfg);
  const content = cfg.aiPrompt.replace(/\{text\}/g, text);
  const base = cfg.aiBaseUrl.replace(/\/+$/, '');
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: cfg.aiModel || 'deepseek-chat',
      messages: [{ role: 'user', content }],
      temperature: 0.4,
      max_tokens: 2000
    })
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json()).error?.message || ''; } catch (e) { }
    throw new Error(`AI 接口错误(HTTP ${resp.status})${detail ? ': ' + detail : ''}`);
  }
  const data = await resp.json();
  const summary = data.choices?.[0]?.message?.content || '';
  if (!summary) throw new Error('AI 返回为空');
  return summary.trim();
}

// AI 流式总结（SSE）。onChunk(chunk, fullText) 实时回调；支持取消
async function aiSummarizeStream(subs, aiCfg, onChunk, signal) {
  const cfg = { ...AI_DEFAULTS, ...(aiCfg || {}) };
  const text = buildAIText(subs, cfg);
  return aiStream(text, cfg.aiPrompt, cfg, onChunk, signal);
}

// 获取模型列表（OpenAI 兼容：GET {base}/models）→ 模型 id 数组
async function fetchModelList(baseUrl, apiKey) {
  if (!apiKey) throw new Error('请先填写 API Key');
  await ensureAiHostPermission(baseUrl);
  const base = (baseUrl || AI_DEFAULTS.aiBaseUrl).replace(/\/+$/, '');
  const resp = await fetch(`${base}/models`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const models = (data.data || []).map(m => m.id).filter(Boolean);
  return [...new Set(models)];
}

// 查询余额（DeepSeek 等平台支持）
async function fetchBalance(baseUrl, apiKey) {
  if (!apiKey) throw new Error('请先填写 API Key');
  await ensureAiHostPermission(baseUrl);
  const base = (baseUrl || AI_DEFAULTS.aiBaseUrl).replace(/\/+$/, '');
  const resp = await fetch(`${base}/user/balance`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const info = (data.balance_infos || [])[0] || {};
  return {
    isAvailable: data.is_available !== false,
    total: info.total_balance,
    granted: info.granted_balance,
    toppedUp: info.topped_up_balance,
    currency: info.currency || ''
  };
}

// ============ Time Formatting ============
function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSRTTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  const pad = (n, z) => String(n).padStart(z, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

function fmtLRCTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}

function fmtASSTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
}

// ============ Danmaku XML Parser ============
function parseDanmakuXML(xmlText) {
  const dms = [];
  const re = /<d p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/g;
  let match;
  while ((match = re.exec(xmlText)) !== null) {
    const parts = match[1].split(',');
    dms.push({
      mode: parseInt(parts[1]) || 1,
      font_size: parseInt(parts[2]) || 25,
      color: parseInt(parts[3]) || 16777215,
      ctime: parseInt(parts[4]) || 0,
      uid: parts[6] || '',
      dm_time: parseFloat(parts[0]) || 0,
      text: match[2].trim()
    });
  }
  return dms;
}

// ============ File Generators ============

function genJSON(data) {
  return JSON.stringify(data, null, 2);
}

function genCSV(rows, fields) {
  const esc = v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = fields.map(f => esc(f.key || f)).join(',');
  const body = rows.map(r => fields.map(f => esc(r[f.key || f])).join(','));
  return '\uFEFF' + header + '\n' + body.join('\n');
}

function genTXT(lines) {
  return lines.join('\n');
}

// SRT 内容转义：去除多余换行，转义 --> 避免破坏时间轴格式
function sanitizeSubText(text) {
  return String(text ?? '').replace(/\r?\n/g, ' ').replace(/-->/g, '→');
}

function genSRT(subtitles) {
  return subtitles.map((s, i) => {
    return `${i + 1}\n${fmtSRTTime(s.from)} --> ${fmtSRTTime(s.to)}\n${sanitizeSubText(s.content)}\n`;
  }).join('\n');
}

function genASS(subtitles, title = 'Bilibili Subtitle') {
  const header = `[Script Info]
Title: ${title}
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,36,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = subtitles.map(s =>
    `Dialogue: 0,${fmtASSTime(s.from)},${fmtASSTime(s.to)},Default,,0,0,0,,${sanitizeSubText(s.content)}`
  ).join('\n');
  return header + events;
}

function genLRC(subtitles) {
  return subtitles.map(s => `[${fmtLRCTime(s.from)}]${sanitizeSubText(s.content)}`).join('\n');
}

// ============ Subtitle Time Format ============
function fmtFullTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  const pad = (n, z) => String(n).padStart(z, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

// ============ Danmaku Formatter ============
function formatDanmakuFlat(dms) {
  return dms.map(d => ({
    time_s: Math.round(d.dm_time * 10) / 10,
    text: d.text,
    mode: d.mode,
    font_size: d.font_size,
    color: d.color,
    uid: d.uid
  }));
}

function formatComment(c, replies = []) {
  return {
    like: c.like || 0,
    uname: c.member?.uname || '',
    time: fmtTime(c.ctime || 0),
    text: c.content?.message || '',
    reply_count: c.rcount || 0,
    rpid: c.rpid || 0,
    replies: replies.map(r => ({
      like: r.like || 0,
      uname: r.member?.uname || '',
      time: fmtTime(r.ctime || 0),
      text: r.content?.message || '',
      reply_to: (r.parent && r.members) ? (r.members[r.parent]?.uname || '') : '',
      rpid: r.rpid || 0
    }))
  };
}
