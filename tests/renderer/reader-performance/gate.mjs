// tests/renderer/reader-performance/gate.mjs —— P1-B06-PERF-01-REPAIR-01 / R1-F03+F04
// 性能门、注入归因检测与退出分类的单一事实源：
//  - reader-performance.test.mjs（真实测量）与 repair-regressions.mjs（固定负例回放）共用，
//    预算派生不依赖待测输出的自我背书；
//  - 只认显式核验过的字段：bytes 必须是 102400/1048576 之一的整数；缺失/未知/NaN 一律显式失败；
//  - p95/maxDrift 由完整原始 trials 重算，不信任摘要字段。
export const KNOWN_BYTES = new Set([102400, 1048576]);

export function p95of(xs) {
  if (!Array.isArray(xs) || !xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(s.length * 0.95) - 1];
}

/* Shared by normal/control/injected runs. Keep every heartbeat sample, not only a count. */
export function validateTrial(t, expectedEntries) {
  if (!t || typeof t !== 'object') return 'not-object';
  if (t.status !== 'rendered' || t.rendered !== true) return `not-rendered(${t.status})`;
  if (t.identityOk !== true) return 'identity-invalid-or-missing';
  for (const k of ['bodyTextLen', 'domNodes'])
    if (!Number.isInteger(t[k]) || t[k] <= 0) return `${k}-empty-or-missing`;
  if (!Number.isInteger(t.entries) || t.entries !== expectedEntries) return 'entries-invalid';
  for (const k of ['visibleMs', 'maxDrift']) {
    if (!Number.isFinite(t[k])) return `${k}-not-finite`;
    if (t[k] < 0) return `${k}-negative`;
  }
  if (!Number.isInteger(t.driftN) || t.driftN <= 0) return 'drift-samples-empty';
  if (!Array.isArray(t.samples) || !t.samples.length) return 'raw-samples-empty-or-missing';
  if (t.samples.length !== t.driftN) return 'sample-count-mismatch';
  let last = -Infinity, maximum = 0;
  for (const s of t.samples) {
    if (!s || !Number.isFinite(s.scheduled) || !Number.isFinite(s.fired)
      || s.scheduled < 0 || s.fired < s.scheduled || s.scheduled < last) return 'sample-time-invalid';
    last = s.scheduled;
    maximum = Math.max(maximum, s.fired - s.scheduled);
  }
  if (Math.abs(maximum - t.maxDrift) > 0.000001) return 'sample-maximum-mismatch';
  return null;
}

/* 严格性能门：perf = [{label, bytes, blocks, counts, cold, warm, trials}]
   trials 需含每试跑原始 {status, rendered, visibleMs, maxDrift, driftN, entries, domNodes}。
   返回 {gateFail, failures[], checked[]}；任何缺字段/未完成/未知长度都计入 failures。 */
export function evaluatePerformanceGate(perf) {
  const failures = [], checked = [];
  if (!Array.isArray(perf) || !perf.length) return { gateFail: 1, failures: ['perf-not-array-or-empty'], checked: [] };
  for (const f of perf) {
    const label = f && f.label;
    const push = (why, detail) => failures.push(`${label}:${why}${detail !== undefined ? ':' + String(detail) : ''}`);
    if (!f || typeof f !== 'object') { push('not-an-object'); continue; }
    // —— 长度字段：唯一预算派生来源，缺失/未知/非整数显式失败（R1-F03）——
    if (!('bytes' in f)) { push('bytes-missing'); continue; }
    if (!Number.isInteger(f.bytes) || !KNOWN_BYTES.has(f.bytes)) { push('bytes-unknown', f.bytes); continue; }
    const budget = f.bytes === 102400 ? 200 : 1000;
    // —— 结构计数（真实 mapper 核验过的期望）——
    const c = f.counts || {}, blocks = f.blocks;
    if (!Number.isInteger(blocks) || blocks <= 0) { push('blocks-invalid', blocks); continue; }
    if (c.headings !== blocks * 2 || c.fences !== blocks || c.entries !== blocks * 4) { push('structure-counts', JSON.stringify(c)); continue; }
    // —— 每试跑完整完成与字段健全 ——
    const trials = f.trials;
    if (!Array.isArray(trials) || trials.length < 31) { push('trials-missing-or-short', Array.isArray(trials) ? trials.length : 'none'); continue; }
    let trialBad = null;
    for (let i = 0; i < trials.length && !trialBad; i++) {
      const reason = validateTrial(trials[i], blocks * 4);
      if (reason) trialBad = `trial-${i}-${reason}`;
    }
    if (trialBad) { push('trial-invalid', trialBad); continue; }
    // —— 预算（由原始 trials 重算；warm=去首跑）——
    const warm = trials.slice(1).map((t) => t.visibleMs);
    const visibleP95 = p95of(warm);
    const maxDrift = Math.max(...trials.map((t) => t.maxDrift));
    if (!Number.isFinite(visibleP95)) { push('p95-not-finite'); continue; }
    if (!(visibleP95 <= budget)) push('visible-budget', `p95=${visibleP95.toFixed(1)}>${budget}`);
    if (f.bytes === 1048576 && !(maxDrift <= 100)) push('input-blocking-budget', `maxDrift(all)=${maxDrift.toFixed(1)}>100`);
    checked.push({ label, bytes: f.bytes, visibleP95, maxDrift, budget, pass: !failures.some((x) => x.startsWith(`${label}:visible`) || x.startsWith(`${label}:input`)) });
  }
  return { gateFail: failures.length, failures, checked };
}

/* 注入归因检测（R1-F04）：观察器样本 samples=[{scheduled,fired}]，注入窗口 [injStart,injEnd]。
   “捕获”必须存在一条真实样本横跨整个注入窗口（scheduled≤injStart 且 fired≥injEnd-容差），
   而不是“任意 max≥阈值 且到过注入点”。漏记注入/纯背景噪声都不算捕获。 */
export function detectInjectionAttribution(samples, injStart, injEnd, toleranceMs = 4) {
  if (!Array.isArray(samples) || !samples.length) return { caught: false, reason: 'no-samples' };
  if (!Number.isFinite(injStart) || !Number.isFinite(injEnd) || injStart < 0 || injEnd - injStart < 150
    || !Number.isFinite(toleranceMs) || toleranceMs < 0 || toleranceMs > 4)
    return { caught: false, reason: 'invalid-injection-window' };
  const covering = samples.filter((s) => s && Number.isFinite(s.scheduled) && Number.isFinite(s.fired)
    && s.scheduled >= 0 && s.fired >= s.scheduled && s.scheduled <= injStart && s.fired >= injEnd - toleranceMs);
  if (!covering.length) return { caught: false, reason: 'no-covering-sample', maxDrift: Math.max(...samples.map((s) => s.fired - s.scheduled)) };
  const worst = covering.reduce((a, b) => ((b.fired - b.scheduled) > (a.fired - a.scheduled) ? b : a));
  return { caught: true, sample: { scheduled: worst.scheduled, fired: worst.fired, drift: worst.fired - worst.scheduled } };
}

/* 注入轮退出分类（R1-F04）：只有「对照有效 + 注入被归因捕获 + 证据写成功 + 清理成功」才给 3。
   controlValid=false→6（对照污染/未证明）；注入未捕获→7（观察器盲区）；证据写失败→4；清理失败→5；异常→1。
   输入完整性由调用方先保证（任一异常路径都不得静默归入成功码）。 */
export function classifyInjectRun({ thrown, controlValid, controlGatePassed, injectedValid, attributed, evidenceWritten, cleanupOk }) {
  if (thrown !== null) return { code: 1, reason: 'exception-or-unknown', thrown: String(thrown) };
  if (evidenceWritten !== true) return { code: 4, reason: 'evidence-write-failed-or-unknown' };
  if (cleanupOk !== true) return { code: 5, reason: 'cleanup-failed-or-unknown' };
  if (controlValid !== true) return { code: 6, reason: 'control-invalid-or-polluted' };
  if (controlGatePassed !== true) return { code: 6, reason: 'control-failed-gate' };
  if (injectedValid !== true) return { code: 9, reason: 'injected-trial-invalid-or-unknown' };
  if (attributed !== true) return { code: attributed === false ? 7 : 1, reason: 'injection-not-attributed-or-unknown' };
  return { code: 3, reason: 'control-valid+injection-attributed+evidence+cleanup' };
}
