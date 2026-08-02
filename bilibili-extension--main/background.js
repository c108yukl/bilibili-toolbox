importScripts('utils.js');

// 启动时校准服务器时间（用于 WBI wts）
syncServerTime();

// ============ State ============
let activePort = null;   // 当前连接的前端端口（popup），可为 null（headless）
let running = false;     // 是否有任务在执行
let cancelled = false;   // 取消标记
let currentAbort = null; // 当前请求的 AbortController（普通 API 请求）
const aiAborts = new Set(); // 所有在途 AI 流式请求的 AbortController（支持并发，统一取消）

// 注册/注销一个 AI 请求控制器；取消任务时全部 abort
function makeAiAbort() { const c = new AbortController(); aiAborts.add(c); return c; }
function releaseAiAbort(c) { aiAborts.delete(c); }
function abortAllAi() { for (const c of aiAborts) c.abort(); }

// ============ Settings ============
let devMode = false;
function devLog(...args) { if (devMode) console.log('[dev]', ...args); }

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
  send('progress', { message: msg, percent });
}
function info(msg) { send('info', { message: msg }); }
function success(msg) { send('success', { message: msg }); }
function error(msg) { send('error', { message: msg }); }

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

  const controller = new AbortController();
  currentAbort = controller;
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
    if (currentAbort === controller) currentAbort = null;
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
// 弹幕抓取：有登录 Cookie 时优先走分段接口 seg.so（protobuf，弹幕远多于 list.so；
// 部分高密度视频 list.so 只返回少量抽样），再与 list.so 对比取更多的一份；无 Cookie 直接用 list.so
async function fetchDanmaku(cid, cookie, duration) {
  progress(`[弹幕] 正在获取 (cid=${cid})...`);
  let dms = [];
  if (cookie) {
    const segCount = duration ? Math.max(1, Math.ceil(duration / 360)) : 1;
    for (let i = 1; i <= segCount && !cancelled; i++) {
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
  const listResp = await biliFetch(
    `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`,
    { cookie }
  );
  const listDms = parseDanmakuXML(await listResp.text());
  if (listDms.length > dms.length) dms = listDms;
  dms.sort((a, b) => a.dm_time - b.dm_time);
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
    } catch (e) { }
  }

  if (!subs || subs.length === 0) return null;
  return await downloadSubtitle(subs, cookie);
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

async function downloadSubtitle(subtitles, cookie, lanCode) {
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
  error('❌ 该视频没有可下载的字幕文件');
  return null;
}

// ============ Task: Danmaku ============
// 抓取弹幕 + 生成文件 + 热词统计；AI 分析由 processOneVideo 末尾并发执行
// 返回弹幕数组（供 AI 分析使用），取消/失败返回 null
async function handleDanmaku(bvid, cid, params, duration) {
  const fmt = params.saveFormat;
  const dms = await fetchDanmaku(cid, params.cookie, duration);
  if (cancelled) return null;

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
async function handleComments(bvid, aid, params) {
  const fmt = params.saveFormat;
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

  while (true) {
    if (cancelled) return null;
    if (maxPages > 0 && page > maxPages) { progress(`  已达目标页数 ${maxPages}，停止`); break; }
    if (maxComments > 0 && allItems.length >= maxComments) { progress(`  已达目标条数 ${maxComments}，停止`); break; }
    if (allItems.length > MAX_ITEMS) { progress(`  达到安全上限 ${MAX_ITEMS}，停止`); break; }

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
        if (cancelled) return null;
        let subReplies = [];
        if (withReplies && (c.rcount || 0) > 0) {
          subReplies = await fetchReplies(aid, c.rpid, c.rcount, params.cookie);
          await sleep(150);
        }
        allItems.push({ comment: c, replies: subReplies });
        replyCount += subReplies.length;
        // 滑动窗口：逐条累计，达到目标条数立即停止本页
        if (maxComments > 0 && allItems.length >= maxComments) break;
      }
      progress(`  第${page}页 +${replies.length} 评论 / +${replyCount} 回复 (累计 ${allItems.length} / ${knownTotal || '?'})`);
    }

    if (cursorData.is_end) { progress(`  已到最后一页`); break; }
    if (knownTotal && allItems.length >= knownTotal) { progress(`  已获取全部 ${knownTotal} 条`); break; }
    if (maxComments > 0 && allItems.length >= maxComments) { progress(`  已达目标条数 ${maxComments}，停止`); break; }

    if (usingPageApi) {
      cursor = page + 1;
    } else {
      cursor = cursorData.next;
      if (!cursor) break;
    }
    page++;
    await sleep(rateDelay);
  }

  if (cancelled) return null;

  // 滑动窗口截断：只保留前 maxComments 条（超出的页数据丢弃）
  if (maxComments > 0 && allItems.length > maxComments) {
    allItems.length = maxComments;
  }

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
  return allItems;
}

// ============ AI 分析（弹幕 / 字幕 / 评论，可并发） ============
// 三个函数各自独立，供 processOneVideo 以 Promise.all 并发执行；
// 均支持：流式输出（含思考过程 reasoning）、MD + 结构化 JSON 保存、取消

// AI 弹幕分析：去重后交给 AI 分析情绪/话题/名场面/有趣精选
// 支持时间窗口（aiDmStart/aiDmEnd，如 "2:30"~"10:00"）：只分析视频某一段的弹幕
async function runAiDanmakuAnalysis(bvid, dms, params) {
  if (cancelled) return;
  try {
    const aiCfg = await getStoredSettings();
    const winDms = filterByWindow(dms, d => d.dm_time, aiCfg.aiDmStart, aiCfg.aiDmEnd);
    const text = buildDanmakuText(winDms, aiCfg.aiDanmakuMaxItems || 500);
    if (!text) { progress('🤖 [AI弹幕] 无弹幕可分析'); return; }
    const range = (parseTimeWindow(aiCfg.aiDmStart) != null || parseTimeWindow(aiCfg.aiDmEnd) != null)
      ? `（时间窗 ${aiCfg.aiDmStart || '0:00'} ~ ${aiCfg.aiDmEnd || '结尾'}，${winDms.length}/${dms.length} 条）` : '';
    progress(`🤖 AI 正在分析弹幕（流式输出）...${range}`);
    const prompt = aiCfg.aiDanmakuPrompt || AI_DEFAULTS.aiDanmakuPrompt;
    const controller = makeAiAbort();
    try {
      const { content: analysis, reasoning } = await callAi(text, prompt, aiCfg, controller,
        (full, thinking) => send('ai-dm', { bvid, partial: full, done: false, thinking }));
      if (cancelled || !analysis) return;
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
async function runAiSubtitleSummary(bvid, subs, lan, videoData, params) {
  if (cancelled) return;
  try {
    const aiCfg = await getStoredSettings();
    const winSubs = filterByWindow(subs, s => s.from, aiCfg.aiSubStart, aiCfg.aiSubEnd);
    const range = (parseTimeWindow(aiCfg.aiSubStart) != null || parseTimeWindow(aiCfg.aiSubEnd) != null)
      ? `（时间窗 ${aiCfg.aiSubStart || '0:00'} ~ ${aiCfg.aiSubEnd || '结尾'}，${winSubs.length}/${subs.length} 条）` : '';
    progress(`🤖 AI 正在总结字幕（流式输出）...${range}`);
    const text = buildAIText(winSubs, aiCfg);
    const prompt = aiCfg.aiPrompt || AI_DEFAULTS.aiPrompt;
    const controller = makeAiAbort();
    try {
      const { content: summary, reasoning } = await callAi(text, prompt, aiCfg, controller,
        (full, thinking) => send('summary', { bvid, lan, partial: full, done: false, thinking }));
      if (cancelled || !summary) return;
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
async function runAiCommentsAnalysis(bvid, items, params) {
  if (cancelled) return;
  try {
    const aiCfg = await getStoredSettings();
    const text = buildCommentText(items, aiCfg.aiCommentMaxItems || 300);
    if (!text) { progress('🤖 [AI评论] 无评论可分析'); return; }
    progress(`🤖 AI 正在分析评论（${items.length} 条，流式输出）...`);
    const prompt = aiCfg.aiCommentPrompt || AI_DEFAULTS.aiCommentPrompt;
    const controller = makeAiAbort();
    try {
      const { content: analysis, reasoning } = await callAi(text, prompt, aiCfg, controller,
        (full, thinking) => send('ai-cm', { bvid, partial: full, done: false, thinking }));
      if (cancelled || !analysis) return;
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
async function handleSubtitle(bvid, cid, videoData, params) {
  const fmt = params.saveFormat;
  const lanCode = params.subLan;

  const result = await fetchSubtitle(cid, videoData, params.cookie);
  if (!result) {
    error('❌ 该视频没有字幕');
    return null;
  }
  const { body: subs, lan } = result;
  if (cancelled) return null;

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
      const percent = Math.round((i / total) * 100);
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
  } catch (e) {
    if (e.message === 'CANCELLED' || cancelled) {
      error('⛔ 已取消');
      notify('⛔ 任务已取消', total > 1 ? `已处理 ${bvidList.join(',')}` : bvid);
    } else {
      error(`❌ 出错: ${e.message}`);
      notify('❌ 爬取失败', `${bvid}: ${e.message}`);
      console.error(e);
    }
  } finally {
    running = false;
    cancelled = false;
  }
}

async function processOneVideo(bvid, params, index, total) {
  // 1. Get video info (needed for all tasks)
  const videoInfo = await fetchVideoInfo(bvid, params.cookie);
  if (cancelled) return;
  const { aid, cid } = videoInfo;
  const owner = videoInfo.data.owner || {};

  // 2. UP 主信息
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
    try { danmakuData = await handleDanmaku(bvid, cid, params, videoInfo.data.duration); }
    catch (e) { if (e.message !== 'CANCELLED') error(`❌ 弹幕出错: ${e.message}`); }
  }
  if (params.aiDanmaku && danmakuData) aiTasks.push(runAiDanmakuAnalysis(bvid, danmakuData, params));

  // 4. Subtitle（抓完立即启动 AI 字幕总结，与评论爬取并行）
  let subtitleData = null;
  if (params.subtitle && !cancelled) {
    try { subtitleData = await handleSubtitle(bvid, cid, videoInfo.data, params); }
    catch (e) { if (e.message !== 'CANCELLED') error(`❌ 字幕出错: ${e.message}`); }
  }
  if (params.aiSummary && subtitleData) aiTasks.push(runAiSubtitleSummary(bvid, subtitleData.body, subtitleData.lan, videoInfo, params));

  // 5. Comments（滑动窗口 + 速率控制；期间上面的弹幕/字幕 AI 分析已在后台运行）
  let commentsData = null;
  if (params.comments && !cancelled) {
    progress(`[评论] 开始获取...`);
    try { commentsData = await handleComments(bvid, aid, params); }
    catch (e) { if (e.message !== 'CANCELLED') error(`❌ 评论出错: ${e.message}`); }
  }
  if (params.aiComments && commentsData) aiTasks.push(runAiCommentsAnalysis(bvid, commentsData, params));

  // 6. AI 分析统一等待完成（弹幕/字幕任务早已启动，评论任务最后加入；全程可取消）
  if (cancelled) return;
  if (aiTasks.length > 0) {
    progress(`🤖 AI 分析启动（${aiTasks.length} 个任务并发，弹幕/字幕无需等待评论）...`);
    await Promise.all(aiTasks);
  }
}

// ============ Message Handler ============
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'scraper') return;

  activePort = port;

  port.onMessage.addListener(async (msg) => {
    if (msg.action === 'start') {
      if (running) { // 已有任务 → 先取消旧的
        cancelled = true;
        if (currentAbort) currentAbort.abort();
        abortAllAi();
        await sleep(300);
        cancelled = false;
      }
      startTask(msg.bvid, msg.params);
    } else if (msg.action === 'cancel') {
      cancelled = true;
      if (currentAbort) currentAbort.abort();
      abortAllAi();
      try { port.postMessage({ type: 'abort', message: '已取消' }); } catch (e) { }
    } else if (msg.action === 'status') {
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
  if (msg.action === 'floatScrape') {
    const bvid = extractBVID(msg.bvid);
    if (!bvid) {
      sendResponse({ ok: false, error: '无效 BV 号' });
      return true;
    }
    (async () => {
      if (running) {
        cancelled = true;
        if (currentAbort) currentAbort.abort();
        abortAllAi();
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

  if (running) { // 已有任务 → 先取消旧的
    cancelled = true;
    if (currentAbort) currentAbort.abort();
    abortAllAi();
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
