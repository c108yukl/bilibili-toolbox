/* ============================================================
   B站直播弹幕协议模块（background 与 live-test 诊断页共用，Node 可测）
   协议：wss://<host>/sub —— 16 字节帧头
   [包长 u32][头长 u16][协议版本 u16][操作码 u32][序号 u32]
   操作码：2=心跳 3=心跳回复 5=消息推送 7=认证 8=认证回复
   消息体 ver1=明文JSON ver2=zlib压缩（内部可嵌套多帧）
   ============================================================ */

export function livePack(op, body) {
  const data = new TextEncoder().encode(JSON.stringify(body ?? {}));
  const buf = new ArrayBuffer(16 + data.length);
  const dv = new DataView(buf);
  dv.setUint32(0, 16 + data.length);
  dv.setUint16(4, 16);
  dv.setUint16(6, 1);        // 控制帧用 ver1 明文
  dv.setUint32(8, op);
  dv.setUint32(12, 1);
  new Uint8Array(buf, 16).set(data);
  return buf;
}

export async function liveInflate(u8) {
  const ds = new DecompressionStream('deflate');   // zlib 流
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 解析一帧 MESSAGE：明文 JSON 直接处理，压缩则解压后切帧递归
async function parseData(u8, onFrame, onLog) {
  let text = null;
  try { text = new TextDecoder().decode(u8); JSON.parse(text); }
  catch (e) { text = null; }
  if (text !== null) { onFrame(JSON.parse(text)); return; }
  try {
    const raw = await liveInflate(u8);
    let off = 0;
    while (off + 16 <= raw.length) {
      const dv = new DataView(raw.buffer, raw.byteOffset + off);
      const len = dv.getUint32(0);
      if (off + len > raw.length) break;
      await parseData(raw.slice(off + 16, off + len), onFrame, onLog);
      off += len;
    }
  } catch (e) { onLog && onLog('解压失败: ' + (e && e.message)); }
}

function handleCmd(obj, onDanmaku) {
  if (!obj || !obj.cmd) return;
  if (obj.cmd === 'DANMU_MSG') {
    const info = obj.info || [];
    const line = {
      ts: Date.now(),
      user: (info[2] && info[2][1]) || '',
      text: info[1] || '',
    };
    if (line.text) onDanmaku(line);
  }
}

/**
 * 连接直播弹幕服务器
 * @param {object} opts
 *   wsUrl  wss 地址（getInfoByRoom host_list 或默认 broadcastlv）
 *   auth   认证体 {uid, roomid, protover, platform, type, key, buvid3?}
 *   onLog(msg)      逐步日志（诊断用）
 *   onDanmaku(line) 弹幕 {ts,user,text}
 *   onState(state, detail) 'open'|'authed'|'closed'|'error'
 * @returns {{ authed: Promise<void>, stop: () => void, ws: WebSocket }}
 */
export function liveConnect({ wsUrl, auth, onLog = () => { }, onDanmaku = () => { }, onState = () => { } }) {
  let ws;
  try { ws = new WebSocket(wsUrl); }
  catch (e) { onState('error', '无法创建连接: ' + e.message); throw e; }
  ws.binaryType = 'arraybuffer';

  let hbTimer = null;
  let authedResolve, authedReject;
  const authed = new Promise((res, rej) => { authedResolve = res; authedReject = rej; });
  const authTimer = setTimeout(() => {
    const err = new Error('认证超时（10s 未收到 AUTH_REPLY）');
    onState('error', err.message);
    authedReject(err);
    cleanup();
  }, 10000);

  function cleanup() {
    clearTimeout(authTimer);
    clearInterval(hbTimer);
    try { ws.onclose = null; ws.close(); } catch (e) { }
  }

  ws.onopen = () => {
    onLog('WS 已打开，发送认证包 (uid=' + (auth.uid || 0) + ', roomid=' + auth.roomid + ')');
    onState('open');
    ws.send(livePack(7, auth));
    hbTimer = setInterval(() => {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(livePack(2, '[object Object]')); }
      catch (e) { }
    }, 30000);
  };

  ws.onmessage = async (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    const dv = new DataView(ev.data);
    const op = dv.getUint32(8);
    const body = new Uint8Array(ev.data.slice(16));
    if (op === 8) {                 // AUTH_REPLY
      let code = '?';
      try { code = (JSON.parse(new TextDecoder().decode(body)) || {}).code; } catch (e) { }
      onLog('认证回复 code=' + code);
      if (code === 0) {
        clearTimeout(authTimer);
        onState('authed');
        authedResolve();
      } else {
        const err = new Error('认证失败 code=' + code);
        onState('error', err.message);
        authedReject(err);
        cleanup();
      }
    } else if (op === 3) {          // 心跳回复（人气值）
      let num = '';
      try {
        if (body.length === 4) num = String(new DataView(ev.data.slice(16)).getUint32(0));
      } catch (e) { }
      onLog && num && onLog('心跳回复，人气=' + num);
    } else if (op === 5) {          // MESSAGE
      await parseData(body, (obj) => handleCmd(obj, onDanmaku), onLog);
    }
  };

  ws.onclose = () => {
    onState('closed');
    clearInterval(hbTimer);
    try { authedReject(new Error('连接已关闭')); } catch (e) { }
  };
  ws.onerror = () => {
    onState('error', 'WebSocket 错误');
    try { authedReject(new Error('WebSocket 错误')); } catch (e) { }
  };

  return {
    authed,
    ws,
    stop: cleanup,
  };
}

/** 默认弹幕服务器地址 */
export const LIVE_DEFAULT_WS = 'wss://broadcastlv.chat.bilibili.com/sub';
