/* 诊断主逻辑：被 boot 动态加载 */
import { liveConnect, LIVE_DEFAULT_WS } from './live-proto.js';
import { getBiliCookies } from './utils.js';

let conn = null;
let stopTimer = null;

export function stop() {
  clearTimeout(stopTimer);
  if (conn) { try { conn.stop(); } catch (e) { } conn = null; }
}

export async function run(roomId, { log, setBusy }) {
  stop();
  let dmCount = 0;
  if (!roomId) { log('直播间号无效', 'err'); return; }
  setBusy(true);
  try {
    log(`① 读取浏览器 Cookie ...`);
    const cookies = await getBiliCookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const names = cookies.map(c => c.name);
    log(`   共 ${cookies.length} 项；SESSDATA=${names.includes('SESSDATA') ? '有' : '无(匿名)'}；buvid3=${names.includes('buvid3') ? '有' : '无'}`, names.includes('buvid3') ? 'ok' : 'warn');
    const uid = parseInt((cookies.find(c => c.name === 'DedeUserID') || {}).value || '0', 10) || 0;
    const buvid = (cookies.find(c => c.name === 'buvid3') || {}).value || '';

    log(`② 获取弹幕服务器信息（index/getDanmuInfo, room=${roomId}）...`);
    let token = '', wsUrl = LIVE_DEFAULT_WS;
    try {
      const resp = await fetch(
        `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${roomId}&type=0&buvid3=${encodeURIComponent(buvid)}`,
        { credentials: 'include', headers: { Cookie: cookieStr } }
      );
      const j = await resp.json();
      if (j.code !== 0) throw new Error(`code=${j.code} ${j.message || ''}`);
      token = (j.data || {}).token || '';
      const host = ((j.data || {}).host_list || [])[0] || {};
      if (host.host) wsUrl = `wss://${host.host}:${host.wss_port || 443}/sub`;
      log(`   ✓ token 长度 ${token.length}，服务器 ${host.host || '(默认)'}:${host.wss_port || 443}`, 'ok');
    } catch (e) {
      log(`   ✗ 失败：${e.message}`, 'err');
    }
    if (!token) log(`   ⚠ 无 token 将无法通过认证（B站已封禁匿名连接），仍尝试...`, 'warn');

    log(`③ 连接 ${wsUrl} ...`);
    conn = liveConnect({
      wsUrl,
      auth: { uid, roomid: roomId, protover: 2, platform: 'web', type: 2, key: token, buvid3: buvid },
      onLog: (m) => log('   ' + m, 'dim'),
      onDanmaku: (l) => { dmCount++; if (dmCount <= 20 || dmCount % 10 === 0) log(`💬 [${dmCount}] ${l.user}: ${l.text}`, 'dm'); },
      onState: (s, d) => {
        if (s === 'authed') log(`④ 认证成功 🎉 开始接收弹幕（监听 60 秒）`, 'ok');
        else if (s === 'closed') log(`连接关闭 ${d || ''}`, 'warn');
        else if (s === 'error') log(`连接错误：${d || ''}`, 'err');
      },
    });
    try {
      await conn.authed;
      stopTimer = setTimeout(() => finish(), 60000);
    } catch (e) {
      log(`④ 认证失败：${e.message}`, 'err');
      log(`排查：token 为 0 → Cookie/-352 问题；33ms 内被掐 → 无效 token；超时 → 服务器未回应`, 'warn');
      finish();
    }
  } catch (e) {
    log('意外错误: ' + (e && e.stack || e), 'err');
    finish();
  }

  function finish() {
    stop();
    log(`—— 诊断结束：共收到 ${dmCount} 条弹幕 ${dmCount > 0 ? '✅ 链路完全正常' : '❌ 未收到弹幕'} ——`, dmCount > 0 ? 'ok' : 'err');
    setBusy(false);
  }
}
