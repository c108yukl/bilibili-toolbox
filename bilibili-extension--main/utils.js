// ============ MD5 (public domain) ============
const md5 = (function() {
  function md5cycle(x, k) {
    let a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17,  606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12,  1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7,  1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7,  1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22,  1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14,  643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9,  38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5,  568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20,  1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14,  1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16,  1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11,  1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4,  681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23,  76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16,  530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10,  1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6,  1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6,  1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21,  1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15,  718787259);
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

async function getWbiKeys() {
  if (wbiKeysCache && Date.now() - wbiKeysCache.time < 3600000) return wbiKeysCache;
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
  wbiKeysCache = { img, sub, time: Date.now() };
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
  const wts = Math.floor(Date.now() / 1000);
  const all = { ...params, wts };
  const keys = Object.keys(all).sort();
  const str = keys.map(k => `${k}=${all[k]}`).join('&') + mixKey;
  const w_rid = md5(str);
  return { ...all, w_rid };
}

// ============ BV ID Extraction ============
function extractBVID(raw) {
  raw = raw.trim().replace(/\/+$/, '');
  const m = raw.match(/BV[a-zA-Z0-9]+/);
  return m ? m[0] : null;
}

// ============ Time Formatting ============
function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSRTTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  const pad = (n, z) => String(n).padStart(z, '0');
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)},${pad(ms,3)}`;
}

function fmtLRCTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2,'0')}:${s}`;
}

function fmtASSTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2,'0')}:${s}`;
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

function genSRT(subtitles) {
  return subtitles.map((s, i) => {
    return `${i + 1}\n${fmtSRTTime(s.from)} --> ${fmtSRTTime(s.to)}\n${s.content}\n`;
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
    `Dialogue: 0,${fmtASSTime(s.from)},${fmtASSTime(s.to)},Default,,0,0,0,,${s.content}`
  ).join('\n');
  return header + events;
}

function genLRC(subtitles) {
  return subtitles.map(s => `[${fmtLRCTime(s.from)}]${s.content}`).join('\n');
}

// ============ Subtitle Time Format ============
function fmtFullTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  const pad = (n, z) => String(n).padStart(z, '0');
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)}.${pad(ms,3)}`;
}

// ============ Danmaku Formatter for Comments ============
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
