// tests/renderer/cdp.mjs —— 渲染器测试共用的最小 CDP 客户端 + Chrome 启动（零依赖）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function startChrome(extraArgs = []) {
  if (!fs.existsSync(CHROME)) throw new Error('找不到 Google Chrome：' + CHROME);
  const cdpPort = 20000 + Math.floor(Math.random() * 20000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-renderer-chrome-'));
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,860',
    'about:blank', ...extraArgs,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  // 等 DevTools 端口就绪
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (r.ok) return { child, cdpPort, profile };
    } catch (_) { /* retry */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  child.kill();
  throw new Error('Chrome DevTools 端口未就绪');
}

export class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        for (const fn of this.handlers.get(msg.method)) {
          try { fn(msg.params || {}); } catch (_) { /* 订阅方异常不断连接 */ }
        }
      }
    };
    this.ready = new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('CDP ws error')); });
  }
  /** 订阅 CDP 事件（如 Network.requestWillBeSent）；返回取消函数 */
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return () => { this.handlers.set(method, this.handlers.get(method).filter((f) => f !== fn)); };
  }
  static async connect(port) {
    for (let i = 0; i < 50; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find((p) => p.type === 'page');
        if (page) return new CDP(page.webSocketDebuggerUrl);
      } catch (_) { /* retry */ }
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error('CDP 页面连接失败');
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面求值异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async screenshot(filePath) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(filePath, Buffer.from(r.data, 'base64'));
    return filePath;
  }
  async go(url) {
    await this.send('Page.navigate', { url });
    // 等文档就绪 + 一拍渲染
    for (let i = 0; i < 100; i++) {
      const st = await this.send('Runtime.evaluate', { expression: 'document.readyState' });
      if (st.result.value === 'complete') break;
      await new Promise((res) => setTimeout(res, 100));
    }
    await new Promise((res) => setTimeout(res, 150));
  }
  close() { try { this.ws.close(); } catch (_) { /* noop */ } }
}
