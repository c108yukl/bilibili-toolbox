/* 诊断页引导：按钮先绑好，模块后加载，任何报错直接显示在页面上 */
window.addEventListener('error', (e) => log('全局错误: ' + e.message + ' @' + (e.filename || '') + ':' + e.lineno, 'err'));
window.addEventListener('unhandledrejection', (e) => log('未捕获异常: ' + (e.reason && e.reason.message || e.reason), 'err'));

const logEl = document.getElementById('log');
const goBtn = document.getElementById('go');
const stopBtn = document.getElementById('stop');

function log(text, cls = '') {
  const t = new Date().toTimeString().slice(0, 8);
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${t}] ${text}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

let main = null;
goBtn.addEventListener('click', async () => {
  goBtn.disabled = true;
  try {
    if (!main) {
      log('加载诊断模块 ...', 'dim');
      main = await import('./live-test-main.js');
    }
    await main.run(parseInt(document.getElementById('room').value, 10), { log, setBusy });
  } catch (e) {
    log('诊断失败: ' + (e && e.stack || e), 'err');
    setBusy(false);
  }
});
stopBtn.addEventListener('click', () => { try { main && main.stop(); } catch (e) { } });

function setBusy(busy) {
  goBtn.disabled = busy;
  stopBtn.disabled = !busy;
}
