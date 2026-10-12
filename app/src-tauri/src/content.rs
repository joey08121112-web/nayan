//! CapturedContent 值契约（P1-T01 / S01–S04）
//!
//! 定位：内容原始表示、派生规范文本与复制策略的**可测试值模型**，独立于捕获路线与存储。
//! 本批不接 UI/剪贴板/渲染器/数据库——`main.rs` 仅声明模块。
//!
//! S01 显式契约：
//! - 格式（Plain/Markdown/Html）是**显式输入**，绝不由内容扫描（#、---、反引号）猜测。
//! - `format_provenance` 区分「生产方声明」与「legacy 库假定 plain」（legacy quote 永不
//!   被自动重释为 Markdown）。
//! - 未知 schema_version / 未知格式字符串在反序列化时**显式拒绝**。
//! - Html 的 plain projection 依赖未来 sanitizer；本批未实现 → `Unavailable`（显式），
//!   绝不用正则去标签假充投影。
//! - `acquisition` 只描述采集通道种类，不携带「来源身份置信度」（那是 Phase 3 概念）。
//! - `fidelity.truncated` 是内容质量标记，与来源身份置信度无关。
//!
//! S02 原始不改写：`Original::Text` 逐 codepoint 保留（无 trim/NFC/空行折叠/CR 删除）；
//! `Original::Bytes` 逐字节保留（RTF 等非 UTF-8 载荷不伪装成 String）。whitespace-only
//! 原文不会被改写为空串。序列化只改变 JSON 外观，round-trip 后载荷逐字符/逐字节相同。
//!
//! S03 canonical 为派生值：唯一默认规范化 = CRLF→LF、独立 CR→LF，其余一切字符原样。
//! 派生发生在构造器内；canonical/projection 字段私有只读，反序列化时重算并核对一致性
//! （篡改 envelope 中的派生值会被拒绝）→ 不存在「调用方可任意改派生值」的口子。
//!
//! S04 copy 策略（返回值契约，不接系统剪贴板）：
//! - PlainResponse → canonical（文本 original 才有；二进制 → Unsupported）
//! - MarkdownSource → 仅 format==Markdown 时的 canonical
//! - StructuredPlain → plain projection（Html 未有 sanitizer 投影前为 Unsupported）
//! - OriginalText → 原始文本逐字符；Bytes original → BinaryExport（导出语义，不假装可做普通文本复制）
//! legacy adapter：`from_legacy_quote` 把旧 quote 原样作为 plain/unknown 进入模型，
//! 保留字符串本身、不回写数据库、不猜 Markdown；本批不把新策略接入现有 reader。

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

/// 声明格式：显式输入。未来新增格式 = 新枚举值 + 版本升级，不做字符串透传。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeclaredFormat {
    Plain,
    Markdown,
    /// 受约束 HTML：original 是**不可信**原始 HTML；本批不实现 sanitizer，
    /// 其 plain projection 显式 Unavailable（见 PlainProjection），与「已清洗可渲染」是两回事。
    Html,
}

/// 格式来源：生产方显式声明，或 legacy 库按共享规则假定的 plain/unknown。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormatProvenance {
    Declared,
    LegacyAssumedPlain,
}

/// 采集通道种类（仅分类，不含置信度）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcquisitionKind {
    AxSelection,
    RegionOcr,
    Clipboard,
    ExtensionDom,
    Mcp,
    Manual,
    LegacyImport,
}

/// 原始表示：文本（逐 codepoint）或字节（逐字节）。二者的复制语义不同（S04）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Original {
    Text { text: String },
    /// 例：RTF 字节流。不得强制解释为 UTF-8 / 伪装成 String。
    Bytes { bytes: Vec<u8>, #[serde(default)] charset_hint: Option<String> },
}

/// plain projection：可用，或显式不可用（带原因）。没有「用正则去标签」的中间态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PlainProjection {
    Available { text: String },
    Unavailable { reason: String },
}

/// 内容质量标记（与来源身份置信度是不同概念）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FidelityFlags {
    /// 原文是否曾被截断（本模型构造路径恒为按入参记录，不做截断）。
    pub truncated: bool,
}

/// 复制操作目标（S04）。命名沿用 VALIDATION 共享规则。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyTarget {
    PlainResponse,
    MarkdownSource,
    StructuredPlain,
    OriginalText,
}

/// 复制结果：文本载荷、二进制导出（导出语义）、或显式不支持（带原因）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopyResult {
    Text(String),
    BinaryExport { bytes: Vec<u8>, charset_hint: Option<String> },
    Unsupported(String),
}

/// CapturedContent 信封。canonical/plain_projection 为构造器派生的只读值；
/// 反序列化会重算并核对，防止 original 与派生值不一致的 envelope 入境。
/// 不变量由类型维护（P1-R1-F01）：**全部字段私有**，外部只能经只读 getter 访问；
/// 无任何可变入口（本任务不需要内容编辑），因此合法公开操作不可能制造
/// original/canonical/projection 不一致的 envelope。构造与反序列化共用同一组合校验。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CapturedContent {
    schema_version: u32,
    /// 采集请求标识（非空；由调用方赋予，用于跨阶段对账）。
    request_id: String,
    format: DeclaredFormat,
    format_provenance: FormatProvenance,
    acquisition: AcquisitionKind,
    original: Original,
    fidelity: FidelityFlags,
    canonical: Option<String>,
    canonical_unavailable_reason: Option<String>,
    plain_projection: PlainProjection,
}

/// S03：唯一默认规范化——CRLF→LF、独立 CR→LF；其余一切（空格/tab/空行/字符）原样。
/// 纯函数、确定性、幂等。
pub fn canonicalize_text(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// 合法组合校验（构造与反序列化共用，P1-R1-F01）：
/// LegacyAssumedPlain 的语义是「旧库按共享规则假定 plain/unknown」——
/// 与 Markdown/Html 声明自相矛盾（legacy 永远 plain，不猜格式），一律拒绝。
fn validate_combination(format: DeclaredFormat, provenance: FormatProvenance) -> Result<(), String> {
    if provenance == FormatProvenance::LegacyAssumedPlain && format != DeclaredFormat::Plain {
        return Err(format!(
            "矛盾组合：format_provenance=legacy_assumed_plain 只允许 format=plain（legacy 永不自动重释为 {:?}）",
            format
        ));
    }
    Ok(())
}

impl CapturedContent {
    /// 唯一构造路径：显式入参 + 组合校验 + 派生 canonical/projection，保证信封一致性。
    pub fn new(
        request_id: impl Into<String>,
        format: DeclaredFormat,
        format_provenance: FormatProvenance,
        acquisition: AcquisitionKind,
        original: Original,
        truncated: bool,
    ) -> Result<Self, String> {
        let request_id = request_id.into();
        if request_id.trim().is_empty() {
            return Err("request_id 不能为空".into());
        }
        validate_combination(format, format_provenance)?;
        let (canonical, canonical_unavailable_reason, plain_projection) = match &original {
            Original::Text { text } => {
                let c = canonicalize_text(text);
                // Plain/Markdown 的结构化 plain 投影 = canonical（本批范围内二者皆为纯文本语义）；
                // Html 的投影依赖未来 sanitizer——显式不可用，不用正则去标签假充。
                let projection = match format {
                    DeclaredFormat::Html => PlainProjection::Unavailable {
                        reason: "html sanitizer 未实现：结构化 plain projection 不可用（本批契约显式拒绝伪投影）".into(),
                    },
                    _ => PlainProjection::Available { text: c.clone() },
                };
                (Some(c), None, projection)
            }
            Original::Bytes { .. } => (
                None,
                Some("二进制 original 无文本 canonical（需按声明的 charset 语义另行解码，本批不猜测）".into()),
                PlainProjection::Unavailable {
                    reason: "二进制 original 无文本投影".into(),
                },
            ),
        };
        Ok(Self {
            schema_version: SCHEMA_VERSION,
            request_id,
            format,
            format_provenance,
            acquisition,
            original,
            fidelity: FidelityFlags { truncated },
            canonical,
            canonical_unavailable_reason,
            plain_projection,
        })
    }

    /// legacy adapter（S04）：旧 quote 原样进入模型——plain/unknown、不猜 Markdown、
    /// 纯函数不回写数据库。canonical 可派生；复制行为与 Phase 0 reader 现状解耦。
    pub fn from_legacy_quote(quote: &str, request_id: impl Into<String>) -> Result<Self, String> {
        Self::new(
            request_id,
            DeclaredFormat::Plain,
            FormatProvenance::LegacyAssumedPlain,
            AcquisitionKind::LegacyImport,
            Original::Text { text: quote.to_string() },
            false,
        )
    }

    pub fn schema_version(&self) -> u32 {
        self.schema_version
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn format(&self) -> DeclaredFormat {
        self.format
    }

    pub fn format_provenance(&self) -> FormatProvenance {
        self.format_provenance
    }

    pub fn acquisition(&self) -> AcquisitionKind {
        self.acquisition
    }

    pub fn original(&self) -> &Original {
        &self.original
    }

    pub fn fidelity(&self) -> FidelityFlags {
        self.fidelity
    }

    pub fn canonical(&self) -> Option<&str> {
        self.canonical.as_deref()
    }

    pub fn canonical_unavailable_reason(&self) -> Option<&str> {
        self.canonical_unavailable_reason.as_deref()
    }

    pub fn plain_projection(&self) -> &PlainProjection {
        &self.plain_projection
    }

    /// S04：按共享规则返回复制载荷（不接系统剪贴板）。
    pub fn copy(&self, target: CopyTarget) -> CopyResult {
        match target {
            CopyTarget::PlainResponse => match self.format {
                // P1-R1-F02：Html 的「普通/纯文本响应复制」= 结构化 plain projection；
                // 无投影（sanitizer 未实现）→ 显式 Unsupported。canonical 只是行规范化的
                // 源码形态，不得冒充响应复制回退；读取源码走 canonical()/OriginalText。
                DeclaredFormat::Html => match &self.plain_projection {
                    PlainProjection::Available { text } => CopyResult::Text(text.clone()),
                    PlainProjection::Unavailable { reason } => CopyResult::Unsupported(format!(
                        "Html 普通响应复制需要结构化 plain projection：{}（原始源码请用 Copy Original / canonical() 读取）",
                        reason
                    )),
                },
                DeclaredFormat::Plain | DeclaredFormat::Markdown => match (&self.original, self.canonical.as_deref()) {
                    (Original::Text { .. }, Some(c)) => CopyResult::Text(c.to_string()),
                    (Original::Bytes { bytes, .. }, None) => CopyResult::Unsupported(format!(
                        "二进制 original（{} bytes）无文本 canonical：走 Copy Original 的导出语义，不假装普通文本复制",
                        bytes.len()
                    )),
                    (Original::Text { .. }, None) => CopyResult::Unsupported("canonical 不可用".into()),
                    (Original::Bytes { .. }, Some(_)) => CopyResult::Unsupported("不可能状态：bytes 与 canonical 并存".into()),
                },
            },
            CopyTarget::MarkdownSource => {
                if self.format == DeclaredFormat::Markdown {
                    match self.canonical.as_deref() {
                        Some(c) if matches!(self.original, Original::Text { .. }) => CopyResult::Text(c.to_string()),
                        _ => CopyResult::Unsupported("Markdown 声明但 original 为二进制：无 canonical Markdown 源".into()),
                    }
                } else {
                    CopyResult::Unsupported(format!("format 非 markdown（{:?}），拒绝把非 Markdown 内容当 Markdown 复制", self.format))
                }
            }
            CopyTarget::StructuredPlain => match &self.plain_projection {
                PlainProjection::Available { text } => CopyResult::Text(text.clone()),
                PlainProjection::Unavailable { reason } => CopyResult::Unsupported(reason.clone()),
            },
            CopyTarget::OriginalText => match &self.original {
                Original::Text { text } => CopyResult::Text(text.clone()),
                Original::Bytes { bytes, charset_hint } => CopyResult::BinaryExport {
                    bytes: bytes.clone(),
                    charset_hint: charset_hint.clone(),
                },
            },
        }
    }
}

/// 反序列化走 Raw 镜像 + 一致性校验：未知版本拒绝；派生值必须与重算结果一致。
#[derive(Debug, Deserialize)]
struct CapturedContentRaw {
    schema_version: u32,
    request_id: String,
    format: DeclaredFormat,
    format_provenance: FormatProvenance,
    acquisition: AcquisitionKind,
    original: Original,
    #[serde(default)]
    fidelity: FidelityFlagsDefault,
    canonical: Option<String>,
    #[serde(default)]
    canonical_unavailable_reason: Option<String>,
    plain_projection: PlainProjection,
}

#[derive(Debug, Default, Deserialize)]
struct FidelityFlagsDefault {
    #[serde(default)]
    truncated: bool,
}

impl TryFrom<CapturedContentRaw> for CapturedContent {
    type Error = String;
    fn try_from(raw: CapturedContentRaw) -> Result<Self, Self::Error> {
        if raw.schema_version != SCHEMA_VERSION {
            return Err(format!(
                "未知 schema_version {}（支持 {}）——拒绝，不做静默升级",
                raw.schema_version, SCHEMA_VERSION
            ));
        }
        if raw.request_id.trim().is_empty() {
            return Err("request_id 不能为空".into());
        }
        let rebuilt = CapturedContent::new(
            raw.request_id,
            raw.format,
            raw.format_provenance,
            raw.acquisition,
            raw.original,
            raw.fidelity.truncated,
        )?;
        if rebuilt.canonical != raw.canonical
            || rebuilt.canonical_unavailable_reason != raw.canonical_unavailable_reason
            || rebuilt.plain_projection != raw.plain_projection
        {
            return Err("envelope 不一致：canonical/projection 与 original 的派生结果不符——拒绝入境".into());
        }
        Ok(rebuilt)
    }
}

impl<'de> Deserialize<'de> for CapturedContent {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        CapturedContentRaw::deserialize(d)?
            .try_into()
            .map_err(serde::de::Error::custom)
    }
}

// ============================================================================
// 单元测试（契约层；fixtures/golden 集成测试见文末 read_fixtures_golden）
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "t-req";

    /// S02：文本原文 round-trip 逐字符相同（含空白/空行/缩进/组合字符全保留）。
    #[test]
    fn original_text_round_trip_preserves_every_codepoint() {
        let raw = "  缩进\t保持\n\n\n空白行不折叠\r\nCRLF原文保留\x00控制符é\u{301}🐱";
        let c = CapturedContent::new(T, DeclaredFormat::Plain, FormatProvenance::Declared, AcquisitionKind::Manual, Original::Text { text: raw.into() }, false).unwrap();
        let json = serde_json::to_string(&c).unwrap();
        let back: CapturedContent = serde_json::from_str(&json).unwrap();
        match (&c.original, &back.original) {
            (Original::Text { text: a }, Original::Text { text: b }) => assert_eq!(a, b, "原文逐字符相同"),
            _ => panic!("kind 漂移"),
        }
    }

    /// S02：二进制（非 UTF-8）原文 round-trip 逐字节相同；不伪装成 String。
    #[test]
    fn original_bytes_round_trip_preserves_every_byte() {
        let bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0xFF, 0xFE, b'{', b'\\', b'r', b't', b'f', b'1'];
        let c = CapturedContent::new(T, DeclaredFormat::Plain, FormatProvenance::Declared, AcquisitionKind::Clipboard, Original::Bytes { bytes: bytes.clone(), charset_hint: Some("rtf".into()) }, false).unwrap();
        let json = serde_json::to_string(&c).unwrap();
        let back: CapturedContent = serde_json::from_str(&json).unwrap();
        match (&c.original, &back.original) {
            (Original::Bytes { bytes: a, .. }, Original::Bytes { bytes: b, .. }) => assert_eq!(a, b),
            _ => panic!("kind 漂移"),
        }
        assert!(back.canonical().is_none());
    }

    /// S03：CRLF/CR/混合 → LF；幂等；空格/tab/空行/其他字符原样。
    #[test]
    fn canonical_newline_normalization_is_exact_and_idempotent() {
        assert_eq!(canonicalize_text("a\r\nb"), "a\nb");
        assert_eq!(canonicalize_text("a\rb"), "a\nb");
        assert_eq!(canonicalize_text("a\r\n\rb\n\r\nb"), "a\n\nb\n\nb");
        let mixed = "x\r\ny\rz\nw\r\n\r";
        let once = canonicalize_text(mixed);
        assert_eq!(canonicalize_text(&once), once, "幂等");
        let keep = "  \t  spaces\ttabs\n\n\n\nblank lines stay";
        assert_eq!(canonicalize_text(keep), keep);
        assert_eq!(canonicalize_text(""), "");
    }

    /// S03：whitespace-only 原文不被清空；original 不被 canonical 覆盖。
    #[test]
    fn whitespace_only_original_survives_and_original_never_overwritten() {
        let ws = "   \t \n  \r\n ";
        let c = CapturedContent::from_legacy_quote(ws, T).unwrap();
        match &c.original {
            Original::Text { text } => assert_eq!(text, ws, "whitespace-only 逐字符保留"),
            _ => panic!(),
        }
        assert_eq!(c.canonical(), Some("   \t \n  \n "), "仅换行规范化");
    }

    /// S01+S04：Html 的投影显式不可用（无正则伪投影）；StructuredPlain 拒绝。
    #[test]
    fn html_projection_explicitly_unavailable() {
        let c = CapturedContent::new(T, DeclaredFormat::Html, FormatProvenance::Declared, AcquisitionKind::ExtensionDom, Original::Text { text: "<p>hi <b>粗</b></p><script>alert(1)</script>".into() }, false).unwrap();
        assert!(matches!(c.plain_projection(), PlainProjection::Unavailable { .. }));
        match c.copy(CopyTarget::StructuredPlain) {
            CopyResult::Unsupported(r) => assert!(r.contains("sanitizer")),
            other => panic!("Html 结构化投影必须 Unsupported：{:?}", other),
        }
        // canonical（行规范化源码）与投影是两回事：Html 仍有行规范化的源 canonical
        assert_eq!(c.canonical(), Some("<p>hi <b>粗</b></p><script>alert(1)</script>"));
    }

    /// S01：未知 schema_version 显式拒绝（仅此一个非法字段，格式保持合法）。
    #[test]
    fn unknown_version_alone_rejected() {
        let c = CapturedContent::from_legacy_quote("x", T).unwrap();
        let json = serde_json::to_string(&c).unwrap().replace("\"schema_version\":1", "\"schema_version\":99");
        let err = serde_json::from_str::<CapturedContent>(&json).unwrap_err();
        assert!(err.to_string().contains("schema_version"), "{}", err);
    }

    /// S01：未知格式字符串显式拒绝（版本保持合法，仅格式非法）。
    #[test]
    fn unknown_format_alone_rejected() {
        let c = CapturedContent::from_legacy_quote("x", T).unwrap();
        let json = serde_json::to_string(&c).unwrap().replace("\"format\":\"plain\"", "\"format\":\"rtf\"");
        assert!(serde_json::from_str::<CapturedContent>(&json).is_err(), "未知格式必须拒绝");
    }

    /// P1-R1-F01：矛盾 legacy 组合——构造器与反序列化都必须拒绝
    /// LegacyAssumedPlain + Markdown/Html；合法 legacy（Plain）对照通过。
    #[test]
    fn contradictory_legacy_combination_rejected_both_paths() {
        for bad_format in [DeclaredFormat::Markdown, DeclaredFormat::Html] {
            let err = CapturedContent::new(T, bad_format, FormatProvenance::LegacyAssumedPlain, AcquisitionKind::LegacyImport, Original::Text { text: "# x".into() }, false).unwrap_err();
            assert!(err.contains("矛盾组合"), "{}", err);
        }
        // 反序列化路径：合法 envelope 改 provenance 为 legacy_assumed_plain → 拒绝
        let m = CapturedContent::new(T, DeclaredFormat::Markdown, FormatProvenance::Declared, AcquisitionKind::Mcp, Original::Text { text: "# x".into() }, false).unwrap();
        let json = serde_json::to_string(&m).unwrap().replace("\"format_provenance\":\"declared\"", "\"format_provenance\":\"legacy_assumed_plain\"");
        let err = serde_json::from_str::<CapturedContent>(&json).unwrap_err();
        assert!(err.to_string().contains("矛盾组合"), "{}", err);
        // 合法 legacy 对照：from_legacy_quote 仍可用且 round-trip
        let ok = CapturedContent::from_legacy_quote("legacy ok", T).unwrap();
        let rt: CapturedContent = serde_json::from_str(&serde_json::to_string(&ok).unwrap()).unwrap();
        assert_eq!(rt, ok);
    }

    /// P1-R1-F02：全格式 × 全 CopyTarget 矩阵（字符串载荷层）。
    #[test]
    fn full_copy_matrix_by_format() {
        let mk = |fmt: DeclaredFormat, orig: Original| CapturedContent::new(T, fmt, FormatProvenance::Declared, AcquisitionKind::Manual, orig, false).unwrap();
        // Plain 文本（原文含 CRLF：\r\n 经转义书写，验证 OriginalText 原样 vs canonical 规范化）
        let p = mk(DeclaredFormat::Plain, Original::Text { text: "p\r\nq".into() });
        assert_eq!(p.copy(CopyTarget::PlainResponse), CopyResult::Text("p\nq".into()));
        assert!(matches!(p.copy(CopyTarget::MarkdownSource), CopyResult::Unsupported(_)));
        assert_eq!(p.copy(CopyTarget::StructuredPlain), CopyResult::Text("p\nq".into()));
        assert_eq!(p.copy(CopyTarget::OriginalText), CopyResult::Text("p\r\nq".into()));
        // Markdown 文本
        let m = mk(DeclaredFormat::Markdown, Original::Text { text: "# t".into() });
        assert_eq!(m.copy(CopyTarget::PlainResponse), CopyResult::Text("# t".into()));
        assert_eq!(m.copy(CopyTarget::MarkdownSource), CopyResult::Text("# t".into()));
        assert_eq!(m.copy(CopyTarget::StructuredPlain), CopyResult::Text("# t".into()));
        assert_eq!(m.copy(CopyTarget::OriginalText), CopyResult::Text("# t".into()));
        // Html 文本：PlainResponse/StructuredPlain 均 Unsupported（无投影）；
        // OriginalText 精确返回原始源码；canonical() 仍可读行规范化源码（独立命名接口，不冒充响应复制）。
        let h = mk(DeclaredFormat::Html, Original::Text { text: "<h1>K</h1>\r\n<script>x()</script>".into() });
        for t in [CopyTarget::PlainResponse, CopyTarget::StructuredPlain] {
            match h.copy(t) {
                CopyResult::Unsupported(r) => assert!(r.contains("projection") || r.contains("sanitizer"), "{}", r),
                other => panic!("Html {:?} 必须 Unsupported：{:?}", t, other),
            }
        }
        assert_eq!(h.copy(CopyTarget::OriginalText), CopyResult::Text("<h1>K</h1>\r\n<script>x()</script>".into()));
        assert_eq!(h.canonical(), Some("<h1>K</h1>\n<script>x()</script>"));
        assert!(matches!(h.copy(CopyTarget::MarkdownSource), CopyResult::Unsupported(_)));
        // Bytes（plain 声明）
        let b = mk(DeclaredFormat::Plain, Original::Bytes { bytes: vec![0xFF], charset_hint: None });
        for t in [CopyTarget::PlainResponse, CopyTarget::MarkdownSource, CopyTarget::StructuredPlain] {
            assert!(matches!(b.copy(t), CopyResult::Unsupported(_)), "{:?} bytes 应 Unsupported", t);
        }
        assert_eq!(b.copy(CopyTarget::OriginalText), CopyResult::BinaryExport { bytes: vec![0xFF], charset_hint: None });
    }

    /// P1-R1-F01 目标回归：合法公开操作（构造+只读）后 Serialize→Deserialize 保持一致、
    /// copy 永不陈旧——即「旧 original/新 canonical 不一致」无法由合法 API 产生。
    #[test]
    fn legal_api_never_produces_stale_divergence() {
        let c = CapturedContent::from_legacy_quote("old answer", T).unwrap();
        // 只读快照后序列化-反序列化：一致
        let rt: CapturedContent = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(rt, c);
        // copy 与 original/canonical 同源（无中间可变窗口）
        match (c.original(), c.copy(CopyTarget::PlainResponse)) {
            (Original::Text { text }, CopyResult::Text(resp)) => assert_eq!(&canonicalize_text(text), &resp),
            other => panic!("{:?}", other),
        }
    }

    /// S03：篡改 envelope 中的 canonical 会被一致性校验拒绝。
    #[test]
    fn tampered_envelope_rejected() {
        let c = CapturedContent::from_legacy_quote("a\r\nb", T).unwrap();
        let json = serde_json::to_string(&c).unwrap();
        let tampered = json.replace("\"canonical\":\"a\\nb\"", "\"canonical\":\"a b\"");
        assert!(serde_json::from_str::<CapturedContent>(&tampered).is_err(), "派生值被篡改必须拒绝");
    }

    /// S04：copy 矩阵（文本 plain / markdown / 二进制 / html）。
    #[test]
    fn copy_policy_matrix() {
        // plain 文本
        let p = CapturedContent::from_legacy_quote("plain\r\ntext", T).unwrap();
        assert_eq!(p.copy(CopyTarget::PlainResponse), CopyResult::Text("plain\ntext".into()));
        assert_eq!(p.copy(CopyTarget::OriginalText), CopyResult::Text("plain\r\ntext".into()));
        assert!(matches!(p.copy(CopyTarget::MarkdownSource), CopyResult::Unsupported(_)), "非 markdown 拒绝 MarkdownSource");
        // markdown：声明才可复制 canonical Markdown 源
        let m = CapturedContent::new(T, DeclaredFormat::Markdown, FormatProvenance::Declared, AcquisitionKind::Mcp, Original::Text { text: "# T\r\n- a".into() }, false).unwrap();
        assert_eq!(m.copy(CopyTarget::MarkdownSource), CopyResult::Text("# T\n- a".into()));
        assert_eq!(m.copy(CopyTarget::PlainResponse), CopyResult::Text("# T\n- a".into()));
        // 二进制：PlainResponse Unsupported；OriginalText → BinaryExport（导出语义）
        let b = CapturedContent::new(T, DeclaredFormat::Plain, FormatProvenance::Declared, AcquisitionKind::Clipboard, Original::Bytes { bytes: vec![0xFF, 0xD9], charset_hint: Some("rtf".into()) }, false).unwrap();
        assert!(matches!(b.copy(CopyTarget::PlainResponse), CopyResult::Unsupported(_)));
        match b.copy(CopyTarget::OriginalText) {
            CopyResult::BinaryExport { bytes, charset_hint } => {
                assert_eq!(bytes, vec![0xFF, 0xD9]);
                assert_eq!(charset_hint.as_deref(), Some("rtf"));
            }
            other => panic!("二进制 original 必须 BinaryExport：{:?}", other),
        }
    }

    /// S04：legacy adapter——原样进入、不猜 Markdown、无数据库写回（纯函数）。
    #[test]
    fn legacy_adapter_keeps_quote_verbatim_plain_unknown() {
        let quote = "# 看起来像 Markdown\r\n但 legacy 只当 plain/unknown\r保留原样";
        let c = CapturedContent::from_legacy_quote(quote, T).unwrap();
        assert_eq!(c.format, DeclaredFormat::Plain);
        assert_eq!(c.format_provenance, FormatProvenance::LegacyAssumedPlain);
        assert_eq!(c.acquisition, AcquisitionKind::LegacyImport);
        match &c.original {
            Original::Text { text } => assert_eq!(text, quote),
            _ => panic!(),
        }
        // 不猜 Markdown：即使原文含 #，MarkdownSource 仍拒绝
        assert!(matches!(c.copy(CopyTarget::MarkdownSource), CopyResult::Unsupported(_)));
    }

    /// 空正文（未来「附件型项」）在值模型可表达；空串不是错误。
    #[test]
    fn empty_body_expressible() {
        let c = CapturedContent::new(T, DeclaredFormat::Plain, FormatProvenance::Declared, AcquisitionKind::Manual, Original::Text { text: String::new() }, false).unwrap();
        assert_eq!(c.canonical(), Some(""));
        assert_eq!(c.copy(CopyTarget::PlainResponse), CopyResult::Text(String::new()));
    }

    /// request_id 校验。
    #[test]
    fn request_id_required() {
        assert!(CapturedContent::new("", DeclaredFormat::Plain, FormatProvenance::Declared, AcquisitionKind::Manual, Original::Text { text: "x".into() }, false).is_err());
    }

    /// P1-R1-F03：长代码行（B12 契约层取值：单行 20117 字节/16369 字符，含 CJK/emoji/尾随空白）。
    /// 独立断言：original/canonical/PlainResponse/OriginalText 均无截断、无折行（不引入 \n）、
    /// 空白不改写；round-trip 逐字符一致。
    #[test]
    fn long_code_line_no_truncation_or_reflow() {
        let base = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/content");
        let raw = std::fs::read(format!("{}/fixtures/b12-long-code-line.rs.txt", base)).unwrap();
        let text = String::from_utf8(raw.clone()).unwrap();
        let c = CapturedContent::new("req-b12long", DeclaredFormat::Plain, FormatProvenance::Declared, AcquisitionKind::Manual, Original::Text { text: text.clone() }, false).unwrap();
        assert_eq!(raw.len(), 20117, "fixture 字节数（独立预期）");
        assert_eq!(text.chars().count(), 16369, "fixture 字符数（独立预期）");
        let canon = c.canonical().unwrap();
        assert_eq!(canon.len(), text.len(), "canonical 无截断（无换行可规范化 → 与原文等长）");
        assert!(!canon.contains('\n'), "不引入折行");
        assert_eq!(canon, &text, "无换行原文：canonical 与 original 逐字符一致（含尾随空白）");
        match c.copy(CopyTarget::PlainResponse) {
            CopyResult::Text(t) => assert_eq!(t.len(), 20117),
            o => panic!("{:?}", o),
        }
        match c.copy(CopyTarget::OriginalText) {
            CopyResult::Text(t) => { assert_eq!(t, text); assert!(t.ends_with("尾随空白   ")); }
            o => panic!("{:?}", o),
        }
        let rt: CapturedContent = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(rt, c, "round-trip 精确");
    }

    /// 契约层 B01–B14 输入经真实实现序列化/反序列化 + canonical 与 golden 对账。
    /// fixtures/golden 由 tests/content/ 提供（预期独立定义，不从待测输出生成）。
    #[test]
    fn fixtures_golden_contract() {
        let base = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/content");
        let manifest_path = format!("{}/manifest.json", base);
        let manifest = std::fs::read_to_string(&manifest_path)
            .unwrap_or_else(|e| panic!("读取 manifest 失败 {}: {}", manifest_path, e));
        let cases: Vec<serde_json::Value> = serde_json::from_str(&manifest).unwrap();
        assert!(cases.len() >= 15, "fixture 覆盖不足：{}", cases.len());
        for case in &cases {
            let fixture: &str = case["fixture"].as_str().unwrap();
            let request_id: &str = case["request_id"].as_str().unwrap();
            let format_s: &str = case["format"].as_str().unwrap();
            let format = match format_s {
                "plain" => DeclaredFormat::Plain,
                "markdown" => DeclaredFormat::Markdown,
                "html" => DeclaredFormat::Html,
                other => panic!("manifest 未知格式 {}", other),
            };
            let provenance = if case.get("legacy").and_then(|v| v.as_bool()).unwrap_or(false) {
                FormatProvenance::LegacyAssumedPlain
            } else {
                FormatProvenance::Declared
            };
            let acquisition = match case["acquisition"].as_str().unwrap() {
                "manual" => AcquisitionKind::Manual,
                "clipboard" => AcquisitionKind::Clipboard,
                "extension_dom" => AcquisitionKind::ExtensionDom,
                "mcp" => AcquisitionKind::Mcp,
                other => panic!("manifest 未知 acquisition {}", other),
            };
            let bytes = std::fs::read(format!("{}/fixtures/{}", base, fixture))
                .unwrap_or_else(|e| panic!("读取 fixture {} 失败：{}", fixture, e));
            let original = if case["binary"].as_bool().unwrap_or(false) {
                Original::Bytes { bytes, charset_hint: case.get("charset_hint").and_then(|v| v.as_str()).map(|s| s.to_string()) }
            } else {
                let text = String::from_utf8(bytes.clone())
                    .unwrap_or_else(|e| panic!("文本 fixture {} 必须是合法 UTF-8：{}", fixture, e));
                Original::Text { text }
            };
            // 走 legacy adapter 或显式构造（真实实现，无第二份归一化副本）
            let content = if case["legacy"].as_bool().unwrap_or(false) {
                let Original::Text { text } = &original else { panic!("legacy fixture 必须文本") };
                CapturedContent::from_legacy_quote(text, request_id).unwrap()
            } else {
                CapturedContent::new(request_id, format, provenance, acquisition, original, false).unwrap()
            };
            // 1) golden envelope 对账（独立预期文件）
            let golden = std::fs::read_to_string(format!("{}/golden/{}.json", base, fixture))
                .unwrap_or_else(|e| panic!("读取 golden {} 失败：{}", fixture, e));
            let actual = serde_json::to_value(&content).unwrap();
            let golden_v: serde_json::Value = serde_json::from_str(&golden).unwrap();
            assert_eq!(actual, golden_v, "fixture {} 的 envelope 与 golden 不符", fixture);
            // 2) round-trip：序列化→反序列化，original 逐字节一致
            let json = serde_json::to_string(&content).unwrap();
            let back: CapturedContent = serde_json::from_str(&json).unwrap();
            assert_eq!(content.original, back.original, "{} round-trip 原文漂移", fixture);
            // 3) canonical 幂等（文本类）
            if let Original::Text { text } = &content.original {
                let c1 = canonicalize_text(text);
                assert_eq!(canonicalize_text(&c1), c1, "{} canonical 幂等", fixture);
            }
        }
    }
}
