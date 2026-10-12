// tests/reader/fixtures.mjs —— P0-B01 reader 回归的合成 fixtures 与独立预期值。
// 全部为合成数据（不含真实用户内容）。预期值在此显式书写，
// 不从 UI 渲染结果或 API 回读反推（VALIDATION §B 规则）。

// ---------- 正文 fixtures（quote 精确字符串；\n=\nLF \r=CR） ----------
export const QUOTES = {
  // LF 换行 + 缩进 + 中英标点 + Unicode/emoji（复制比对 t1）
  t1: '第一段：引号「」、间隔号 ·、emoji 🐱。\n    缩进行（四个空格开头）\n第二段——破折号、省略号……\nconst code = \'line\'; // tail',
  // CRLF 换行（复制比对 t5）：存储与复制载荷必须逐字节保留 \r\n
  t5: 'CRLF 第一行\r\nCRLF 第二行（带“中文引号”）\r\n    CRLF 缩进行',
  // CR-only 换行（复制比对 t6）：旧 Mac 风格，逐字节保留 \r
  t6: 'CR 第一行\rCR 第二行\rCR 缩进',
  t2: '正文 T2：单个附件条目。\n第二行',
  t3: '正文 T3：多个附件条目，其中文件名含引号、尖括号与 Unicode。',
  t4: '正文 T4：引用的文件已被删除（missing）。',
  t7: '正文 A：延迟竞争用条目（A 的附件响应会被注入延迟）。',
  t8: '正文 B：延迟竞争用条目（B 正常返回）。',
};

// ---------- 条目定义（经真实 POST /api/suggestions 播种） ----------
export const SUGGESTIONS = [
  { key: 't1', title: 'FIXTURE T1 · 纯正文 0 附件', quote: QUOTES.t1, source_tool: 'zcode', workspace: '/tmp/nayan-reader-test', session_ref: 'reader-fixtures' },
  { key: 't2', title: 'FIXTURE T2 · 单个有效附件', quote: QUOTES.t2, source_tool: 'zcode', workspace: '/tmp/nayan-reader-test', session_ref: 'reader-fixtures' },
  { key: 't3', title: 'FIXTURE T3 · 多附件+特殊文件名', quote: QUOTES.t3, source_tool: 'zcode', workspace: '/tmp/nayan-reader-test', session_ref: 'reader-fixtures' },
  { key: 't4', title: 'FIXTURE T4 · 缺失文件引用', quote: QUOTES.t4, source_tool: 'zcode', workspace: '/tmp/nayan-reader-test', session_ref: 'reader-fixtures' },
  { key: 't5', title: 'FIXTURE T5 · CRLF 正文（复制比对）', quote: QUOTES.t5, source_tool: 'zcode', workspace: '/tmp/nayan-reader-test', session_ref: 'reader-fixtures' },
  { key: 't6', title: 'FIXTURE T6 · CR 正文（复制比对）', quote: QUOTES.t6, source_tool: 'zcode', workspace: '/tmp/nayan-reader-test', session_ref: 'reader-fixtures' },
  { key: 't7', title: 'FIXTURE A · 延迟竞争 A', quote: QUOTES.t7, source_tool: 'zcode', workspace: '/tmp/nayan-reader-test', session_ref: 'reader-fixtures' },
  { key: 't8', title: 'FIXTURE B · 延迟竞争 B', quote: QUOTES.t8, source_tool: 'zcode', workspace: '/tmp/nayan-reader-test', session_ref: 'reader-fixtures' },
];

// ---------- 附件源文件（全部位于隔离根目录 files/ 内，测试自创建自清理） ----------
// name 字段是「期望显示的文件名」；实际文件名由 path 决定
export const ATTACH_FILES = [
  { key: 't2-note', forKey: 't2', content: 'T2 附件内容：合成数据\nline2\n' },
  { key: 't3-plain', forKey: 't3', content: 'T3 附件 1\n' },
  // 单引号、双引号、尖括号、Unicode、emoji、间隔号——按文本安全显示的用例
  { key: "t3-hostile-报告\"引'<尖括号>'·🐱", forKey: 't3', content: 'T3 hostile filename 内容\n' },
  { key: 't3-数据表·2026', forKey: 't3', content: 'T3 附件 3：中文文件名\n' },
  { key: 't4-gone', forKey: 't4', content: 'T4 将被删除的附件\n', deleteAfterAttach: true },
  { key: 't7-a', forKey: 't7', content: 'A 附件\n' },
  { key: 't8-b', forKey: 't8', content: 'B 附件\n' },
  // 供 addAtts 增删场景用（初始不挂任何条目）
  { key: 'runtime-add-新附件 «runtime»', forKey: null, content: '运行期新增引用的源文件\n' },
];

// ---------- 复制比对预期（label → 期望 quote 字符串） ----------
export const COPY_EXPECTED = [
  { label: 't1', quote: QUOTES.t1 },
  { label: 't5', quote: QUOTES.t5 },
  { label: 't6', quote: QUOTES.t6 },
];

export function fileNameOf(f) {
  return f.key + '.md';
}

// ---------- 逐条目期望附件集合（R2-F01：压力/验证共用的唯一事实来源） ----------
// phase: 'seed' | 'after-ui'（含 after-restart——场景净效果相同：T1 增加运行期引用并保留，
// T2 增加后移除净不变）。期望值显式声明，不从 UI 或 DB 当前状态反推。
export function expectedAttachmentsByName(phase) {
  const m = new Map(SUGGESTIONS.map(s => [s.title, []]));
  for (const f of ATTACH_FILES) {
    if (!f.forKey) continue;
    const title = SUGGESTIONS.find(s => s.key === f.forKey).title;
    m.get(title).push(fileNameOf(f));
  }
  if (phase !== 'seed') {
    const t1 = SUGGESTIONS.find(s => s.key === 't1').title;
    m.get(t1).push(fileNameOf(ATTACH_FILES.find(f => f.forKey === null)));
  }
  for (const [k, v] of m) m.set(k, [...v].sort());
  return m;
}
