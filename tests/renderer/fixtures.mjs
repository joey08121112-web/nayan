// tests/renderer/fixtures.mjs —— P1-T05 渲染器测试的共享 fixture 源
// 期望值的事实来源：tests/content/golden/*.json（Rust 序列化产出、经 Rust round-trip
// + 一致性重算验收过的 canonical），不在本目录重造规则；渲染器特有边界在此补充。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(__dirname, '..', '..');
export const CONTENT_DIR = path.join(REPO, 'tests', 'content');
export const UI_DIR = path.join(REPO, 'app', 'ui');
export const APP_BIN = path.join(REPO, 'app', 'src-tauri', 'target', 'debug', 'nayan');

/** 载入全部 golden 信封（真实 Rust 产物）。binary=true 的用例无文本 canonical。 */
export function loadGoldens() {
  const manifest = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'manifest.json'), 'utf8'));
  return manifest.map((m) => {
    const envelope = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'golden', m.fixture + '.json'), 'utf8'));
    return {
      name: m.fixture,
      format: m.format,
      legacy: !!m.legacy,
      binary: !!m.binary,
      envelope,
      originalText: envelope.original && envelope.original.kind === 'text' ? envelope.original.text : null,
      canonical: typeof envelope.canonical === 'string' ? envelope.canonical : null,
    };
  });
}

/** 渲染器特有边界（期望值按文档化规则书写，与实现独立推导） */
export function rendererExtras() {
  return [
    {
      name: 'x01-literal-br-and-tags.txt',
      // 文本里出现字面 <br>/<script>：必须原样可见，绝不变成元素或被执行
      original: '第一行\n第二行含字面 <br> 标签\n<script>window.__PWNED__=1</script>\n<img src=x onerror="window.__PWNED__=2">',
      canonical: '第一行\n第二行含字面 <br> 标签\n<script>window.__PWNED__=1</script>\n<img src=x onerror="window.__PWNED__=2">',
    },
    {
      name: 'x02-cr-boundaries.txt',
      // 规范换行边界：\r\n→\n、孤立 \r→\n；\n 不动；空行成对保留
      original: 'a\r\nb\rc\n\n\rd\r\n\r\n',
      canonical: 'a\nb\nc\n\n\nd\n\n',
    },
    {
      name: 'x03-blank-indent-matrix.txt',
      original: '标题行\n\n\n    四空格缩进\n\t制表符行\n  两空格\n\n结尾',
      canonical: '标题行\n\n\n    四空格缩进\n\t制表符行\n  两空格\n\n结尾',
    },
    {
      name: 'x04-middle-dot-kept.txt',
      // 中点不许被拆成列表：原样一行
      original: '先装 Xcode · 再装 CLT · 配置签名 · 打包\n中点 · 间隔 · 保持',
      canonical: '先装 Xcode · 再装 CLT · 配置签名 · 打包\n中点 · 间隔 · 保持',
    },
    {
      name: 'x05-legacy-looks-md.txt',
      // legacy 含 # / - 列表样式：绝不解释为 Markdown（P1-T06 才有声明 Markdown）
      original: '# 这不是标题\n- 这不是列表项\n1. 也不是有序列表\n```也不是围栏```',
      canonical: '# 这不是标题\n- 这不是列表项\n1. 也不是有序列表\n```也不是围栏```',
    },
    {
      name: 'x06-unbroken-long-line.txt',
      original: '短行开头\n' + 'A'.repeat(4000) + '\n短行结尾',
      canonical: '短行开头\n' + 'A'.repeat(4000) + '\n短行结尾',
    },
    {
      name: 'x07-wrappable-cjk-long.txt',
      // 可在任意字符间断行的 CJK 长行：应换行而不是横向溢出
      original: '汉'.repeat(600),
      canonical: '汉'.repeat(600),
    },
  ];
}

/** 性能 fixture：合成指定 codepoint 数的正文（段落/空行/缩进/CJK+emoji/长码行） */
export function synthBody(targetCodepoints) {
  const para = '一段中英混排正文 with English words and 数字 123。\n    缩进行 kept\n\n'
    + 'const line = "unbroken-' + 'X'.repeat(160) + '";\n\n'
    + 'emoji 👨‍👩‍👧‍👦 与组合 é 字符保留 ·· 中点\n\n';
  let out = '';
  while ([...out].length + [...para].length <= targetCodepoints) out += para;
  const need = targetCodepoints - [...out].length;
  if (need > 0) out += 'B'.repeat(need);
  return out;
}

export function synthEnvelope(text, requestId, format = 'plain') {
  const canonical = text.replace(/\r\n?/g, '\n');
  // 服务端派生规则（content.rs）：Html 的 plain projection 显式 Unavailable（等 sanitizer），
  // Plain/Markdown = canonical。POST 前信封必须与派生一致，否则整笔拒绝。
  const plain_projection = format === 'html'
    ? { status: 'unavailable', reason: 'html sanitizer 未实现：结构化 plain projection 不可用（本批契约显式拒绝伪投影）' }
    : { status: 'available', text: canonical };
  return {
    schema_version: 1,
    request_id: requestId,
    format,
    format_provenance: 'declared',
    acquisition: 'manual',
    original: { kind: 'text', text },
    fidelity: { truncated: false },
    canonical,
    canonical_unavailable_reason: null,
    plain_projection,
  };
}

/** P1-T06：声明 Markdown 的结构 fixture（期望值独立于实现手推，与 golden b07–b10 互补） */
export function richMarkdownCases() {
  return [
    {
      name: 'md-full-matrix',
      // 标题/嵌套列表/有序非1/围栏/引用/分隔线/链接/行内标记 全覆盖
      src: '# 大标题\n\n- 一级甲\n  - 二级甲\n    - 三级甲\n- 另一个一级\n\n5. 第五条\n6. 第六条\n\n'
        + '```js\nconst s = "  内部空格  ";\n\ttab 行\n```\n\n> 引用一句\n\n---\n\n'
        + '尾段 [链接](https://example.com/a?b=1) 与 **粗** *斜* `码`。',
      expect: {
        h1Text: '大标题',
        ulDepths: [0, 1, 2, 0],
        olStart: 5,
        olItems: ['第五条', '第六条'],
        fenceExact: 'const s = "  内部空格  ";\n\ttab 行\n',
        quoteText: '引用一句',
        hrCount: 1,
        linkHref: 'https://example.com/a?b=1',
        linkText: '链接',
        strong: '粗', em: '斜', codeSpan: '码',
      },
    },
    {
      name: 'md-blank-lines-semantic',
      // Matrix B02：Markdown 显示允许语义间距（不要求逐空行），但源文本不得被改写
      src: '第一段\n\n\n\n第二段',
      expect: { pCount: 2 },
    },
    {
      name: 'md-indented-code',
      // Matrix B05：4 空格缩进块 = CommonMark 代码块，空白保留
      src: '正文\n\n    indented code\n      deeper\n\n尾',
      expect: { preText: 'indented code\n  deeper\n' },
    },
    {
      name: 'md-long-code-line',
      // Matrix B12：围栏内长行 → pre 横向滚动（不断字符）
      src: '```txt\n短\n' + 'X'.repeat(4000) + '\n```',
      expect: { longLine: true },
    },
    {
      name: 'md-inline-html-escaped',
      // S02：Markdown 内嵌 HTML 一律字面文本（可见、不成元素）
      src: '前 <script>window.__MD_PWN__=1</script> 后\n\n<img src=x onerror="window.__MD_PWN__=2">\n\n<b>真粗？</b> 否',
      expect: { literalVisible: true },
    },
    {
      name: 'md-hostile-links',
      // S05：危险 scheme 链接不得成为可点击 href
      src: '[js](javascript:window.__MD_PWN__=3) [data](data:text/html,x) [rel](/etc/passwd) [ok](https://ok.example/x)',
      expect: { safeHrefs: ['https://ok.example/x'] },
    },
  ];
}

/** P1-T06：敌意 HTML fixture（S03 清洗 + 零执行/零外联/零 native 断言的对象） */
export function hostileHtmlCases() {
  return [
    { name: 'h01-script-inline', src: '<p>ok1</p><script>window.__H01__=1</script>' },
    { name: 'h02-img-onerror', src: '<p>ok2</p><img src=x onerror="window.__H02__=1">' },
    { name: 'h03-event-attrs', src: '<p onclick="window.__H03__=1" onmouseover="window.__H03__=2">ok3</p><a href="https://ok.example/n" onfocus="window.__H03__=3">l</a>' },
    { name: 'h04-js-href', src: '<a href="javascript:window.__H04__=1">c</a>' },
    { name: 'h05-data-href', src: '<a href="data:text/html;base64,PHNjcmlwdD53aW5kb3cuX0gwNV9fPTg8L3NjcmlwdD4=">d</a>' },
    { name: 'h06-remote-img', src: '<p>ok6</p><img src="https://evil.example/x.png" alt="a">' },
    { name: 'h07-style-url', src: '<div style="background:url(https://evil.example/s)">ok7</div><p style="color:red">styled</p>' },
    { name: 'h08-iframe', src: '<iframe src="https://evil.example/f"></iframe><p>ok8</p>' },
    { name: 'h09-svg', src: '<svg><animate onbegin="window.__H09__=1"/></svg><p>ok9</p>' },
    { name: 'h10-form', src: '<form action="https://evil.example"><input type=submit><textarea>t</textarea></form><p>ok10</p>' },
    { name: 'h11-meta-refresh', src: '<meta http-equiv="refresh" content="0;url=https://evil.example/"><p>ok11</p>' },
    { name: 'h12-base', src: '<base href="https://evil.example/"><p>ok12</p>' },
    { name: 'h13-noscript-bypass', src: '<p><noscript><p title="</noscript><img src=x onerror=window.__H13__=1>"></noscript></p>' },
    { name: 'h14-mxss-listing', src: '<listing>&lt;img src=x onerror=window.__H14__=1&gt;</listing><p>ok14</p>' },
    { name: 'h15-mxss-svg-lowercase', src: '<svg></p><style><a id="</style><img src=1 onerror=window.__H15__=1>"></svg><p>ok15</p>' },
    { name: 'h16-link-import', src: '<link rel="stylesheet" href="https://evil.example/s.css"><p>ok16</p>' },
    { name: 'h17-object', src: '<object data="https://evil.example/o"></object><embed src="https://evil.example/e"><p>ok17</p>' },
    { name: 'h18-video-source', src: '<video src="https://evil.example/v"></video><audio src="https://evil.example/a"></audio><source src="https://evil.example/s"><p>ok18</p>' },
    { name: 'h19-cdata-comment', src: '<!-- <script>window.__H19__=1</script> --><![CDATA[<script>window.__H19__=2</script>]]><p>ok19</p>' },
    { name: 'h20-attr-inject', src: '<p a="1"b="2">ok20</p><a HREF="JaVaScRiPt:window.__H20__=1">mix</a><a href="  https://ok.example/spaces  ">trim</a>' },
  ];
}

/** P1-T06：结构化 HTML fixture（S03 白名单保真 + S04 投影黄金值） */
export function structuredHtmlCases() {
  return [
    {
      name: 'html-structured',
      src: '<h2>H2 标题</h2><p>段 <b>粗</b> <i>斜</i></p>'
        + '<ol start="5"><li>five</li><li>six</li></ol>'
        + '<pre>line1\n  line2 keep</pre>'
        + '<blockquote><p>引用段</p></blockquote>'
        + '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
        + '<hr><p><a href="https://ok.example/t">尾链</a></p>',
      // S04 投影黄金值（独立手推；规则见 rich-text.js plainProjection 注释）
      expectProjection: 'H2 标题\n\n段 粗 斜\n\n5. five\n6. six\n\nline1\n  line2 keep\n\n> 引用段\n\n| a | b |\n| 1 | 2 |\n\n---\n\n尾链',
    },
  ];
}
