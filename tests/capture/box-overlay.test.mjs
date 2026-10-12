// Executes the shipped overlay script with the Tauri v2 global API shape.
// Tests the boundary between window AX candidates and the selected image region.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(repo, 'app/ui/boxselect.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const args = process.argv.slice(2), oi = args.indexOf('--out');
const out = oi < 0 ? fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-box-overlay-')) : args[oi + 1];
fs.mkdirSync(out, { recursive: true });
const results = [];
function check(name, test) {
  try { test(); results.push({ name, pass: true }); console.log('PASS ' + name); }
  catch (err) { results.push({ name, pass: false, error: String(err) }); console.log('FAIL ' + name + ': ' + err); }
}
function boot({ bridge = true, events = true } = {}) {
  const nodes = {}, handlers = {}, invokes = [], listens = {};
  const node = () => ({ style: {}, innerHTML: '', classList: { add() {}, toggle() {} }, querySelectorAll: () => [] });
  const window = bridge ? { __TAURI__: { core: { invoke(name, payload) { invokes.push({ name, payload }); return Promise.resolve(null); } } } } : {};
  if (bridge && events) window.__TAURI__.event = { listen(name, callback) { listens[name] = callback; return Promise.resolve(() => {}); } };
  const context = vm.createContext({ window, document: {
    getElementById(id) { return nodes[id] ||= node(); },
    addEventListener(name, callback) { handlers[name] = callback; },
  }, requestAnimationFrame: fn => fn(), setTimeout: fn => fn(), matchMedia: () => ({ matches: true }), innerWidth: 1200, innerHeight: 800 });
  vm.runInContext(script, context, { filename: 'boxselect.html' });
  function select(x0, y0, x1, y1) {
    handlers.pointerdown({ pointerType: 'mouse', button: 0, clientX: x0, clientY: y0, preventDefault() {} });
    handlers.pointerup({ clientX: x1, clientY: y1, preventDefault() {} });
  }
  return { window, nodes, listens, invokes, select };
}
const candidates = { ox: -100, oy: 50, blocks: Array.from({ length: 10 }, (_, i) => ({ i, x: 10, y: i * 22, w: 60, h: 20, text: 'toolbar ' + i })) };
const b = boot();
check('Tauri v2 root event API registers candidates without a false missing-interface hint', () => {
  assert.equal(typeof b.listens['box-candidates'], 'function');
  assert.ok(b.invokes.some(x => x.name === 'box_select_ready'));
  assert.ok(!b.nodes.hint.innerHTML.includes('接口未注入'));
});
check('candidate delivery preserves origin and selects AX mode for a text-capable window', () => {
  b.listens['box-candidates']({ payload: candidates });
  assert.equal(b.window.__mode, 'ax');
  assert.equal(b.window.__origin.x, -100);
});
check('image-only selected region falls back to pixels even when the toolbar exposes AX text', () => {
  b.select(200, 300, 400, 500);
  const finish = b.invokes.find(x => x.name === 'box_select_finish');
  assert.ok(finish);
  assert.deepEqual(JSON.parse(JSON.stringify(finish.payload)), { blocks: [], rect: { x: 100, y: 350, w: 200, h: 200 } });
  assert.equal(b.window.__mode, 'ocr');
});
check('selected AX text still preserves its block identity and screen coordinates', () => {
  const t = boot(); t.listens['box-candidates']({ payload: candidates }); t.select(10, 0, 70, 20);
  const p = t.invokes.find(x => x.name === 'box_select_finish').payload;
  assert.equal(p.blocks.length, 1); assert.equal(p.blocks[0].i, 0); assert.equal(p.blocks[0].text, 'toolbar 0');
  assert.equal(p.blocks[0].x, -90); assert.equal(p.blocks[0].y, 50); assert.equal(t.window.__mode, 'ax');
});
check('tiny selection cancels without creating a capture request', () => {
  const t = boot(); t.select(10, 10, 12, 12);
  assert.ok(t.invokes.some(x => x.name === 'box_select_cancel'));
  assert.ok(!t.invokes.some(x => x.name === 'box_select_finish'));
});
check('invoke-only bridge keeps the direct candidate-delivery fallback usable', () => {
  const t = boot({ events: false }); t.window.__setCandidates({ ox: 0, oy: 0, blocks: [] }); t.select(20, 20, 200, 200);
  assert.ok(t.invokes.some(x => x.name === 'box_select_finish'));
  assert.ok(!t.nodes.hint.innerHTML.includes('接口未注入'));
});
check('truly absent native bridge shows the explicit recovery message', () => {
  const t = boot({ bridge: false }); assert.ok(t.nodes.hint.innerHTML.includes('接口未注入'));
});
fs.writeFileSync(path.join(out, 'box-overlay.json'), JSON.stringify(results, null, 2) + '\n');
console.log(`box-overlay: ${results.filter(x => x.pass).length}/7 pass`);
process.exit(results.some(x => !x.pass) ? 1 : 0);
