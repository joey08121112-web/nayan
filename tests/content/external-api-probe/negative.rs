// P1-R1-F01 外部调用方负例：对私有字段赋值必须【编译失败】，且诊断指向具体私有字段（E0616）。
// 由 run.sh 在隔离临时 crate 中以 #[path] 导入真实 content.rs 编译；任何编译错误都当成功=不允许，
// 脚本会核对诊断包含 "field ... of struct ... is private"。
#[path = "../../../../app/src-tauri/src/content.rs"]
mod content;

use content::{AcquisitionKind, CapturedContent, DeclaredFormat, FormatProvenance, Original};

fn main() {
    let mut c = CapturedContent::from_legacy_quote("old\r\nanswer", "r1").unwrap();
    // 以下每一行都应编译失败（私有字段）：
    c.original = Original::Text { text: "new\r\nanswer".into() };
    c.format = DeclaredFormat::Markdown;
    c.schema_version = 99;
    c.request_id = String::new();
    let _ = &mut c.fidelity;
    println!("{}", c.request_id());
}
