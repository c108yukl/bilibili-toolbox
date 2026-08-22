import {
  AI_DEFAULTS,
  DEFAULTS,
  aiComplete,
  aiStream,
  buildAIText,
  buildCommentText,
  buildDanmakuText,
  danmakuWordCloud,
  encryptWbi,
  extractBVID,
  filterByWindow,
  fmtFullTime,
  formatComment,
  formatDanmakuFlat,
  genASS,
  genCSV,
  genJSON,
  genLRC,
  genSRT,
  genTXT,
  getBiliCookies,
  getMixKey,
  getWbiKeys,
  parseDanmakuProto,
  parseDanmakuXML,
  parseTimeWindow,
  syncServerTime,
} from './utils.js';

// 启动时校准服务器时间（用于 WBI wts）
syncServerTime();

// ============ State ============
let activePort = null;   // 当前连接的前端端口（popup），可为 null（headless）
let running = false;     // 是否有任务在执行
let cancelled = false;   // 取消标记
let taskSeq = 0;         // 任务代次：旧任务 finally 不得覆盖新任务状态
let floatTabId = null;   // 悬浮球/右键任务来源 tab，用于回传结果 toast
const fetches = new Set();   // 所有在途普通 API 请求的 AbortController（统一取消）
const aiAborts = new Set();  // 所有在途 AI 流式请求的 AbortController（支持并发，统一取消）

// 注册/注销一个普通请求控制器；取消任务时全部 abort
function makeAbort() { const c = new AbortController(); fetches.add(c); return c; }
function releaseAbort(c) { fetches.delete(c); }
function abortAll() { for (const c of fetches) c.abort(); for (const c of aiAborts) c.abort(); }

// 注册/注销一个 AI 请求控制器；取消任务时全部 abort
function makeAiAbort() { const c = new AbortController(); aiAborts.add(c); return c; }
function releaseAiAbort(c) { aiAborts.delete(c); }
function abortAllAi() { for (const c of aiAborts) c.abort(); }

// 悬浮球/右键任务结果回传到来源 tab（content script 显示 toast）
function notifyFloat(ok, message) {
  if (floatTabId == null) return;
  try {
    chrome.tabs.sendMessage(floatTabId, { action: 'floatResult', ok, message: String(message || '') });
  } catch (e) { }
}

// ============ Settings ============
let devMode = false;
function devLog(...args) { if (devMode) console.log('[dev]', ...args); }

// ============ 直播弹幕监听（live.bilibili.com） ============
// 协议：B站直播 WS sub 协议 —— 16 字节帧头（包长/头长/版本/操作码/序号）
// AUTH(7) → AUTH_REPLY(8)，HEARTBEAT(2) 每 30s，MESSAGE(5) 推送（ver2=zlib 压缩）
let liveWs = null;
let liveHbTimer = null;
let liveRoomId = null;
let liveLines = [];          // 环形缓冲：全部已收弹幕（导出用）
let liveConnected = false;
const LIVE_WS_URL = 'wss://broadcastlv.chat.bilibili.com/sub';
const LIVE_MAX_LINES = 20000;

function livePack(op, body) {
  const data = new TextEncoder().encode(JSON.stringify(body || {}));
  const buf = new ArrayBuffer(16 + data.length);
  const dv = new DataView(buf);
  dv.setUint32(0, 16 + data.length);
  dv.setUint16(4, 16);
  dv.setUint16(6, 1);        // protover 1（控制帧明文）
  dv.setUint32(8, op);
  dv.setUint32(12, 1);
  new Uint8Array(buf, 16).set(data);
  return buf;
}

async function liveInflate(u8) {
  const ds = new DecompressionStream('deflate');   // zlib 流
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function liveBroadcast(payload) {
  try { chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError); } catch (e) { }
}

async function liveHandleData(u8) {
  // 解析一帧 MESSAGE 数据：JSON 单条或解压后再切帧
  let text = null;
  try { text = new TextDecoder().decode(u8); JSON.parse(text); }
  catch (e) { text = null; }
  if (text) { await liveHandleJSON(JSON.parse(text)); return; }
  try {
    const raw = await liveInflate(u8);
    let off = 0;
    while (off + 16 <= raw.length) {
      const dv = new DataView(raw.buffer, raw.byteOffset + off);
      const len = dv.getUint32(0);
      if (off + len > raw.length) break;
      const body = raw.slice(off + 16, off + len);
      await liveHandleData(body);   // 解压后的子帧
      off += len;
    }
  } catch (e) { devLog('[live] 解压失败', e && e.message); }
}

async function liveHandleJSON(obj) {
  if (!obj || !obj.cmd) return;
  if (obj.cmd === 'DANMU_MSG') {
    const info = obj.info || [];
    const line = {
      ts: Date.now(),
      user: (info[2] && info[2][1]) || '',
      text: info[1] || '',
    };
    if (line.text) {
      liveLines.push(line);
      if (liveLines.length > LIVE_MAX_LINES) liveLines.splice(0, liveLines.length - LIVE_MAX_LINES);
      liveBroadcast({ action: 'liveDanmaku', lines: [line], count: liveLines.length });
    }
  }
  // 其他 cmd（礼物/进场/SC 等）暂不处理，保持轻量
}

async function liveStart(roomId) {
  if (liveConnected && liveRoomId === roomId) return;
  liveStop();
  const cookies = await getBiliCookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const uid = parseInt((cookies.find(c => c.name === 'DedeUserID') || {}).value || '0', 10) || 0;
  const buvid = encodeURIComponent((cookies.find(c => c.name === 'buvid3') || {}).value || '');
  // 弹幕服务器地址 + token（buvid3 防风控 -352）
  const danmu = await biliFetchJSON(
    `https://api.live.bilibili.com/xlive/web-room/v1/danmu/getInfoByRoom?room_id=${roomId}&buvid3=${buvid}`,
    { cookie: cookieStr }
  );
  const token = danmu.token || (danmu.data && danmu.data.token) || '';
  const host = ((danmu.host_list || (danmu.data && danmu.data.host_list) || [{}])[0]);
  const wsUrl = host.host ? `wss://${host.host}:${host.wss_port || 443}/sub` : LIVE_WS_URL;
  liveRoomId = roomId;
  liveLines = [];
  return new Promise((resolve, reject) => {
    try { liveWs = new WebSocket(wsUrl); }
    catch (e) { reject(new Error('无法连接弹幕服务器')); return; }
    liveWs.binaryType = 'arraybuffer';
    const authTimer = setTimeout(() => {
      reject(new Error('弹幕服务器认证超时'));
      liveStop();
    }, 10000);
    liveWs.onopen = () => {
      liveWs.send(livePack(7, {   // AUTH
        uid, roomid: roomId, protover: 2, platform: 'web', type: 2, key: token,
      }));
      liveHbTimer = setInterval(() => {
        try { if (liveWs && liveWs.readyState === WebSocket.OPEN) liveWs.send(livePack(2)); }
        catch (e) { }
      }, 30000);
    };
    liveWs.onmessage = async (ev) => {
      const dv = new DataView(ev.data);
      const op = dv.getUint32(8);
      const body = new Uint8Array(ev.data.slice(16));
      if (op === 8) {          // AUTH_REPLY
        clearTimeout(authTimer);
        let code = -1;
        try { code = (JSON.parse(new TextDecoder().decode(body)) || {}).code; } catch (e) { }
        if (code === 0) {
          liveConnected = true;
          liveBroadcast({ action: 'liveState', on: true, roomId });
          resolve();
        } else {
          reject(new Error('弹幕服务器认证失败(code ' + code + ')'));
          liveStop();
        }
      } else if (op === 5) {   // MESSAGE
        await liveHandleData(body);
      }
    };
    liveWs.onclose = () => {
      const was = liveConnected;
      liveConnected = false;
      clearInterval(liveHbTimer);
      if (was) liveBroadcast({ action: 'liveState', on: false });
    };
    liveWs.onerror = () => {
      clearTimeout(authTimer);
      if (!liveConnected) { reject(new Error('弹幕服务器连接失败')); }
      liveStop();
    };
  });
}

function liveStop() {
  clearInterval(liveHbTimer);
  liveHbTimer = null;
  try { if (liveWs) { liveWs.onclose = null; liveWs.close(); } } catch (e) { }
  liveWs = null;
  if (liveConnected) liveBroadcast({ action: 'liveState', on: false });
  liveConnected = false;
  liveRoomId = null;
}

// 直播间信息（弹窗与 MCP 工具共用；buvid3 防风控 -352）
async function fetchLiveInfo(roomId) {
  const cookies = await getBiliCookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const buvid = encodeURIComponent((cookies.find(c => c.name === 'buvid3') || {}).value || '');
  const data = await biliFetchJSON(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${roomId}&buvid3=${buvid}`,
    { cookie: cookieStr }
  );
  const d = data || {};
  const room = d.room_info || {};
  const anchor = ((d.anchor_info || {}).base_info) || {};
  const watched = (d.watched_show || {}).num;
  return {
    ok: true,
    roomId: room.room_id || roomId,
    title: room.title || '',
    anchor: anchor.uname || '',
    live: room.live_status === 1,
    liveStatus: room.live_status,
    area: room.area_name || '',
    watched: typeof watched === 'number' ? watched.toLocaleString() : '',
  };
}

// ============ UI 风格切换（aurora / editorial / neumorphism） ============
// action.default_popup 是静态的，用 chrome.action.setPopup 按设置动态切换
const STYLE_POPUPS = {
  aurora: 'popup-preview.html',
  editorial: 'popup-editorial.html',
  neumorphism: 'popup-neumorphism.html',
};
async function applyPopupStyle() {
  try {
    const cfg = await getStoredSettings();
    const popup = STYLE_POPUPS[cfg.uiStyle] || STYLE_POPUPS.aurora;
    await chrome.action.setPopup({ popup });
    devLog('[风格] 当前 UI 风格:', cfg.uiStyle || 'aurora');
  } catch (e) { }
}

// 设置变更（options 保存）→ 立即切换 popup 风格与 MCP 服务
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    applyPopupStyle();
    mcpConnect();
  }
});

// 浏览器启动 / 扩展加载时同步一次（保证 popup 与设置一致）
applyPopupStyle();

// ============ MCP 服务桥接（1.2.0） ============
// 架构：AI 客户端(MCP) → 本地 mcp_server.py(HTTP/SSE, 自定义端口) → WebSocket → 本扩展执行
// 工具调用自动携带浏览器 Cookie（chrome.cookies 实时读取，无需手动提供）
let mcpWs = null;
let mcpSession = '';
let mcpReconnectTimer = null;
let mcpConnected = false;

function mcpSend(obj) {
  try {
    if (mcpWs && mcpWs.readyState === WebSocket.OPEN) mcpWs.send(JSON.stringify(obj));
  } catch (e) { }
}

async function mcpConnect() {
  clearTimeout(mcpReconnectTimer);
  const cfg = await getStoredSettings();
  if (!cfg.serviceEnabled) { mcpDisconnect(); return; }
  const port = cfg.servicePort || 8765;
  try {
    if (mcpWs && (mcpWs.readyState === WebSocket.OPEN || mcpWs.readyState === WebSocket.CONNECTING)) return;
  } catch (e) { }
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    mcpWs = ws;
    ws.onopen = () => {
      mcpConnected = true;
      mcpSession = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
      mcpSend({ type: 'hello', session: mcpSession, version: '1.2.0' });
      devLog('[MCP] 已连接本地服务 ws://127.0.0.1:' + port + '/ws');
    };
    ws.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'call') await handleMcpCall(msg);
      } catch (e) { console.error('[MCP] 消息处理失败:', e); }
    };
    ws.onclose = () => {
      mcpConnected = false;
      if (mcpWs === ws) { mcpWs = null; mcpReconnectTimer = setTimeout(mcpConnect, 4000); }
    };
    ws.onerror = () => { try { ws.close(); } catch (e) { } };
  } catch (e) {
    mcpConnected = false;
    mcpWs = null;
    mcpReconnectTimer = setTimeout(mcpConnect, 4000);
  }
}

function mcpDisconnect() {
  clearTimeout(mcpReconnectTimer);
  try { if (mcpWs) mcpWs.close(); } catch (e) { }
  mcpWs = null;
  mcpConnected = false;
}

async function handleMcpCall(msg) {
  const { id, tool, args = {} } = msg;
  try {
    // 自动获取浏览器 Cookie（MCP 工具调用无需用户手动填 Cookie）
    const cookies = await getBiliCookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const data = await executeMcpTool(tool, args, cookieStr);
    mcpSend({ type: 'result', id, ok: true, data });
  } catch (e) {
    mcpSend({ type: 'result', id, ok: false, error: String((e && e.message) || e) });
  }
}

// MCP 工具执行器：映射到扩展既有抓取能力（静默模式，不触发 UI 下载）
async function executeMcpTool(tool, args, cookieStr) {
  const cookie = cookieStr || '';
  switch (tool) {
    case 'get_video_info': {
      const info = await fetchVideoInfo(args.bvid, cookie);
      const d = info.data || {};
      return {
        bvid: args.bvid, title: d.title || '', aid: d.aid, cid: d.cid,
        up: (d.owner || {}).name || '', duration: d.duration || 0,
        danmaku: (d.stat || {}).danmaku || 0, comments: (d.stat || {}).reply || 0,
        views: (d.stat || {}).view || 0,
      };
    }
    case 'fetch_danmaku': {
      const info = await fetchVideoInfo(args.bvid, cookie);
      const dms = await fetchDanmaku(info.cid, cookie, info.data.duration);
      return { count: dms.length, danmaku: formatDanmakuFlat(dms) };
    }
    case 'fetch_comments': {
      const info = await fetchVideoInfo(args.bvid, cookie);
      const items = await handleComments(args.bvid, info.aid, {
        saveFormat: 'json',
        maxPages: args.max_pages || 0,
        maxComments: args.max_comments || 0,
        commentRateDelay: args.rate_delay || 400,
        withReplies: !!args.with_replies,
        cookie,
        mcpMode: true,
      });
      const formatted = (items || []).map(it => formatComment(it.comment, it.replies));
      return { count: formatted.length, comments: formatted };
    }
    case 'fetch_subtitle': {
      const info = await fetchVideoInfo(args.bvid, cookie);
      const result = await fetchSubtitle(info.cid, info.data, cookie, args.lan || '', true);
      if (!result) return { found: false, subtitle: null };
      return { found: true, lan: result.lan, count: result.body.length, srt: genSRT(result.body), lines: result.body };
    }
    case 'word_cloud': {
      const info = await fetchVideoInfo(args.bvid, cookie);
      const dms = await fetchDanmaku(info.cid, cookie, info.data.duration);
      return { words: danmakuWordCloud(dms, args.top_n || 30) };
    }
    case 'get_cookie_status': {
      const cookies = await getBiliCookies();
      const names = cookies.map(c => c.name);
      return {
        logged_in: names.includes('SESSDATA'),
        cookie_count: cookies.length,
        has_sessdata: names.includes('SESSDATA'),
        has_bili_jct: names.includes('bili_jct'),
      };
    }
    case 'get_live_info': {
      const roomId = parseInt(args.room_id || args.bvid, 10);
      if (!roomId) throw new Error('room_id 无效');
      return await fetchLiveInfo(roomId);
    }
    default:
      throw new Error(`未知工具: ${tool}`);
  }
}

// ============ Messaging ============
function send(type, data = {}) {
  if (activePort) {
    try { activePort.postMessage({ type, ...data }); } catch (e) { }
  } else if (type === 'file') {
    // headless（右键菜单 / popup 已关闭）：直接触发浏览器下载
    downloadFile(data.filename, data.content, data.mimeType);
  }
}

function progress(msg, percent) {
  if (typeof percent === 'number') lastPercent = percent;
  send('progress', { message: msg, percent: lastPercent });
}
function info(msg) { send('info', { message: msg }); }
function success(msg) { send('success', { message: msg }); }
function error(msg) { send('error', { message: msg }); }

// ============ 阶段进度模型（1.2.0） ============
// 单视频任务按阶段估算百分比：视频3% → 弹幕8-26% → 字幕28-38% → 评论40-92% → AI 93-99%
// 批量任务按 (i/total) 区间缩放；评论阶段按 known_total（或页数）估算
let lastPercent = 0;
let taskRange = { start: 0, end: 100 }; // 当前视频在批量任务中的进度区间

function stagePercent(inner) {
  const start = taskRange ? taskRange.start : 0;
  const end = taskRange ? taskRange.end : 100;
  return Math.round(start + (end - start) * Math.min(100, Math.max(0, inner)) / 100);
}

async function notify(title, message) {
  if (!activePort) { // headless（右键菜单 / popup 已关闭）时用桌面通知
    try {
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title,
        message
      });
    } catch (e) { }
  }
}

function done(msg) {
  send('done', { message: msg });
  notify('✅ 爬取完成', msg);
  notifyFloat(true, msg);
}

// ============ Download ============
async function downloadFile(filename, content, mimeType) {
  let url = null;
  try {
    url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  } catch (e) {
    url = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
  }
  try {
    await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
  } catch (e) {
    console.error('[下载] 失败:', filename, e.message);
    error(`❌ 下载失败: ${filename}`);
  }
  if (url && url.startsWith('blob:')) {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

// ============ Fetch wrapper (timeout + cancellable) ============
async function biliFetch(url, options = {}) {
  if (cancelled) throw new Error('CANCELLED');
  if (!url || url === 'https:' || url === 'http:') throw new Error(`无效URL: ${url}`);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (options.cookie) headers['Cookie'] = options.cookie;

  // 每个请求独立 controller（此前共享 currentAbort 会互相覆盖，导致取消失效）
  const controller = makeAbort();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(url, { headers, signal: controller.signal, ...(options.fetchOpts || {}) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return resp;
  } catch (e) {
    if (cancelled) throw new Error('CANCELLED');
    if (e.name === 'AbortError') throw new Error(`请求超时: ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
    releaseAbort(controller);
  }
}

async function biliFetchJSON(url, options = {}) {
  const resp = await biliFetch(url, options);
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`API错误(${data.code}): ${data.message || '未知'}`);
  return data.data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 保存格式归一化：不支持的值（如遗留的 md）兜底到 fallback，避免文件扩展名与内容不符
function normalizeSaveFmt(fmt, supported, fallback) {
  return supported.includes(fmt) ? fmt : fallback;
}

// ============ Video Info ============
async function fetchVideoInfo(bvid, cookie, onStage) {
  if (onStage) onStage(2);
  progress(`[视频] 正在获取视频信息...`);
  const data = await biliFetchJSON(
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    { cookie }
  );
  const title = data.title || '';
  const aid = data.aid;
  const cid = data.cid || (data.pages?.[0]?.cid);
  if (onStage) onStage(5);
  progress(`[视频] ${title} (aid=${aid}, cid=${cid})`);
  return { title, aid, cid, data };
}

// ============ Danmaku ============
// 弹幕抓取：有登录 Cookie 时优先走分段接口 seg.so（protobuf，弹幕远多于 list.so；
// 部分高密度视频 list.so 只返回少量抽样），再与 list.so 对比取更多的一份；无 Cookie 直接用 list.so
async function fetchDanmaku(cid, cookie, duration, onStage) {
  if (onStage) onStage(8);
  progress(`[弹幕] 正在获取 (cid=${cid})...`);
  let dms = [];
  if (cookie) {
    const segCount = duration ? Math.max(1, Math.ceil(duration / 360)) : 1;
    for (let i = 1; i <= segCount && !cancelled; i++) {
      if (onStage) onStage(8 + 12 * (i / segCount));
      try {
        const resp = await biliFetch(
          `https://api.bilibili.com/x/v2/dm/web/seg.so?oid=${cid}&type=1&segment_index=${i}`,
          { cookie }
        );
        const buf = await resp.arrayBuffer();
        dms = dms.concat(parseDanmakuProto(buf));
      } catch (e) {
        if (e.message !== 'CANCELLED') progress(`  [弹幕] 分段 ${i} 获取失败: ${e.message}`);
      }
    }
  }
  // list.so 兜底/对比：某些情况下（Cookie 失效、新视频）它反而更多，取多的一方
  if (onStage) onStage(22);
  const listResp = await biliFetch(
    `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`,
    { cookie }
  );
  const listDms = parseDanmakuXML(await listResp.text());
  if (listDms.length > dms.length) dms = listDms;
  dms.sort((a, b) => a.dm_time - b.dm_time);
  if (onStage) onStage(25);
  progress(`[弹幕] 共 ${dms.length} 条`);
  for (const dm of dms.slice(0, 10)) {
    progress(`   [${dm.dm_time.toFixed(1)}s] ${dm.text}`);
  }
  return dms;
}

// ============ UP 主信息 ============
async function fetchUpInfo(mid, cookie) {
  const data = await biliFetchJSON(
    `https://api.bilibili.com/x/web-interface/card?mid=${mid}`,
    { cookie }
  );
  const c = data.card || {};
  return {
    mid,
    name: c.name || '',
    face: c.face || '',
    fans: c.fans ?? null,
    following: c.attention ?? null,
    archives: data.archive_count ?? null,
    sign: c.sign || '',
    level: c.level_info?.current_level ?? null,
    official: c.official?.title || ''
  };
}

// ============ Comments ============
function buildQueryString(params) {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

async function getSignedParams(params) {
  const keys = await getWbiKeys();
  const mixKey = getMixKey(keys.img, keys.sub);
  return encryptWbi(params, mixKey);
}

// Cursor-based API (x/v2/reply/main) - 现行主流评论接口
async function fetchCommentPageCursor(aid, cursor, cookie) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const params = { type: 1, oid: aid, mode: 3 };
    if (cursor) params.next = cursor;
    if (attempt === 1) Object.assign(params, await getSignedParams(params));
    const url = `https://api.bilibili.com/x/v2/reply/main?${buildQueryString(params)}`;
    try {
      return await biliFetchJSON(url, { cookie });
    } catch (e) {
      if (attempt === 0) progress(`  [评论] 主流API受限，尝试WBI签名...`);
      else throw e;
    }
  }
}

// Page-based API (x/v2/reply) - 备用翻页接口
async function fetchCommentPageByPage(aid, pageNum, cookie) {
  const params = { type: 1, oid: aid, pn: pageNum, sort: 2 };
  const signed = await getSignedParams(params);
  const url = `https://api.bilibili.com/x/v2/reply?${buildQueryString(signed)}`;
  const data = await biliFetchJSON(url, { cookie });
  return {
    replies: data.replies || [],
    top_replies: data.top_replies || [],
    cursor: {
      next: pageNum + 1,
      all_count: data.page?.acount || data.page?.count || 0,
      is_end: !data.replies || data.replies.length === 0
    }
  };
}

// 楼中楼回复翻页取全
async function fetchReplies(aid, rpid, rcount, cookie) {
  const results = [];
  const PS = 20;
  const totalPages = Math.min(Math.ceil((rcount || 0) / PS), 20);
  for (let page = 1; page <= totalPages; page++) {
    if (cancelled) throw new Error('CANCELLED');
    try {
      const data = await biliFetchJSON(
        `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${rpid}&ps=${PS}&pn=${page}`,
        { cookie }
      );
      const replies = data.replies || [];
      results.push(...replies);
      if (replies.length < PS) break;
      await sleep(200);
    } catch (e) {
      if (e.message === 'CANCELLED') throw e;
      break; // 单页失败则返回已获取部分
    }
  }
  return results;
}

// ============ Subtitle ============
async function fetchPlayerSubtitle(aid, cid, cookie) {
  try {
    const params = { aid, cid, isGaiaAvoided: false, web_location: 1315873 };
    const signed = await getSignedParams(params);
    const url = `https://api.bilibili.com/x/player/wbi/v2?${buildQueryString(signed)}`;
    devLog('[字幕] Player API URL:', url);
    const data = await biliFetchJSON(url, { cookie });
    return data.subtitle?.subtitles || [];
  } catch (e) {
    devLog('[字幕] Player API失败:', e.message);
    return [];
  }
}

async function fetchSubtitle(cid, videoData, cookie, lanCode, silent) {
  const aid = videoData.aid;
  const bvid = videoData.bvid;

  // Try 1: player API (the correct endpoint for subtitles)
  let subs = [];
  if (aid && cid) subs = await fetchPlayerSubtitle(aid, cid, cookie);

  // Try 2: video info subtitle field (fallback, often has empty URLs)
  if (!subs || subs.length === 0) {
    subs = videoData.subtitle?.subtitles || videoData.subtitle?.list || [];
  }

  // Try 3: re-fetch video info
  if ((!subs || subs.length === 0) && bvid) {
    try {
      const info = await biliFetchJSON(
        `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
        { cookie }
      );
      subs = info.subtitle?.subtitles || info.subtitle?.list || [];
    } catch (e) { }
  }

  if (!subs || subs.length === 0) return null;
  return await downloadSubtitle(subs, cookie, lanCode, silent);
}

// 按用户选择的语言排序候选：所选语言优先，其次 ai-zh > zh-Hans > zh-Hant，最后其余
function buildSubtitleCandidates(subtitles, lanCode) {
  const prefer = ['ai-zh', 'zh-Hans', 'zh-Hant'];
  const ordered = [];
  const seen = new Set();
  const push = s => {
    if (!s || seen.has(s.lan)) return;
    seen.add(s.lan);
    ordered.push(s);
  };
  if (lanCode) {
    const exact = subtitles.find(s => s.lan === lanCode);
    if (exact) push(exact);
  }
  for (const p of prefer) {
    if (p === lanCode) continue;
    push(subtitles.find(s => s.lan === p));
  }
  for (const s of subtitles) push(s);
  return ordered;
}

async function downloadSubtitle(subtitles, cookie, lanCode, silent) {
  const candidates = buildSubtitleCandidates(subtitles, lanCode);

  for (const picked of candidates) {
    if (!picked.subtitle_url) {
      devLog(`[字幕] 跳过 ${picked.lan_doc || picked.lan} (URL为空)`);
      continue;
    }
    let url = picked.subtitle_url;
    if (url.startsWith('//')) url = 'https:' + url;
    else if (!url.startsWith('http')) url = 'https:' + url;
    try {
      const resp = await biliFetch(url, { cookie });
      const data = await resp.json();
      const body = data.body || [];
      if (body.length > 0) {
        progress(`[字幕] 成功获取: ${picked.lan_doc || picked.lan} (${body.length}条)`);
        return { body, lan: picked.lan };
      }
      devLog(`[字幕] ${picked.lan_doc || picked.lan} 内容为空，尝试下一个`);
    } catch (e) {
      progress(`  [字幕] ${picked.lan_doc || picked.lan} 下载失败，尝试下一个...`);
    }
  }
  if (!silent) error('❌ 该视频没有可下载的字幕文件');
  return null;
}

// ============ Task: Danmaku ============
// 抓取弹幕 + 生成文件 + 热词统计；AI 分析由 processOneVideo 末尾并发执行
// 返回弹幕数组（供 AI 分析使用），取消/失败返回 null
async function handleDanmaku(bvid, cid, params, duration, onStage) {
  const fmt = normalizeSaveFmt(params.saveFormat, ['json', 'csv', 'txt'], 'txt');
  const dms = await fetchDanmaku(cid, params.cookie, duration, onStage);
  if (cancelled) return null;
  if (onStage) onStage(26);

  const flat = formatDanmakuFlat(dms);
  let content = '';
  let mimeType = 'application/octet-stream';
  const filenameBase = `danmaku_${bvid}`;

  if (fmt === 'json') {
    content = genJSON(flat);
    mimeType = 'application/json';
  } else if (fmt === 'csv') {
    content = genCSV(flat, [
      { key: 'time_s' }, { key: 'text' }, { key: 'mode' },
      { key: 'font_size' }, { key: 'color' }, { key: 'uid' }
    ]);
    mimeType = 'text/csv';
  } else {
    content = genTXT(dms.map(d => `[${d.dm_time.toFixed(1)}s] ${d.text}`));
    mimeType = 'text/plain';
  }

  send('file', { task: 'danmaku', filename: `${filenameBase}.${fmt}`, content, mimeType });
  success(`✅ 弹幕完成: ${dms.length} 条`);

  // 弹幕热词（本地统计，不走 AI）
  if (params.wordCloud && !cancelled) {
    const words = danmakuWordCloud(dms, params.cloudTopN || 30);
    send('cloud', { bvid, words });
    if (words.length > 0) {
      send('file', {
        task: 'cloud',
        filename: `cloud_${bvid}.json`,
        content: genJSON(words),
        mimeType: 'application/json'
      });
      success(`☁️ 热词完成: ${words.length} 个`);
    } else {
      progress('☁️ 无足够弹幕文本生成热词');
    }
  }

  return dms;
}

// ============ Task: Comments ============
// 翻页抓取评论（支持页数/条数上限 + 可调速率的滑动窗口），返回评论数组
// 滑动窗口：maxComments > 0 时达到目标条数立即停止，超出部分截断（保留热门在前）
async function handleComments(bvid, aid, params, onStage) {
  const fmt = normalizeSaveFmt(params.saveFormat, ['json', 'csv', 'txt'], 'txt');
  const maxPages = params.maxPages || 0;
  const maxComments = params.maxComments || 0; // 0 = 不限条数
  const rateDelay = params.commentRateDelay || 400; // 评论翻页间隔（毫秒）
  const withReplies = params.withReplies;
  const MAX_ITEMS = 10000;
  const EMPTY_BREAK = 2;

  let allItems = [];
  let cursor = undefined;
  let emptyStreak = 0;
  let page = 1;
  let knownTotal = 0;
  let usingPageApi = false; // 一旦降级到 page 接口就保持使用
  const seenRpid = new Set(); // 置顶/普通评论去重（B站可能重复返回）

  if (onStage) onStage(40);
  progress(`[评论] 开始获取...`);

  while (true) {
    if (cancelled) return null;
    if (maxPages > 0 && page > maxPages) { progress(`  已达目标页数 ${maxPages}，停止`); break; }
    if (maxComments > 0 && allItems.length >= maxComments) { progress(`  已达目标条数 ${maxComments}，停止`); break; }
    if (allItems.length >= MAX_ITEMS) { progress(`  达到安全上限 ${MAX_ITEMS}，停止`); break; }

    let data;
    if (usingPageApi) {
      data = await fetchCommentPageByPage(aid, page, params.cookie);
    } else {
      try {
        data = await fetchCommentPageCursor(aid, cursor, params.cookie);
      } catch (e) {
        if (cancelled) return null;
        progress(`  [评论] 主流API被风控，切换备用接口...`);
        data = await fetchCommentPageByPage(aid, page, params.cookie);
        usingPageApi = true;
      }
    }
    if (cancelled) return null;

    const cursorData = data.cursor || {};
    knownTotal = cursorData.all_count || knownTotal;

    // 置顶评论（top_replies）：与普通评论合并，置顶保持最前；按 rpid 去重（B站可能重复返回）
    const topReplies = data.top_replies || [];
    const replies = data.replies || [];

    if (topReplies.length === 0 && replies.length === 0) {
      emptyStreak++;
      if (emptyStreak >= EMPTY_BREAK) { progress(`  连续${emptyStreak}页无数据，停止`); break; }
    } else {
      emptyStreak = 0;
      let replyCount = 0;
      const pushComment = async (c) => {
        if (cancelled) return;
        if (seenRpid.has(c.rpid)) return;
        seenRpid.add(c.rpid);
        let subReplies = [];
        if (withReplies && (c.rcount || 0) > 0) {
          subReplies = await fetchReplies(aid, c.rpid, c.rcount, params.cookie);
          await sleep(150);
        }
        allItems.push({ comment: c, replies: subReplies });
        replyCount += subReplies.length;
      };
      for (const c of topReplies) {
        await pushComment(c);
        // 滑动窗口：置顶也计入目标条数，达到立即停止本页
        if (maxComments > 0 && allItems.length >= maxComments) break;
      }
      for (const c of replies) {
        if (cancelled) return null;
        await pushComment(c);
        // 滑动窗口：逐条累计，达到目标条数立即停止本页
        if (maxComments > 0 && allItems.length >= maxComments) break;
      }
      const topTag = topReplies.length ? ` / ${topReplies.length} 置顶` : '';
      // 进度估算（1.2.0）：已知总数按已获取比例；未知按页数线性估算（评论阶段映射 40→92）
      let innerPct;
      if (knownTotal > 0) {
        innerPct = Math.min(90, 40 + 50 * Math.min(1, allItems.length / knownTotal));
      } else {
        innerPct = Math.min(90, 40 + page * 5);
      }
      progress(`  第${page}页 +${replies.length} 评论${topTag} / +${replyCount} 回复 (累计 ${allItems.length} / ${knownTotal || '?'})`, onStage ? onStage(innerPct) : undefined);
    }

    if (cursorData.is_end) { progress(`  已到最后一页`); break; }
    if (knownTotal && allItems.length >= knownTotal) { progress(`  已获取全部 ${knownTotal} 条`); break; }
    if (maxComments > 0 && allItems.length >= maxComments) { progress(`  已达目标条数 ${maxComments}，停止`); break; }

    if (usingPageApi) {
      page++; // 页码接口按页递增，cursor 不适用
    } else {
      cursor = cursorData.next;
      if (!cursor) break;
      page++;
    }
    await sleep(rateDelay);
  }

  if (cancelled) return null;

  // 滑动窗口截断：只保留前 maxComments 条（超出的页数据丢弃）
  if (maxComments > 0 && allItems.length > maxComments) {
    allItems.length = maxComments;
  }

  const totalR = allItems.reduce((s, i) => s + (i.replies?.length || 0), 0);
  if (onStage) onStage(92);
  progress(`\n[评论] 完成: ${allItems.length} 评论, ${totalR} 回复`);

  const formatted = allItems.map(item => formatComment(item.comment, item.replies));
  const filenameBase = `comments_${bvid}`;
  let content, mimeType;

  if (fmt === 'json') {
    content = genJSON(formatted);
    mimeType = 'application/json';
  } else if (fmt === 'csv') {
    const rows = [];
    for (const item of formatted) {
      rows.push({ level: 'comment', like: item.like, uname: item.uname, time: item.time,
        text: item.text, reply_count: item.reply_count, reply_to: '', rpid: item.rpid });
      for (const r of item.replies) {
        rows.push({ level: 'reply', like: r.like, uname: r.uname, time: r.time,
          text: r.text, reply_count: '', reply_to: r.reply_to, rpid: r.rpid });
      }
    }
    content = genCSV(rows, [
      { key: 'level' }, { key: 'like' }, { key: 'uname' },
      { key: 'time' }, { key: 'text' }, { key: 'reply_count' },
      { key: 'reply_to' }, { key: 'rpid' }
    ]);
    mimeType = 'text/csv';
  } else {
    const lines = [];
    for (const item of formatted) {
      lines.push(`[+${item.like}] ${item.uname}: ${item.text}`);
      for (const r of item.replies) {
        const replyTo = r.reply_to ? `回复 @${r.reply_to}` : '';
        lines.push(`  ↳[+${r.like}] ${r.uname}${replyTo}: ${r.text}`);
      }
    }
    content = genTXT(lines);
    mimeType = 'text/plain';
  }

  if (!params.mcpMode) {
    send('file', { task: 'comments', filename: `${filenameBase}.${fmt}`, content, mimeType });
    success(`✅ 评论完成: ${allItems.length} 评论, ${totalR} 回复`);
  }
  return allItems;
}

// ============ AI 分析（弹幕 / 字幕 / 评论，可并发） ============
// 三个函数各自独立，供 processOneVideo 以 Promise.all 并发执行；
// 均支持：流式输出（含思考过程 reasoning）、MD + 结构化 JSON 保存、取消

// AI 弹幕分析：去重后交给 AI 分析情绪/话题/名场面/有趣精选
// 支持时间窗口（aiDmStart/aiDmEnd，如 "2:30"~"10:00"）：只分析视频某一段的弹幕
async function runAiDanmakuAnalysis(bvid, dms, params, onStage) {
  if (cancelled) return;
  try {
    const aiCfg = await getStoredSettings();
    const winDms = filterByWindow(dms, d => d.dm_time, aiCfg.aiDmStart, aiCfg.aiDmEnd);
    const text = buildDanmakuText(winDms, aiCfg.aiDanmakuMaxItems || 500);
    if (!text) { progress('🤖 [AI弹幕] 无弹幕可分析'); return; }
    const range = (parseTimeWindow(aiCfg.aiDmStart) != null || parseTimeWindow(aiCfg.aiDmEnd) != null)
      ? `（时间窗 ${aiCfg.aiDmStart || '0:00'} ~ ${aiCfg.aiDmEnd || '结尾'}，${winDms.length}/${dms.length} 条）` : '';
    if (onStage) onStage(93);
    progress(`🤖 AI 正在分析弹幕（流式输出）...${range}`);
    const prompt = aiCfg.aiDanmakuPrompt || AI_DEFAULTS.aiDanmakuPrompt;
    const controller = makeAiAbort();
    try {
      const { content: analysis, reasoning } = await callAi(text, prompt, aiCfg, controller,
        (full, thinking) => send('ai-dm', { bvid, partial: full, done: false, thinking }));
      if (cancelled || !analysis) return;
      if (onStage) onStage(94);
      send('ai-dm', { bvid, partial: analysis, done: true, thinking: reasoning });
      send('file', {
        task: 'analysis',
        filename: `analysis_${bvid}.md`,
        content: analysis,
        mimeType: 'text/markdown'
      });
      if (aiCfg.aiSaveJson !== false) {
        send('file', {
          task: 'analysis-json',
          filename: `analysis_${bvid}.json`,
          content: genJSON({
            bvid,
            danmaku_count: dms.length,
            analyzed_lines: text.split('\n').length,
            generated_at: new Date().toISOString(),
            analysis,
            thinking: reasoning || undefined
          }),
          mimeType: 'application/json'
        });
      }
      success('🤖 AI 弹幕分析完成');
    } finally {
      releaseAiAbort(controller);
    }
  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'CANCELLED' || cancelled) {
      error('⛔ AI 弹幕分析已取消');
    } else {
      error(`🤖 AI 弹幕分析失败: ${e.message}`);
    }
  }
}

// AI 字幕总结：MD 总结 + 结构化 JSON（标题/UP主/时间）
// 支持时间窗口（aiSubStart/aiSubEnd，如 "0:00"~"5:00"）：只总结视频某一段的字幕
async function runAiSubtitleSummary(bvid, subs, lan, videoData, params, onStage) {
  if (cancelled) return;
  try {
    const aiCfg = await getStoredSettings();
    const winSubs = filterByWindow(subs, s => s.from, aiCfg.aiSubStart, aiCfg.aiSubEnd);
    const range = (parseTimeWindow(aiCfg.aiSubStart) != null || parseTimeWindow(aiCfg.aiSubEnd) != null)
      ? `（时间窗 ${aiCfg.aiSubStart || '0:00'} ~ ${aiCfg.aiSubEnd || '结尾'}，${winSubs.length}/${subs.length} 条）` : '';
    if (onStage) onStage(95);
    progress(`🤖 AI 正在总结字幕（流式输出）...${range}`);
    const text = buildAIText(winSubs, aiCfg);
    const prompt = aiCfg.aiPrompt || AI_DEFAULTS.aiPrompt;
    const controller = makeAiAbort();
    try {
      const { content: summary, reasoning } = await callAi(text, prompt, aiCfg, controller,
        (full, thinking) => send('summary', { bvid, lan, partial: full, done: false, thinking }));
      if (cancelled || !summary) return;
      if (onStage) onStage(96);
      send('summary', { bvid, lan, partial: summary, done: true, thinking: reasoning });
      send('file', {
        task: 'summary',
        filename: `summary_${bvid}_${lan}.md`,
        content: summary,
        mimeType: 'text/markdown'
      });
      if (aiCfg.aiSaveJson !== false) {
        const data = videoData.data || {};
        send('file', {
          task: 'summary-json',
          filename: `summary_${bvid}_${lan}.json`,
          content: genJSON({
            bvid,
            title: data.title || '',
            url: `https://www.bilibili.com/video/${bvid}`,
            up: data.owner?.name || '',
            up_mid: data.owner?.mid || null,
            subtitle_lan: lan,
            subtitle_count: subs.length,
            generated_at: new Date().toISOString(),
            summary,
            thinking: reasoning || undefined
          }),
          mimeType: 'application/json'
        });
      }
      success('🤖 AI 总结完成');
    } finally {
      releaseAiAbort(controller);
    }
  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'CANCELLED' || cancelled) {
      error('⛔ AI 总结已取消');
    } else {
      error(`🤖 AI 总结失败: ${e.message}`);
    }
  }
}

// AI 评论分析：总结评论区 + 情感倾向分析（流式输出）
async function runAiCommentsAnalysis(bvid, items, params, onStage) {
  if (cancelled) return;
  try {
    const aiCfg = await getStoredSettings();
    const text = buildCommentText(items, aiCfg.aiCommentMaxItems || 300);
    if (!text) { progress('🤖 [AI评论] 无评论可分析'); return; }
    if (onStage) onStage(97);
    progress(`🤖 AI 正在分析评论（${items.length} 条，流式输出）...`);
    const prompt = aiCfg.aiCommentPrompt || AI_DEFAULTS.aiCommentPrompt;
    const controller = makeAiAbort();
    try {
      const { content: analysis, reasoning } = await callAi(text, prompt, aiCfg, controller,
        (full, thinking) => send('ai-cm', { bvid, partial: full, done: false, thinking }));
      if (cancelled || !analysis) return;
      if (onStage) onStage(98);
      send('ai-cm', { bvid, partial: analysis, done: true, thinking: reasoning });
      send('file', {
        task: 'comment-analysis',
        filename: `analysis_comments_${bvid}.md`,
        content: analysis,
        mimeType: 'text/markdown'
      });
      if (aiCfg.aiSaveJson !== false) {
        send('file', {
          task: 'comment-analysis-json',
          filename: `analysis_comments_${bvid}.json`,
          content: genJSON({
            bvid,
            comment_count: items.length,
            analyzed_lines: text.split('\n').length,
            generated_at: new Date().toISOString(),
            analysis,
            thinking: reasoning || undefined
          }),
          mimeType: 'application/json'
        });
      }
      success('🤖 AI 评论分析完成');
    } finally {
      releaseAiAbort(controller);
    }
  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'CANCELLED' || cancelled) {
      error('⛔ AI 评论分析已取消');
    } else {
      error(`🤖 AI 评论分析失败: ${e.message}`);
    }
  }
}

// AI 统一调用入口：按设置选择流式/非流式，并转发思考过程
// onProgress(fullText, fullThinking) 仅流式时实时回调（正文/思考各一块进度）
// ⚠️ 注意：正文/思考状态必须为每次调用私有！
// 此前用模块级共享对象，三个 AI 任务并发时相互覆盖，导致
// “字幕面板思考正确但正文是弹幕内容/截断”的串扰 bug
async function callAi(text, prompt, aiCfg, controller, onProgress) {
  if (aiCfg.aiStream === false) return aiComplete(text, prompt, aiCfg);
  let curFull = '';
  let curThinking = '';
  return aiStream(text, prompt, aiCfg, (chunk, fullText) => {
    if (cancelled) { controller.abort(); return; }
    curFull = fullText;
    onProgress(fullText, curThinking);
  }, controller.signal, (rChunk, rFull) => {
    curThinking = rFull;
    onProgress(curFull, rFull);
  });
}

// ============ Task: Subtitle ============
// 抓取字幕 + 生成文件；AI 总结由 processOneVideo 末尾并发执行
// 返回 { body, lan }（供 AI 总结使用）；无字幕/取消返回 null
async function handleSubtitle(bvid, cid, videoData, params, onStage) {
  const fmt = normalizeSaveFmt(params.saveFormat, ['json', 'srt', 'ass', 'lrc', 'txt'], 'txt');
  const lanCode = params.subLan;

  if (onStage) onStage(28);
  const result = await fetchSubtitle(cid, videoData, params.cookie);
  if (!result) {
    error('❌ 该视频没有字幕');
    return null;
  }
  const { body: subs, lan } = result;
  if (cancelled) return null;
  if (onStage) onStage(36);

  progress(`[字幕] 共 ${subs.length} 条字幕片段`);
  const filenameBase = `subtitle_${bvid}_${lan}`;
  const useFullTime = params.subtitleTimeFormat === 'full';
  let content, mimeType;

  if (fmt === 'json') {
    content = genJSON(subs);
    mimeType = 'application/json';
  } else if (fmt === 'srt') {
    content = genSRT(subs);
    mimeType = 'text/plain';
  } else if (fmt === 'ass') {
    content = genASS(subs, `${bvid} Subtitle`);
    mimeType = 'text/plain';
  } else if (fmt === 'lrc') {
    content = genLRC(subs);
    mimeType = 'text/plain';
  } else {
    const timeTag = useFullTime
      ? s => `[${fmtFullTime(s.from)}] ${s.content}`
      : s => `[${s.from.toFixed(1)}s] ${s.content}`;
    content = genTXT(subs.map(timeTag));
    mimeType = 'text/plain';
  }

  send('file', { task: 'subtitle', filename: `${filenameBase}.${fmt}`, content, mimeType });
  success(`✅ 字幕完成: ${subs.length} 条`);
  return { body: subs, lan };
}

// ============ Settings ============
async function getStoredSettings() {
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

async function loadSettings() {
  try {
    const cfg = await getStoredSettings();
    devMode = !!cfg.devMode;
  } catch (e) { }
}

// ============ Main Task Orchestrator ============
// bvidList: 批量列表；单个 bvid 时视为单视频任务
async function startTask(bvid, params) {
  cancelled = false;
  running = true;
  const mySeq = ++taskSeq; // 代次守卫：旧任务的收尾不能覆盖新任务状态
  try { await loadSettings(); } catch (e) { }

  const bvidList = (params.bvidList && params.bvidList.length)
    ? params.bvidList
    : [bvid];
  const total = bvidList.length;
  const failed = [];

  try {
    for (let i = 0; i < total; i++) {
      if (cancelled) return;
      const current = bvidList[i];
      // 当前视频在批量任务中的进度区间（单视频 = 0-100）
      taskRange = total > 1
        ? { start: (i / total) * 100, end: ((i + 1) / total) * 100 }
        : { start: 0, end: 100 };
      const percent = Math.round(taskRange.start);
      if (total > 1) {
        progress(`\n▶️ [${i + 1}/${total}] 处理 ${current}`, percent);
      }

      try {
        await processOneVideo(current, params, i, total);
      } catch (e) {
        if (e.message === 'CANCELLED' || cancelled) throw e;
        failed.push(`${current} (${e.message})`);
        error(`❌ ${current} 失败: ${e.message}`);
      }
    }

    if (cancelled) return;
    const msg = total > 1
      ? `批量完成 ${total - failed.length}/${total} 个视频${failed.length ? `，失败 ${failed.length} 个` : ''}`
      : '全部爬取完成！';
    done(msg);
    if (failed.length) notifyFloat(false, msg);
  } catch (e) {
    if (e.message === 'CANCELLED' || cancelled) {
      error('⛔ 已取消');
      notify('⛔ 任务已取消', total > 1 ? `已处理 ${bvidList.join(',')}` : bvid);
      notifyFloat(false, '⛔ 任务已取消');
    } else {
      error(`❌ 出错: ${e.message}`);
      notify('❌ 爬取失败', `${bvid}: ${e.message}`);
      notifyFloat(false, `❌ 爬取失败: ${e.message}`);
      console.error(e);
    }
  } finally {
    if (mySeq === taskSeq) { // 仅最新任务可收尾，防止旧任务覆盖新任务状态
      running = false;
      cancelled = false;
    }
  }
}

async function processOneVideo(bvid, params, index, total) {
  const pct = stagePercent; // 阶段内 0-100 → 全局百分比
  // 1. Get video info (needed for all tasks)
  const videoInfo = await fetchVideoInfo(bvid, params.cookie, pct);
  if (cancelled) return;
  const { aid, cid } = videoInfo;
  const owner = videoInfo.data.owner || {};

  // 2. UP 主信息
  if (params.upInfo && !cancelled) {
    try {
      const up = owner.mid ? await fetchUpInfo(owner.mid, params.cookie) : null;
      if (up) {
        send('up', { bvid, up });
        send('file', {
          task: 'up',
          filename: `up_${bvid}.json`,
          content: genJSON(up),
          mimeType: 'application/json'
        });
        success(`👤 UP主: ${up.name} (粉丝 ${up.fans ?? '?'})`);
      }
    } catch (e) {
      if (e.message !== 'CANCELLED') progress(`  [UP主] 获取失败: ${e.message}`);
    }
  }

  // 3. Danmaku（抓完立即启动 AI 弹幕分析，与评论爬取并行）
  const aiTasks = []; // 收集 AI 分析任务，数据就绪即启动，末尾统一等待
  let danmakuData = null;
  if (params.danmaku && !cancelled) {
    try { danmakuData = await handleDanmaku(bvid, cid, params, videoInfo.data.duration, pct); }
    catch (e) { if (e.message !== 'CANCELLED') error(`❌ 弹幕出错: ${e.message}`); }
  }
  if (params.aiDanmaku && danmakuData) aiTasks.push(runAiDanmakuAnalysis(bvid, danmakuData, params, pct));

  // 4. Subtitle（抓完立即启动 AI 字幕总结，与评论爬取并行）
  let subtitleData = null;
  if (params.subtitle && !cancelled) {
    try { subtitleData = await handleSubtitle(bvid, cid, videoInfo.data, params, pct); }
    catch (e) { if (e.message !== 'CANCELLED') error(`❌ 字幕出错: ${e.message}`); }
  }
  if (params.aiSummary && subtitleData) aiTasks.push(runAiSubtitleSummary(bvid, subtitleData.body, subtitleData.lan, videoInfo, params, pct));

  // 5. Comments（滑动窗口 + 速率控制；期间上面的弹幕/字幕 AI 分析已在后台运行）
  let commentsData = null;
  if (params.comments && !cancelled) {
    try { commentsData = await handleComments(bvid, aid, params, pct); }
    catch (e) { if (e.message !== 'CANCELLED') error(`❌ 评论出错: ${e.message}`); }
  }
  if (params.aiComments && commentsData) aiTasks.push(runAiCommentsAnalysis(bvid, commentsData, params, pct));

  // 6. AI 分析统一等待完成（弹幕/字幕任务早已启动，评论任务最后加入；全程可取消）
  if (cancelled) return;
  if (aiTasks.length > 0) {
    progress(`🤖 AI 分析启动（${aiTasks.length} 个任务并发，弹幕/字幕无需等待评论）...`, pct(93));
    await Promise.all(aiTasks);
  }
  progress('', pct(99));
}

// ============ Message Handler ============
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'scraper') return;

  activePort = port;

  port.onMessage.addListener(async (msg) => {
    if (msg.action === 'start') {
      if (running) { // 已有任务 → 先取消旧的
        cancelled = true;
        abortAll();
        await sleep(300);
        cancelled = false;
      }
      startTask(msg.bvid, msg.params);
    } else if (msg.action === 'cancel') {
      cancelled = true;
      abortAll();
      notifyFloat(false, '⛔ 任务已取消');
      try { port.postMessage({ type: 'abort', message: '已取消' }); } catch (e) { }
    } else if (msg.action === 'status') {
      // 弹窗打开即唤醒 SW：顺带补一次 MCP 重连（防重连定时器随休眠丢失）
      if (!mcpConnected) { getStoredSettings().then(c => { if (c.serviceEnabled) mcpConnect(); }).catch(() => {}); }
      try { port.postMessage({ type: 'status', running, cancelled }); } catch (e) { }
    }
  });

  port.onDisconnect.addListener(() => {
    if (activePort === port) activePort = null;
    // 注意：popup 关闭不取消任务，任务在后台继续，下载走 chrome.downloads
  });
});

// ============ Runtime Message（content script 悬浮球等）============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'mcpStatus') {
    // 服务状态查询（设置页轮询）。SW 休眠会杀死 4s 重连定时器，
    // 故每次轮询发现"已启用但未连接"时主动补一次重连（唤醒即恢复）
    (async () => {
      let enabled = false;
      try {
        const cfg = await getStoredSettings();
        enabled = !!cfg.serviceEnabled;
        if (enabled && !mcpConnected) mcpConnect();
      } catch (e) { }
      try {
        sendResponse({ enabled, connected: mcpConnected, url: mcpWs ? mcpWs.url : null, session: mcpSession });
      } catch (e) { }
    })();
    return true;
  }
  if (msg.action === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === 'checkVideo') {
    // 悬浮球：查询视频信息（标题 + 弹幕数 + 是否有字幕），用于播放入场提示
    (async () => {
      const resp = { ok: true, bvid: msg.bvid, title: '', danmaku: 0, hasSubtitle: false };
      try {
        const info = await fetchVideoInfo(msg.bvid, '');
        resp.title = info.data?.title || '';
        resp.danmaku = info.data?.stat?.danmaku || 0;
        const cid = info.data?.cid;
        if (cid) {
          const sub = await fetchSubtitle(cid, info.data, '');
          resp.hasSubtitle = !!(sub && sub.body && sub.body.length);
        }
      } catch (e) { }
      try { sendResponse(resp); } catch (e) { }
    })();
    return true; // 异步响应
  }
  if (msg.action === 'getQuickInfo') {
    // 弹窗打开时自动获取视频标题 + UP 主信息（无需跑任务）
    (async () => {
      try {
        const cookies = await getBiliCookies();
        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        const bvid = extractBVID(msg.bvid);
        if (!bvid) { sendResponse({ ok: false, error: '无效 BV 号' }); return; }
        const info = await fetchVideoInfo(bvid, cookieStr);
        const d = info.data || {};
        let up = null;
        const mid = d.owner && d.owner.mid;
        if (mid) { try { up = await fetchUpInfo(mid, cookieStr); } catch (e) { } }
        sendResponse({
          ok: true, bvid,
          title: d.title || '',
          upName: (d.owner || {}).name || '',
          duration: d.duration || 0,
          stat: d.stat || null,
          up,
        });
      } catch (e) {
        try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch (e2) { }
      }
    })();
    return true;
  }
  if (msg.action === 'getLiveInfo') {
    // 直播间信息（标题 / 主播 / 人气 / 开播状态）
    (async () => {
      try { sendResponse(await fetchLiveInfo(parseInt(msg.roomId, 10))); }
      catch (e) {
        try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch (e2) { }
      }
    })();
    return true;
  }
  if (msg.action === 'liveStart') {
    (async () => {
      try { await liveStart(parseInt(msg.roomId, 10)); sendResponse({ ok: true }); }
      catch (e) { try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch (e2) { } }
    })();
    return true;
  }
  if (msg.action === 'liveStop') {
    liveStop();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === 'liveStatus') {
    sendResponse({ connected: liveConnected, roomId: liveRoomId, count: liveLines.length });
    return true;
  }
  if (msg.action === 'liveExport') {
    sendResponse({ ok: true, lines: liveLines.slice() });
    return true;
  }
  if (msg.action === 'floatScrape') {
    const bvid = extractBVID(msg.bvid);
    if (!bvid) {
      sendResponse({ ok: false, error: '无效 BV 号' });
      return true;
    }
    (async () => {
      floatTabId = sender.tab ? sender.tab.id : null;
      if (running) {
        cancelled = true;
        abortAll();
        await sleep(300);
        cancelled = false;
      }
      const mode = msg.mode;
      let cfg = {};
      try {
        const s = await chrome.storage.local.get('settings');
        cfg = s.settings || {};
      } catch (e) { }
      await startTask(bvid, {
        danmaku: mode !== 'cm',
        comments: mode === 'cm',
        subtitle: mode !== 'cm',
        aiSummary: mode === 'ai',
        aiDanmaku: mode === 'ai',
        aiComments: mode === 'ai',
        wordCloud: false,
        upInfo: false,
        withReplies: false,
        maxPages: mode === 'cm' ? (cfg.defaultMaxPages || 3) : 0,
        maxComments: mode === 'cm' ? (cfg.commentMaxItems || 0) : 0,
        commentRateDelay: cfg.commentRateDelay || 400,
        subLan: cfg.defaultSubLan || 'ai-zh',
        saveFormat: cfg.defaultFormat || 'json',
        cookie: '',
        subtitleTimeFormat: cfg.subtitleTimeFormat || 'seconds',
        cloudTopN: cfg.cloudTopN || 30
      });
    })();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// 通知点击 → 打开下载目录
chrome.notifications.onClicked.addListener(() => {
  try { chrome.downloads.showDefaultFolder(); } catch (e) { }
});

// ============ Context Menu (right-click) ============
chrome.runtime.onInstalled.addListener(async () => {
  // 补齐完整默认设置（含全部默认勾选项）写入 local+sync，保留用户已有值；新增版本缺的键自动补默认
  try {
    for (const area of ['local', 'sync']) {
      try {
        const s = await chrome.storage[area].get('settings');
        const stored = s.settings || {};
        if (Object.keys(DEFAULTS).some(k => !(k in stored))) {
          await chrome.storage[area].set({ settings: { ...DEFAULTS, ...stored } });
        }
      } catch (e) { }
    }
  } catch (e) { }
  await applyPopupStyle();
  chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'scrape-bilibili-dm',
    title: '抓取此视频（弹幕+字幕）',
    contexts: ['link', 'page'],
    documentUrlPatterns: ['*://*.bilibili.com/*'],
    targetUrlPatterns: ['*://*.bilibili.com/video/*']
  });
  chrome.contextMenus.create({
    id: 'scrape-bilibili-cm',
    title: '抓取此视频的评论',
    contexts: ['link', 'page'],
    documentUrlPatterns: ['*://*.bilibili.com/*'],
    targetUrlPatterns: ['*://*.bilibili.com/video/*']
  });
  chrome.contextMenus.create({
    id: 'scrape-bilibili-ai',
    title: '🤖 AI 全分析（弹幕+字幕+总结）',
    contexts: ['link', 'page'],
    documentUrlPatterns: ['*://*.bilibili.com/*'],
    targetUrlPatterns: ['*://*.bilibili.com/video/*']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || info.pageUrl || tab?.url;
  if (!url) return;
  const bvid = extractBVID(url);
  if (!bvid) return;

  floatTabId = tab && tab.id ? tab.id : null;
  if (running) { // 已有任务 → 先取消旧的
    cancelled = true;
    abortAll();
    await sleep(300);
    cancelled = false;
  }

  let cfg = {};
  try {
    const s = await chrome.storage.local.get('settings');
    cfg = s.settings || {};
  } catch (e) { }
  if (!Object.keys(cfg).length) {
    try { const s = await chrome.storage.sync.get('settings'); cfg = s.settings || {}; } catch (e) { }
  }

  const isComments = info.menuItemId === 'scrape-bilibili-cm';
  const isAI = info.menuItemId === 'scrape-bilibili-ai';

  await startTask(bvid, {
    danmaku: !isComments,
    comments: isComments,
    subtitle: !isComments,
    aiSummary: isAI,
    aiDanmaku: isAI,
    aiComments: isAI,
    withReplies: !!cfg.defaultReplies,
    maxPages: isComments ? (cfg.defaultMaxPages || 3) : 0,
    maxComments: isComments ? (cfg.commentMaxItems || 0) : 0,
    commentRateDelay: cfg.commentRateDelay || 400,
    subLan: cfg.defaultSubLan || 'ai-zh',
    saveFormat: cfg.defaultFormat || 'json',
    cookie: '',
    subtitleTimeFormat: cfg.subtitleTimeFormat || 'seconds',
    cloudTopN: cfg.cloudTopN || 30
  });
});
