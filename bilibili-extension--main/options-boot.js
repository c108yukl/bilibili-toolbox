/* 设置页启动脚本：尽早应用界面风格类，避免深色闪屏（MV3 CSP 禁止内联脚本） */
try {
  chrome.storage.local.get('settings', (s) => {
    const st = ((s && s.settings) || {}).uiStyle;
    if (st === 'editorial' || st === 'neumorphism') document.body.classList.add('style-' + st);
  });
} catch (e) { }
