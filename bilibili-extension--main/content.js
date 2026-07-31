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
  let ball = null;
  let menu = null;
  let toast = null;

  async function loadPrefs() {
    try {
      const s = await chrome.storage.local.get('settings');
      const cfg = s.settings || {};
      enabled = cfg.showFloatingBall !== false;
      const t = THEMES[cfg.theme] || THEMES.aurora;
      accent1 = t[0];
      accent2 = t[1];
    } catch (e) { }
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

  // 设置变化实时响应（悬浮球开关/主题）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const cfg = changes.settings.newValue || {};
    const t = THEMES[cfg.theme] || THEMES.aurora;
    accent1 = t[0];
    accent2 = t[1];
    if (ball) {
      ball.style.background = `linear-gradient(135deg, ${accent1}, ${accent2})`;
    }
    if (cfg.showFloatingBall === false) {
      closeMenu();
      if (ball) { ball.remove(); ball = null; }
    } else if (enabled !== true || cfg.showFloatingBall === true) {
      if (!ball) buildBall();
    }
  });

  // ---- 启动 ----
  (async function init() {
    await loadPrefs();
    if (!enabled) return;
    // 视频页才显示（含 /video/ 或含 BV）
    if (!getBvid()) return;
    buildBall();
    // SPA 路由变化时 BV 可能更新（菜单标题不依赖，无需处理）
  })();
})();
