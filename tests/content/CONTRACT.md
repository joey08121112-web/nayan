# CapturedContent 值契约（P1-T01 / S01–S04）

被测实现：`app/src-tauri/src/content.rs`（真实 Rust，无第二份归一化副本）。
本目录只含契约文档、fixtures、golden envelopes 与复现命令。

## 字段语义（S01）

| 字段 | 来源 | 空/未知语义 | 不可变性 |
|---|---|---|---|
**字段可见性（P1-R1-F01）**：`CapturedContent` **全部字段私有**，外部仅经只读 getter（`schema_version()/request_id()/format()/format_provenance()/acquisition()/original()/fidelity()/canonical()/plain_projection()`）访问；无任何可变入口或可变借用出口——合法公开操作不可能制造 original/canonical/projection 不一致的 envelope（外部 compile-fail 探针：`external-api-probe/run.sh`，负例断言 E0616 私有字段诊断、正例验证只读调用）。构造与反序列化共用组合校验：`legacy_assumed_plain + markdown/html` 一律拒绝（legacy 永远 plain，不猜格式）。

| 字段 | 来源 | 空/未知语义 | 访问 |
|---|---|---|---|
| `schema_version` | 常量 `1` | 反序列化遇未知版本**显式拒绝**（不静默升级） | 常量 getter |
| `request_id` | 调用方赋予 | 必须非空（空白也算空），否则构造失败 | getter（&str） |
| `format` | **显式输入**（plain/markdown/html） | 未知格式字符串在反序列化时拒绝；绝不扫描内容猜格式 | getter（enum） |
| `format_provenance` | `declared` 或 `legacy_assumed_plain`（旧库假定 plain/unknown；legacy 永不自动重释为 Markdown——矛盾组合在构造/反序列化两侧均拒绝） | — | getter |
| `acquisition` | 采集通道分类（ax_selection/region_ocr/clipboard/extension_dom/mcp/manual/legacy_import）。**仅分类，不含来源身份置信度** | — | getter |
| `original` | `Text{text}`（逐 codepoint）或 `Bytes{bytes, charset_hint?}`（逐字节；RTF 等不伪装成 String） | 空 `Text("")` 合法；whitespace-only 不得清空 | getter（&Original，只读借用） |
| `fidelity.truncated` | 内容质量标记（构造路径不做截断，按入参记录） | — | getter（Copy） |
| `canonical` | **派生值**（构造器计算，S03） | 二进制 original → None + reason | getter；反序列化重算核对，篡改即拒绝 |
| `plain_projection` | 派生值：Plain/Markdown+Text → `available`=canonical；Html → `unavailable`（sanitizer 未实现，显式拒绝伪投影）；Bytes → `unavailable` | — | getter |

## 规范化规则（S03，唯一默认）

`canonicalize_text`：`CRLF→LF`、独立 `CR→LF`；**其余一切字符/空格/tab/空行原样**。纯函数、确定性、幂等。
一致性策略：派生只发生在构造器；字段私有只读；信封反序列化时重算并要求逐字段相等（envelope 不一致即拒绝入境）——不依赖调用方记住约定。

## 复制矩阵（S04；返回值契约，不接系统剪贴板/文件导出 UI）

**Copy Response 格式策略（P1-R1-F02 修正，遵守 VALIDATION 共享规则）**：普通/纯文本响应复制按声明格式选择语义——plain=canonical；Markdown=canonical Markdown 源；**Html=结构化 plain projection，无投影显式 Unsupported**（canonical 只是行规范化源码，不得冒充响应复制回退；读取源码用独立命名的 `canonical()` getter 或 Copy Original）。

| CopyTarget | 文本 plain | 文本 markdown | 文本 html | Bytes original |
|---|---|---|---|---|
| `PlainResponse` | canonical | canonical | **Unsupported（无投影）** | Unsupported（提示走导出语义） |
| `MarkdownSource` | Unsupported（非 markdown 拒绝） | canonical | Unsupported | Unsupported |
| `StructuredPlain` | canonical | canonical | **Unsupported（sanitizer 未实现）** | Unsupported |
| `OriginalText` | 原文逐字符 | 原文逐字符 | **原文源码逐字符** | `BinaryExport{bytes, charset_hint}`（导出语义，不假装普通文本复制） |

## legacy 兼容边界（S04）

`from_legacy_quote(quote, request_id)`：quote 字符串本身原样进入 `original`（plain/unknown，`legacy_assumed_plain` + `legacy_import`），可派生 canonical；**纯函数不回写数据库、不猜 Markdown**；本批不把新策略接入现有 reader——Phase 0 的旧 quote 精确复制行为不变（可撤回性）。

## fixtures / golden（B01–B14 契约层 + 边界）

20 例（P1-R1-F03 补长行后）。**VALIDATION B 编号 ↔ fixture 名映射**（首版报告「长行合并入 b12」的表述不准确，特此修正映射：b12-cjk-en 实为 B11 中英混排的取值，B12 长行此前缺失、本批补齐）：

| VALIDATION | fixture | 备注 |
|---|---|---|
| B01 段落行 | b01-paragraph-lines.txt | |
| B02 空行 | b02-blank-lines.txt | 连续空行保留 |
| B03 CRLF | b03-crlf.txt | |
| B04 CR | b04-cr.txt | |
| B05 缩进 | b06-indentation.txt | **映射修正**：首版把 B05 缩进记在 b06 名下（命名错位 1 位，输入本身正确） |
| B06 围栏 | b07-fenced-code.md | |
| B07 嵌套列表 | b08-nested-lists.md | |
| B08 有序非 1 起 | b09-ordered-non1.md | |
| B09 分隔线 | b10-separator.md | |
| B10 中点 | b11-middle-dot.txt | |
| B11 中英混排 | b12-cjk-en.txt | 首版报告误称此为长行 |
| **B12 长代码行** | **b12-long-code-line.rs.txt（本批新增）** | 单行 20117 字节/16369 字符，含 CJK/emoji/尾随空白；专项测试 long_code_line_no_truncation_or_reflow 断言无截断/无折行/空白不改写/round-trip 精确 |
| B13 组合字符/emoji | b13-unicode-combining-emoji.txt | |
| B14 引号+hostile HTML | b14-quotes-hostile.txt | |
| 边界 | ws-only / empty-body / legacy-looks-md / html-source / rtf-sample | whitespace、空正文、legacy plain/unknown、投影不可用、非 UTF-8 bytes |

注：上表 B05–B11 的 fixture 文件名与 VALIDATION 编号存在一位错位（文件名 b06..b12 对应 B05..B11）——输入内容与覆盖本身无误，映射以本表为准；不改文件名以免动旧 fixture 字节。

**golden 独立性**：golden JSON 由生成脚本按「文档化规则」从原始 fixture 字节推导（CRLF/CR→LF；Html 投影 unavailable；legacy→plain/unknown+legacy_import），**不从待测 Rust 输出生成**；生成后人工抽查关键字段（b03/legacy/ws-only 的 canonical repr 见批次证据）并冻结。测试运行时只读 golden，绝不回写；如契约变更需更新 golden，必须在报告中显式说明差异，禁止悄悄改期望掩盖变化。
**声明**：这些是**契约层单元/集成断言**，不是 DOM 渲染或 HTML 安全验证（后者属 P1-T05/T06）。

## 复现命令（cwd = app/src-tauri）

```sh
cargo test --offline content::            # 17 个内容契约测试（含长行专项、组合负例、全格式矩阵）
cargo test --offline -- --list | grep content::   # 清单
bash tests/content/external-api-probe/run.sh      # 外部 compile-fail 探针（负例 E0616 + 正例对照）
```

## 支持与不支持（本批）

- 支持：plain/markdown 文本与二进制 original 的无损表达、canonical 派生、复制策略返回值、legacy adapter。
- 不支持（显式）：HTML sanitizer/结构化投影（Unavailable）、RTF→文本解码、格式猜测、来源会话识别、数据库迁移、渲染接入。
