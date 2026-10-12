// 正向对照：只读 getter 调用必须可编译并正确运行（证明私有化没有误伤合法访问）。
#[path = "../../../../app/src-tauri/src/content.rs"]
mod content;

use content::{AcquisitionKind, CapturedContent, CopyResult, CopyTarget, Original};

fn main() {
    let c = CapturedContent::from_legacy_quote("old\r\nanswer", "r1").unwrap();
    assert_eq!(c.schema_version(), 1);
    assert_eq!(c.request_id(), "r1");
    assert_eq!(c.format_provenance(), content::FormatProvenance::LegacyAssumedPlain);
    assert_eq!(c.acquisition(), AcquisitionKind::LegacyImport);
    match c.original() {
        Original::Text { text } => assert_eq!(text, "old\r\nanswer"),
        _ => panic!(),
    }
    assert_eq!(c.canonical(), Some("old\nanswer"));
    // copy 与 original 同源
    match c.copy(CopyTarget::PlainResponse) {
        CopyResult::Text(t) => assert_eq!(t, "old\nanswer"),
        _ => panic!(),
    }
    match c.copy(CopyTarget::OriginalText) {
        CopyResult::Text(t) => assert_eq!(t, "old\r\nanswer"),
        _ => panic!(),
    }
    // 合法值 Serialize→Deserialize 一致
    let json = serde_json::to_string(&c).unwrap();
    let back: CapturedContent = serde_json::from_str(&json).unwrap();
    assert_eq!(back, c);
    println!("positive: OK");
}
