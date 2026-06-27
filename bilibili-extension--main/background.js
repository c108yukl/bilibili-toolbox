importScripts('utils.js');

// ============ State ============
let currentPort = null;
let cancelled = false;

// ============ Helper: send message / headless download ============
async function downloadFile(filename, content, mimeType) {
  try {
    const dataUrl = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
    await chrome.downloads.download({ url: dataUrl, filename, conflictAction: 'overwrite' });
  } catch (e) {
    console.error('[下载] 失败:', filename, e.message);
  }
}

function send(type, data) {
  if (currentPort) {
    try { currentPort.postMessage({ type, ...data }); } catch (e) { }
  } else if (type === 'file') {
    downloadFile(data.filename, data.content, data.mimeType);
  }
}

function progress(msg) { send('progress', { message: msg }); }
function info(msg) { send('info', { message: msg }); }
function success(msg) { send('success', { message: msg }); }
function error(msg) { send('error', { message: msg }); }
function done(msg) {
  if (currentPort) send('done', { message: msg });
  // headless: no notification needed, downloads speak for themselves
}

// Developer logging (toggled by settings)
let devMode = false;
function devLog(...args) { if (devMode) console.log('[dev]', ...args); }

// ============ Fetch wrapper ============
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
  const resp = await fetch(url, { headers, ...options.fetchOpts });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  return resp;
}

async function biliFetchJSON(url, options = {}) {
  const resp = await biliFetch(url, options);
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`API错误(${data.code}): ${data.message || '未知'}`);
  return data.data;
}

// ============ Video Info ============
async function fetchVideoInfo(bvid, cookie) {
  progress(`[视频] 正在获取视频信息...`);
  const data = await biliFetchJSON(
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    { cookie }
  );
  const title = data.title || '';
  const aid = data.aid;
  const cid = data.cid || (data.pages?.[0]?.cid);
  progress(`[视频] ${title} (aid=${aid}, cid=${cid})`);
  return { title, aid, cid, data };
}

// ============ Danmaku ============
async function fetchDanmaku(cid, cookie) {
  progress(`[弹幕] 正在获取 (cid=${cid})...`);
  const resp = await biliFetch(
    `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`,
    { cookie }
  );
  const xmlText = await resp.text();
  const dms = parseDanmakuXML(xmlText);
  progress(`[弹幕] 共 ${dms.length} 条`);
  for (const dm of dms.slice(0, 10)) {
    progress(`   [${dm.dm_time.toFixed(1)}s] ${dm.text}`);
  }
  return dms;
}

// ============ Comments ============
function buildQueryString(params) {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

// Cursor-based API (x/v2/comment/main) - newer, may require auth/signing
async function fetchCommentPageCursor(aid, cursor, cookie) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const params = { type: 1, oid: aid, mode: 3 };
    if (cursor) params.next = cursor;
    let url = `https://api.bilibili.com/x/v2/comment/main?${buildQueryString(params)}`;
    if (attempt === 1) {
      const keys = await getWbiKeys();
      const mixKey = getMixKey(keys.img, keys.sub);
      Object.assign(params, encryptWbi(params, mixKey));
      url = `https://api.bilibili.com/x/v2/comment/main?${buildQueryString(params)}`;
    }
    try {
      return await biliFetchJSON(url, { cookie });
    } catch (e) {
      if (attempt === 0) progress(`  [评论] 主流API受限，尝试WBI签名...`);
      else throw e;
    }
  }
}

// Page-based API (x/v2/comment) - older but more permissive
async function fetchCommentPageByPage(aid, pageNum, cookie) {
  const keys = await getWbiKeys();
  const mixKey = getMixKey(keys.img, keys.sub);
  const params = { type: 1, oid: aid, pn: pageNum, sort: 2 };
  const signed = encryptWbi(params, mixKey);
  const url = `https://api.bilibili.com/x/v2/comment?${buildQueryString(signed)}`;
  const data = await biliFetchJSON(url, { cookie });
  return {
    replies: data.replies || [],
    cursor: {
      next: pageNum + 1,
      all_count: data.page?.acount || data.page?.count || 0,
      is_end: !data.replies || data.replies.length === 0
    }
  };
}

async function fetchReplies(aid, rpid, cookie) {
  try {
    return await biliFetchJSON(
      `https://api.bilibili.com/x/v2/comment/reply?type=1&oid=${aid}&root=${rpid}&ps=20`,
      { cookie }
    );
  } catch (e) {
    return { replies: [] };
  }
}

// ============ Subtitle ============
// Player API: the only endpoint that returns valid subtitle_url
async function fetchPlayerSubtitle(aid, cid, cookie) {
  try {
    const keys = await getWbiKeys();
    const mixKey = getMixKey(keys.img, keys.sub);
    const params = { aid, cid, isGaiaAvoided: false, web_location: 1315873 };
    const signed = encryptWbi(params, mixKey);
    const url = `https://api.bilibili.com/x/player/wbi/v2?${buildQueryString(signed)}`;
    devLog('[字幕] Player API URL:', url);
    const data = await biliFetchJSON(url, { cookie });
    devLog('[字幕] Player API响应:', JSON.stringify(data.subtitle).slice(0, 200));
    return data.subtitle?.subtitles || [];
  } catch (e) {
    devLog('[字幕] Player API失败:', e.message);
    return [];
  }
}

async function fetchSubtitle(cid, videoData, cookie) {
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
    } catch (e) {}
  }

  if (!subs || subs.length === 0) return [];
  return await downloadSubtitle(subs, cookie);
}

async function downloadSubtitle(subtitles, cookie) {
  // Build candidate list: prefer ai-zh > zh-Hans > zh-Hant, then everything else
  const prefer = ['ai-zh', 'zh-Hans', 'zh-Hant'];
  const candidates = [];
  const seen = new Set();
  for (const p of prefer) {
    const s = subtitles.find(x => x.lan === p);
    if (s && !seen.has(s.lan)) { candidates.push(s); seen.add(s.lan); }
  }
  for (const s of subtitles) {
    if (!seen.has(s.lan)) { candidates.push(s); seen.add(s.lan); }
  }

  for (const picked of candidates) {
    if (!picked.subtitle_url) {
      devLog(`[字幕] 跳过 ${picked.lan_doc||picked.lan} (URL为空)`);
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
        progress(`[字幕] 成功获取: ${picked.lan_doc||picked.lan} (${body.length}条)`);
        return body;
      }
      devLog(`[字幕] ${picked.lan_doc||picked.lan} 内容为空，尝试下一个`);
    } catch (e) {
      progress(`  [字幕] ${picked.lan_doc||picked.lan} 下载失败，尝试下一个...`);
    }
  }
  error('❌ 该视频没有可下载的字幕文件');
  return [];
}

// ============ Task: Danmaku ============
async function handleDanmaku(bvid, aid, cid, params) {
  const fmt = params.saveFormat;
  const dms = await fetchDanmaku(cid, params.cookie);
  if (cancelled) return;

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
}

// ============ Task: Comments ============
async function handleComments(bvid, aid, params) {
  const fmt = params.saveFormat;
  const maxPages = params.maxPages || 0;
  const withReplies = params.withReplies;
  const MAX_ITEMS = 10000;
  const EMPTY_BREAK = 2;

  let allItems = [];
  let cursor = undefined;
  let emptyStreak = 0;
  let page = 1;
  let knownTotal = 0;
  let usingPageApi = false; // once we fallback to page-based, stick with it

  while (true) {
    if (cancelled) return;
    if (maxPages > 0 && page > maxPages) { progress(`  已达目标页数 ${maxPages}，停止`); break; }
    if (allItems.length > MAX_ITEMS) { progress(`  达到安全上限 ${MAX_ITEMS}，停止`); break; }

    let data;
    if (usingPageApi) {
      data = await fetchCommentPageByPage(aid, cursor || page, params.cookie);
    } else {
      try {
        data = await fetchCommentPageCursor(aid, cursor, params.cookie);
      } catch (e) {
        progress(`  [评论] 主流API被风控，切换备用接口...`);
        data = await fetchCommentPageByPage(aid, cursor || 1, params.cookie);
        usingPageApi = true;
        cursor = page; // reset cursor to page number
      }
    }
    if (cancelled) return;

    const replies = data.replies || [];
    const cursorData = data.cursor || {};
    knownTotal = cursorData.all_count || knownTotal;

    if (!replies || replies.length === 0) {
      emptyStreak++;
      if (emptyStreak >= EMPTY_BREAK) { progress(`  连续${emptyStreak}页无数据，停止`); break; }
    } else {
      emptyStreak = 0;
      let replyCount = 0;
      for (const c of replies) {
        if (cancelled) return;
        let subReplies = [];
        if (withReplies && (c.rcount || 0) > 0) {
          const subData = await fetchReplies(aid, c.rpid, params.cookie);
          subReplies = subData.replies || [];
          await sleep(300);
        }
        allItems.push({ comment: c, replies: subReplies });
        replyCount += subReplies.length;
      }
      progress(`  第${page}页 +${replies.length} 评论 / +${replyCount} 回复 (累计 ${allItems.length} / ${knownTotal || '?'})`);
    }

    if (cursorData.is_end) { progress(`  已到最后一页`); break; }
    if (knownTotal && allItems.length >= knownTotal) { progress(`  已获取全部 ${knownTotal} 条`); break; }

    cursor = cursorData.next;
    if (!cursor) break;
    page++;

    if (usingPageApi) cursor = page; // for page API, cursor IS the next page number

    await sleep(500);
  }

  if (cancelled) return;

  const totalR = allItems.reduce((s, i) => s + (i.replies?.length || 0), 0);
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

  send('file', { task: 'comments', filename: `${filenameBase}.${fmt}`, content, mimeType });
  success(`✅ 评论完成: ${allItems.length} 评论, ${totalR} 回复`);
}

// ============ Task: Subtitle ============
async function handleSubtitle(bvid, aid, cid, videoData, params) {
  const fmt = params.saveFormat;
  const lanCode = params.subLan;

  const subs = await fetchSubtitle(cid, videoData, params.cookie);
  if (!subs || subs.length === 0) {
    error('❌ 该视频没有字幕');
    return;
  }
  if (cancelled) return;

  progress(`[字幕] 共 ${subs.length} 条字幕片段`);
  const filenameBase = `subtitle_${bvid}_${lanCode}`;
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
}

// Load user settings from storage
async function loadSettings() {
  try {
    const s = await chrome.storage.sync.get('settings');
    const cfg = s.settings || {};
    devMode = !!cfg.devMode;
  } catch (e) {}
}

// ============ Main Task Orchestrator ============
async function startTask(bvid, params) {
  cancelled = false;
  await loadSettings();

  try {
    // 1. Get video info (needed for all tasks)
    const videoInfo = await fetchVideoInfo(bvid, params.cookie);
    if (cancelled) return;
    const { aid, cid } = videoInfo;

    // 2. Danmaku
    if (params.danmaku && !cancelled) {
      try {
        await handleDanmaku(bvid, aid, cid, params);
      } catch (e) {
        error(`❌ 弹幕出错: ${e.message}`);
      }
    }

    // 3. Subtitle
    if (params.subtitle && !cancelled) {
      try {
        await handleSubtitle(bvid, aid, cid, videoInfo.data, params);
      } catch (e) {
        error(`❌ 字幕出错: ${e.message}`);
      }
    }

    // 4. Comments
    if (params.comments && !cancelled) {
      progress(`[评论] 开始获取...`);
      try {
        await handleComments(bvid, aid, params);
      } catch (e) {
        error(`❌ 评论出错: ${e.message}`);
      }
    }

    if (!cancelled) done('全部爬取完成！');
  } catch (e) {
    if (e.message === 'CANCELLED') {
      error('⛔ 已取消');
    } else {
      error(`❌ 出错: ${e.message}`);
      console.error(e);
    }
  }
}

// ============ Sleep ============
function sleep(ms) {
  if (cancelled) return Promise.reject(new Error('CANCELLED'));
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (cancelled) resolve(); // resolve silently and let loop check cancelled
      else resolve();
    }, ms);
    // Allow cancellation
    const checkCancel = setInterval(() => {
      if (cancelled) {
        clearTimeout(timer);
        clearInterval(checkCancel);
        resolve();
      }
    }, 100);
  });
}

// ============ Message Handler ============
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'scraper') return;

  currentPort = port;
  cancelled = true; // cancel any previous task

  port.onMessage.addListener((msg) => {
    if (msg.action === 'start') {
      cancelled = false;
      startTask(msg.bvid, msg.params);
    } else if (msg.action === 'cancel') {
      cancelled = true;
      try { port.postMessage({ type: 'abort', message: '已取消' }); } catch (e) {}
    }
  });

  port.onDisconnect.addListener(() => {
    cancelled = true;
    currentPort = null;
  });
});

// ============ Context Menu (right-click) ============
chrome.runtime.onInstalled.addListener(() => {
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
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || info.pageUrl || tab?.url;
  if (!url) return;
  const bvid = extractBVID(url);
  if (!bvid) return;

  cancelled = true;
  currentPort = null; // enter headless mode
  await new Promise(r => setTimeout(r, 100));

  let cfg = {};
  try { const s = await chrome.storage.sync.get('settings'); cfg = s.settings || {}; } catch (e) {}

  const isComments = info.menuItemId === 'scrape-bilibili-cm';

  cancelled = false;
  await startTask(bvid, {
    danmaku: !isComments,
    comments: isComments,
    subtitle: !isComments,
    withReplies: !!cfg.defaultReplies,
    maxPages: isComments ? (cfg.defaultMaxPages || 3) : 0,
    subLan: 'ai-zh',
    saveFormat: cfg.defaultFormat || 'json',
    cookie: '',
    subtitleTimeFormat: cfg.subtitleTimeFormat || 'seconds'
  });
  // Don't restore currentPort — onConnect handles future popups automatically
});
