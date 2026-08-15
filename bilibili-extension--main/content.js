// ============ B站悬浮球 (content script) ============
(() => {
  'use strict';

  const BV_RE = /BV[a-zA-Z0-9]{10}/;

  function getBvid() {
    const m = location.href.match(BV_RE);
    return m ? m[0] : null;
  }

  // ---- 主题色（与设置页一致）----
  const THEMES = {
    aurora: ['#00c8ff', '#7c5cff'],
    ocean: ['#38bdf8', '#2563eb'],
    forest: ['#4ade80', '#0d9488'],
    candy: ['#f472b6', '#a855f7'],
    sunset: ['#fb923c', '#ef4444']
  };

  let accent1 = THEMES.aurora[0];
  let accent2 = THEMES.aurora[1];
  let enabled = true;
  let ballMsgEnabled = true; // 悬浮球入场提示开关
  let ballMsgCustom = '';    // 自定义提示文本（每行一条）
  let ball = null;
  let menu = null;
  let toast = null;
  let bubble = null;
  let bubbleTimer = null;

  async function loadPrefs() {
    try {
      const s = await chrome.storage.local.get('settings');
      const cfg = s.settings || {};
      enabled = cfg.showFloatingBall !== false;
      ballMsgEnabled = cfg.ballMsgEnabled !== false;
      ballMsgCustom = cfg.ballMsgCustom || '';
      const t = THEMES[cfg.theme] || THEMES.aurora;
      accent1 = t[0];
      accent2 = t[1];
    } catch (e) { }
  }

  // ---- 动效样式（关键帧 + 提示气泡）----
  function injectStyles() {
    if (document.getElementById('__bili_float_style')) return;
    const st = document.createElement('style');
    st.id = '__bili_float_style';
    st.textContent = `
      @keyframes __bili_ball_pop { 0%{transform:scale(1)} 30%{transform:scale(1.28) rotate(-6deg)} 60%{transform:scale(.9)} 100%{transform:scale(1)} }
      @keyframes __bili_ball_glow { 0%,100%{box-shadow:0 6px 20px rgba(0,0,0,.45),0 0 0 0 var(--bili-glow,rgba(0,200,255,.55))} 50%{box-shadow:0 6px 20px rgba(0,0,0,.45),0 0 0 16px transparent} }
      @keyframes __bili_bubble_in { from{opacity:0;transform:translateX(10px) scale(.92)} to{opacity:1;transform:none} }
      .__bili_celebrate { animation: __bili_ball_pop .55s ease 2, __bili_ball_glow .9s ease 2; }
      .__bili_bubble {
        position: fixed; z-index: 2147483646; pointer-events: none;
        background: #141a2e; color: #e6e9f5; border: 1px solid var(--bili-accent,#00c8ff);
        border-radius: 10px; padding: 8px 14px; font-size: 12px; max-width: 320px;
        font-family: 'Segoe UI', system-ui, sans-serif; line-height: 1.6;
        box-shadow: 0 6px 24px rgba(0,0,0,.5); white-space: pre-line; word-break: break-word;
        opacity: 0; visibility: hidden; transition: opacity .3s, visibility .3s;
      }
      .__bili_bubble.show { opacity: 1; visibility: visible; animation: __bili_bubble_in .28s ease; }
      .__bili_bubble::after {
        content: ''; position: absolute; right: -6px; top: 50%; transform: translateY(-50%) rotate(45deg);
        width: 10px; height: 10px; background: #141a2e; border-right: 1px solid var(--bili-accent,#00c8ff);
        border-top: 1px solid var(--bili-accent,#00c8ff); border-radius: 2px;
      }
      .__bili_bubble.flip::after {
        right: auto; left: -6px; border-right: none; border-top: none;
        border-left: 1px solid var(--bili-accent,#00c8ff); border-bottom: 1px solid var(--bili-accent,#00c8ff);
      }`;
    document.head.appendChild(st);
  }

  // ---- Toast ----
  function showToast(text, color) {
    if (toast) toast.remove();
    toast = document.createElement('div');
    toast.textContent = text;
    toast.style.cssText = `
      position: fixed; right: 20px; bottom: 190px; z-index: 2147483646;
      background: #141a2e; color: #e6e9f5; border: 1px solid ${accent1};
      border-radius: 10px; padding: 8px 14px; font-size: 12px; font-family: 'Segoe UI', system-ui, sans-serif;
      box-shadow: 0 6px 24px rgba(0,0,0,.5); max-width: 280px; word-break: break-all;
      transition: opacity .4s; opacity: 1;`;
    if (color) toast.style.borderColor = color;
    document.body.appendChild(toast);
    setTimeout(() => { if (toast) { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 450); } }, 3500);
  }

  // ---- 悬浮球提示气泡（一次性展示，不轮播）----
  function showBubble(text) {
    if (!ball) return; // 悬浮球已被移除/未创建时不展示
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = '__bili_bubble';
      document.body.appendChild(bubble);
    }
    bubble.textContent = text;
    // 先按实际尺寸定位置：默认在球左侧；左侧放不下时翻转到球右侧，保证球不会遮住文字
    bubble.classList.remove('show', 'flip');
    bubble.style.left = '0px';
    bubble.style.top = '0px';
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const gap = 14;
    const r = ball.getBoundingClientRect();
    let left;
    if (r.left > bw + gap + 8) {
      left = r.left - bw - gap;
    } else {
      bubble.classList.add('flip');
      left = r.right + gap;
    }
    left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - bw - 8));
    const top = Math.min(Math.max(8, r.top + r.height / 2 - bh / 2), Math.max(8, window.innerHeight - bh - 8));
    bubble.style.left = left + 'px';
    bubble.style.top = top + 'px';
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), 7000);
  }

  // 弹跳 + 光晕动效
  function playBallCelebrate() {
    if (!ball) return;
    ball.classList.remove('__bili_celebrate');
    void ball.offsetWidth; // 重启动画
    ball.classList.add('__bili_celebrate');
  }

  // 入场提示：视频信息（标题/BV/弹幕/字幕）+ 预设文案 + 自定义文案，一次性整块显示
  function showReadyMessages(info) {
    const { bvid, title, hasSubtitle, danmaku } = info;
    const lines = [];
    if (title) lines.push(`🎬 ${title.length > 22 ? title.slice(0, 22) + '…' : title}`);
    const meta = [];
    meta.push(`📎 ${bvid}`);
    meta.push(danmaku > 0 ? `弹幕 ${danmaku} 条` : '无弹幕');
    meta.push(hasSubtitle ? '字幕 ✓' : '无字幕');
    lines.push(meta.join(' · '));
    lines.push('✅ 此视频可以分析了！');
    if (ballMsgCustom) {
      for (const t of ballMsgCustom.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) lines.push(t);
    }
    playBallCelebrate();
    showBubble(lines.join('\n'));
  }

  // 查询视频信息（标题 / 弹幕数 / 字幕可用性），触发入场提示
  async function checkVideo() {
    const bvid = getBvid();
    if (!bvid) return;
    try {
      chrome.runtime.sendMessage({ action: 'checkVideo', bvid }, (resp) => {
        if (chrome.runtime.lastError || !resp) return;
        if (!enabled || ballMsgEnabled === false) return;
        showReadyMessages(resp);
      });
    } catch (e) { }
  }

  // ---- SPA 路由监听：B站站内跳转（如点击推荐视频）不刷新页面，需监听 BV 变化 ----
  let lastBvid = null;
  function watchBvid() {
    setInterval(() => {
      const bv = getBvid();
      if (bv === lastBvid) return;
      lastBvid = bv;
      if (!bv) {
        // 离开视频页：收起悬浮球与气泡
        closeMenu();
        if (bubble) { bubble.remove(); bubble = null; }
        if (ball) { ball.remove(); ball = null; }
        return;
      }
      if (!ball) {
        injectStyles();
        buildBall();
      }
      if (enabled && ballMsgEnabled !== false) checkVideo();
    }, 1000);
  }

  // ---- 悬浮球 ----
  function buildBall() {
    if (ball) return;
    ball = document.createElement('div');
    ball.id = '__bili_float_ball';
    ball.textContent = 'B';
    ball.style.cssText = `
      position: fixed; right: 24px; bottom: 130px; width: 48px; height: 48px;
      border-radius: 50%; z-index: 2147483647; cursor: grab; user-select: none;
      background: linear-gradient(135deg, ${accent1}, ${accent2});
      color: #fff; font-size: 22px; font-weight: 800; font-family: 'Segoe UI', system-ui, sans-serif;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 6px 20px rgba(0,0,0,.45), 0 0 0 0 rgba(0,200,255,.3);
      transition: transform .15s, box-shadow .3s;`;
    ball.onmouseenter = () => { ball.style.transform = 'scale(1.08)'; };
    ball.onmouseleave = () => { ball.style.transform = 'scale(1)'; };
    document.body.appendChild(ball);
    restorePos();
    bindDrag();
    bindClick();
  }

  function restorePos() {
    try {
      chrome.storage.local.get('floatPos', (s) => {
        if (!s.floatPos) return;
        ball.style.right = 'auto';
        ball.style.bottom = 'auto';
        ball.style.left = s.floatPos.x + 'px';
        ball.style.top = s.floatPos.y + 'px';
      });
    } catch (e) { }
  }

  let dragging = false;
  let moved = false;
  let startX = 0, startY = 0, origX = 0, origY = 0;

  function bindDrag() {
    ball.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const r = ball.getBoundingClientRect();
      origX = r.left;
      origY = r.top;
      ball.setPointerCapture(e.pointerId);
      ball.style.cursor = 'grabbing';
    });
    ball.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
      const x = Math.min(window.innerWidth - 52, Math.max(4, origX + dx));
      const y = Math.min(window.innerHeight - 52, Math.max(4, origY + dy));
      ball.style.left = x + 'px';
      ball.style.top = y + 'px';
      ball.style.right = 'auto';
      ball.style.bottom = 'auto';
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      ball.style.cursor = 'grab';
      if (moved) {
        try {
          const r = ball.getBoundingClientRect();
          chrome.storage.local.set({ floatPos: { x: Math.round(r.left), y: Math.round(r.top) } });
        } catch (err) { }
      }
    };
    ball.addEventListener('pointerup', endDrag);
    ball.addEventListener('pointercancel', endDrag);
  }

  // ---- 菜单 ----
  function buildMenu() {
    if (menu) menu.remove();
    menu = document.createElement('div');
    menu.id = '__bili_float_menu';
    const r = ball.getBoundingClientRect();
    const items = [
      { icon: '📺', label: '弹幕 + 字幕', mode: 'dm' },
      { icon: '💬', label: '评论', mode: 'cm' },
      { icon: '🤖', label: 'AI 全分析', mode: 'ai' },
      { icon: '⚙️', label: '扩展设置', mode: 'opts' }
    ];
    menu.style.cssText = `
      position: fixed; left: ${Math.min(r.left, window.innerWidth - 168)}px; top: ${Math.max(4, r.top - items.length * 40 - 12)}px;
      z-index: 2147483646; background: #141a2e; border: 1px solid #232c4a; border-radius: 12px;
      padding: 6px; box-shadow: 0 10px 34px rgba(0,0,0,.55); font-family: 'Segoe UI', system-ui, sans-serif;
      min-width: 150px;`;
    for (const it of items) {
      const item = document.createElement('div');
      item.textContent = `${it.icon} ${it.label}`;
      item.style.cssText = `
        padding: 8px 12px; border-radius: 8px; color: #e6e9f5; font-size: 13px; cursor: pointer;
        transition: background .15s;`;
      item.onmouseenter = () => { item.style.background = 'rgba(0,200,255,.12)'; };
      item.onmouseleave = () => { item.style.background = 'transparent'; };
      item.onclick = (ev) => {
        ev.stopPropagation();
        closeMenu();
        handleAction(it.mode);
      };
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    // 点击别处关闭
    setTimeout(() => {
      document.addEventListener('pointerdown', closeMenu, { once: true });
    }, 0);
  }

  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
  }

  function bindClick() {
    ball.addEventListener('click', (e) => {
      if (moved) return; // 拖拽不算点击
      e.stopPropagation();
      if (menu) { closeMenu(); return; }
      buildMenu();
    });
  }

  // ---- 动作 ----
  function handleAction(mode) {
    const bvid = getBvid();
    if (!bvid) { showToast('当前页面未找到 BV 号', '#f44336'); return; }
    if (mode === 'opts') {
      chrome.runtime.sendMessage({ action: 'openOptions' });
      return;
    }
    chrome.runtime.sendMessage({ action: 'floatScrape', bvid, mode }, () => {
      const labels = { dm: '弹幕+字幕', cm: '评论', ai: 'AI 全分析' };
      showToast(`已开始抓取「${bvid}」(${labels[mode]})，完成后有通知`);
    });
  }

  // 监听后台结果反馈
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'floatResult') {
      showToast(msg.message, msg.ok ? '#4caf50' : '#f44336');
    }
  });

  // 设置变化实时响应（悬浮球开关/主题/提示）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const cfg = changes.settings.newValue || {};
    const t = THEMES[cfg.theme] || THEMES.aurora;
    accent1 = t[0];
    accent2 = t[1];
    enabled = cfg.showFloatingBall !== false;
    ballMsgEnabled = cfg.ballMsgEnabled !== false;
    ballMsgCustom = cfg.ballMsgCustom || '';
    if (ball) {
      ball.style.background = `linear-gradient(135deg, ${accent1}, ${accent2})`;
    }
    if (cfg.showFloatingBall === false) {
      closeMenu();
      if (bubble) { bubble.remove(); bubble = null; }
      if (ball) { ball.remove(); ball = null; }
    } else if (!ball) {
      // 重新启用：重建悬浮球并立即检查当前视频
      injectStyles();
      buildBall();
      checkVideo();
    }
  });

  // ---- 启动 ----
  (async function init() {
    await loadPrefs();
    lastBvid = getBvid();
    if (!enabled || !lastBvid) {
      // 悬浮球关闭或不在视频页时，仍监听路由，进入视频页时自动呼出
      watchBvid();
      return;
    }
    injectStyles();
    buildBall();
    // 延迟入场：等页面渲染完成后再查询视频信息并播放提示
    setTimeout(checkVideo, 2500);
    watchBvid();
  })();
})();
