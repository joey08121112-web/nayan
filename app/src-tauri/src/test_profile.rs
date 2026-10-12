//! 测试隔离配置与测试专用 HTTP 桥（P0-B01 / P0-T03；P0-B01-REPAIR-01 按 R1-F02/F03 硬化）
//!
//! 这是测试接缝，不是产品模块。目标：
//! 1. 显式测试入口 fail-closed：四个测试环境变量（ROOT/UI_DIR/PORT/RUN_ID）要么全部
//!    缺失（走生产，行为不变），要么全部存在且逐一通过校验；出现任意一个而其余缺失、
//!    路径非法、指向/经符号链接落入生产目录、marker 损坏或伪造——一律在 main() 里、
//!    任何 Tauri/Wry/WebView/插件资源创建之前以退出码 78 拒绝。
//! 2. 测试实例禁用副作用：单实例守卫（不占 58777、不激活生产实例）、全局热键、
//!    AX/框选捕获、剪贴板 watcher、开机自启修改、旧库迁移、外部 AI 调用；
//!    且测试模式清空 app.windows——不创建任何 WebView（含默认 WKWebsiteDataStore）。
//!    仅显式 NAYAN_TEST_NATIVE_CAPTURE_SOURCE + 完整四项校验允许有限原生验证：
//!    setup 创建 incognito 非持久 WK；同名来源 watcher ≤600s；其余副作用仍禁用。
//! 3. HTTP 桥把真实 `handle_api`（生产处理器 + 隔离 SQLite）暴露给测试用浏览器，
//!    并提供故障注入、copy sink 记录与 run 身份握手——仅绑定 127.0.0.1，仅测试模式。
//!
//! 所有权与清理：根目录由 `nayan-test-owned.json` 声明（含 owner 与创建 run 身份）；
//! 本模块不删除任何文件，清理由创建目录的 launcher 按 owner+路径组件前缀执行。

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Manager;

pub const ENV_ROOT: &str = "NAYAN_TEST_PROFILE";
pub const ENV_UI_DIR: &str = "NAYAN_TEST_UI_DIR";
pub const ENV_PORT: &str = "NAYAN_TEST_PORT";
pub const ENV_RUN_ID: &str = "NAYAN_TEST_RUN_ID";
/// 显式、有限的真实来源验证；不设时保留原无窗口/无剪贴板模式。
pub const ENV_NATIVE_SOURCE: &str = "NAYAN_TEST_NATIVE_CAPTURE_SOURCE";
pub const MARKER_FILE: &str = "nayan-test-owned.json";
pub const MARKER_OWNER: &str = "nayan-reader-regression";
pub const SINK_FILE: &str = "copy-sink.jsonl";
/// 生产单实例守卫端口：测试桥禁止占用
pub const SINGLETON_PORT: u16 = 58777;

/// 测试模式总开关（main() 在 Builder 之前置位；命令层与启动流程据此禁用副作用）
pub static TEST_MODE: AtomicBool = AtomicBool::new(false);

pub fn test_mode() -> bool {
    TEST_MODE.load(Ordering::Relaxed)
}

/// Only the explicitly source-bound owned native session can exercise region capture.
pub fn native_box_allowed() -> bool {
    test_mode() && std::env::var(ENV_NATIVE_SOURCE).ok().filter(|s| !s.trim().is_empty()).is_some()
}

#[derive(Clone, Debug)]
pub struct TestProfile {
    /// 测试根目录（DB/config/log/源文件 fixture 都在其下）
    pub root: PathBuf,
    pub db_path: PathBuf,
    pub cfg_path: PathBuf,
    pub log_path: PathBuf,
    /// 被测 UI 静态文件目录（生产 app/ui 的只读来源）
    pub ui_dir: PathBuf,
    pub http_port: u16,
    /// 本次进程的 run 身份（来自 ENV_RUN_ID；launcher 用 /__test/info 握手防串实例）
    pub run_id: String,
    /// 创建该根目录的 run（marker 记录；跨进程重启复用时与本 run 不同是正常的）
    pub marker_run_id: String,
    pub native_capture_source: Option<String>,
}

// ---------- 故障注入（仅测试桥使用，不影响 handle_api 本身） ----------

#[derive(Debug, Clone)]
struct FaultPlan {
    path_contains: String,
    /// "fail"：匹配请求立即 500；"delay"：延迟 ms 后放行；"fail_late"：延迟 ms 后 500
    ///（fail_late 用于制造「切换 reader 后错误才回来」的迟到错误场景）
    action: String,
    ms: u64,
    times: u32,
}

static FAULT: Mutex<Option<FaultPlan>> = Mutex::new(None);

fn set_fault(plan: FaultPlan) {
    *FAULT.lock().unwrap() = Some(plan);
}

fn take_fault(path: &str) -> Option<(String, u64)> {
    let mut g = FAULT.lock().unwrap();
    match g.as_mut() {
        Some(p) if path.contains(&p.path_contains) && p.times > 0 => {
            p.times -= 1;
            let out = (p.action.clone(), p.ms);
            if p.times == 0 {
                *g = None;
            }
            Some(out)
        }
        _ => None,
    }
}

// ---------- 入口解析与 fail-closed 校验（先于任何资源创建） ----------

fn err(msg: String) -> String {
    format!("[纳言测试入口] {}", msg)
}

fn valid_run_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn native_capture_source(present: usize, raw: Option<&str>) -> Result<Option<String>, String> {
    match raw {
        None => Ok(None),
        Some(s) if present == 4 && !s.trim().is_empty() && s.len() <= 64
            && !s.chars().any(|c| c.is_control() || c == '/' || c == '\\') => Ok(Some(s.into())),
        Some(_) => Err(err(format!("{} 须有完整隔离四项且指定单个有效 App 名", ENV_NATIVE_SOURCE))),
    }
}

/// 解析测试入口。Ok(None)=四个测试变量全部缺失，正常生产启动。
/// Err=出现测试意图但校验失败（调用方必须拒绝启动，不得回退生产路径）。
pub fn resolve(prod_app_data: &Path) -> Result<Option<TestProfile>, String> {
    let vars = [
        (ENV_ROOT, std::env::var(ENV_ROOT).ok()),
        (ENV_UI_DIR, std::env::var(ENV_UI_DIR).ok()),
        (ENV_PORT, std::env::var(ENV_PORT).ok()),
        (ENV_RUN_ID, std::env::var(ENV_RUN_ID).ok()),
    ];
    let present: Vec<&str> = vars
        .iter()
        .filter(|(_, v)| v.is_some())
        .map(|(k, _)| *k)
        .collect();
    let native_raw = std::env::var_os(ENV_NATIVE_SOURCE);
    let native_str = native_raw.as_deref().map(|s| s.to_str()
        .ok_or_else(|| err(format!("{} 不是有效 UTF-8", ENV_NATIVE_SOURCE)))).transpose()?;
    let native_source = native_capture_source(present.len(), native_str)?;
    if present.is_empty() {
        return Ok(None);
    }
    if present.len() != 4 {
        // 任何一个测试变量出现而其余缺失 = 配置不完整：拒绝，绝不静默回退生产路径
        let missing: Vec<&str> = vars
            .iter()
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| *k)
            .collect();
        return Err(err(format!(
            "测试配置不完整：出现 {} 但缺 {}——四项必须同时提供，或全部不设",
            present.join("/"),
            missing.join("/")
        )));
    }
    let raw_root = std::env::var(ENV_ROOT).unwrap_or_default();
    let raw_ui = std::env::var(ENV_UI_DIR).unwrap_or_default();
    let raw_port = std::env::var(ENV_PORT).unwrap_or_default();
    let run_id = std::env::var(ENV_RUN_ID).unwrap_or_default();
    if !valid_run_id(&run_id) {
        return Err(err(format!("{} 非法（≤64 位 [A-Za-z0-9_-]）：{:?}", ENV_RUN_ID, run_id)));
    }

    // ---- 根目录词法声明（供 UI/端口块与后续根处理共用） ----
    let root = PathBuf::from(&raw_root);
    if !root.is_absolute() {
        return Err(err(format!("{} 必须是绝对路径，收到 {:?}", ENV_ROOT, raw_root)));
    }
    if root.components().any(|c| !matches!(c, Component::Normal(_) | Component::RootDir)) {
        return Err(err("根目录路径含 CurDir/ParentDir 等非法组件".into()));
    }

    // ---- UI 目录 ----
    let ui_dir = PathBuf::from(&raw_ui);
    if !ui_dir.is_absolute() {
        return Err(err(format!("{} 必须是绝对路径", ENV_UI_DIR)));
    }
    let ui_meta = std::fs::symlink_metadata(&ui_dir)
        .map_err(|_| err(format!("{} 不存在", ENV_UI_DIR)))?;
    if ui_meta.file_type().is_symlink() {
        return Err(err(format!("{} 是符号链接——拒绝", ENV_UI_DIR)));
    }
    if !ui_meta.is_dir() {
        return Err(err(format!("{} 不是目录", ENV_UI_DIR)));
    }
    for f in ["index.html", "attachments.js", "rich-text.js"] {
        if !ui_dir.join(f).is_file() {
            return Err(err(format!("{} 缺少 {}（配置不完整）", ENV_UI_DIR, f)));
        }
    }
    if let Ok(ui_canon) = ui_dir.canonicalize() {
        if let Some(root_canon) = root.canonicalize().ok() {
            if ui_canon.starts_with(&root_canon) {
                return Err(err(format!("{} 不得位于测试根目录之内", ENV_UI_DIR)));
            }
        }
        if let Ok(prod) = prod_app_data.canonicalize() {
            if ui_canon.starts_with(&prod) {
                return Err(err(format!("{} 不得位于生产数据目录之内", ENV_UI_DIR)));
            }
        }
    }

    // ---- 端口 ----
    let port: u16 = raw_port
        .trim()
        .parse()
        .map_err(|_| err(format!("{} 不是合法端口：{}", ENV_PORT, raw_port)))?;
    if port == 0 {
        return Err(err(format!("{} 不允许为 0（必须显式固定，便于复核）", ENV_PORT)));
    }
    if port == SINGLETON_PORT {
        return Err(err(format!("{} 不得占用生产单实例端口 {}", ENV_PORT, SINGLETON_PORT)));
    }

    // ---- 根目录：祖先 canonical 校验 → 存在性与 marker 校验 → 叶子校验 → 创建 ----

    let tmp = std::env::temp_dir();
    let tmp_canon = tmp.canonicalize().unwrap_or_else(|_| tmp.clone());

    // 先校验「已存在的最深祖先」——在任何创建动作之前
    let mut deepest = None;
    for anc in root.ancestors().skip(1) {
        if anc.exists() {
            deepest = Some(anc.to_path_buf());
            break;
        }
    }
    if let Some(anc) = deepest {
        let c = anc
            .canonicalize()
            .map_err(|e| err(format!("祖先目录无法解析：{}", e)))?;
        check_safe_dir(&c, &tmp_canon, prod_app_data)?;
    }
    // 根目录不允许是临时目录本身，也不允许比临时目录更浅（成为其祖先）
    if root == tmp || tmp.starts_with(&root) {
        return Err(err("根目录不得是系统临时目录本身或其祖先".into()));
    }

    let marker_run_id;
    let root_existed = root.exists();
    let root_was_empty = root_existed
        && root
            .read_dir()
            .map(|mut d| d.next().is_none())
            .unwrap_or(false);
    if root_existed && !root_was_empty {
        let meta = std::fs::symlink_metadata(&root)
            .map_err(|e| err(format!("根目录无法读取：{}", e)))?;
        if meta.file_type().is_symlink() {
            return Err(err("根目录本身是符号链接——拒绝".into()));
        }
        if !meta.is_dir() {
            return Err(err("路径已存在但不是目录".into()));
        }
        // 非空目录必须携带合法 marker（owner 匹配 + run_id 非空）；只看存在性的旧逻辑已被 R1-F03 否决。
        // 空目录视同新建（launcher 自建的 mkdtemp 即此形态），走下方 exclusive marker 分支。
        let marker_path = root.join(MARKER_FILE);
        let marker_meta = std::fs::symlink_metadata(&marker_path).map_err(|_| {
            err(format!(
                "目录已存在、非空且没有 {} 所有权标记——拒绝接管不明目录",
                MARKER_FILE
            ))
        })?;
        if marker_meta.file_type().is_symlink() || !marker_meta.is_file() {
            return Err(err(format!("{} 不是普通文件", MARKER_FILE)));
        }
        let marker: Value = serde_json::from_str(
            &std::fs::read_to_string(&marker_path)
                .map_err(|e| err(format!("{} 无法读取：{}", MARKER_FILE, e)))?,
        )
        .map_err(|_| err(format!("{} 内容损坏（非 JSON）——拒绝接管", MARKER_FILE)))?;
        if marker["owner"].as_str() != Some(MARKER_OWNER) {
            return Err(err(format!(
                "{} owner 不匹配（期望 {:?}）——拒绝接管",
                MARKER_FILE, MARKER_OWNER
            )));
        }
        marker_run_id = marker["run_id"].as_str().unwrap_or("").to_string();
        if !valid_run_id(&marker_run_id) {
            return Err(err(format!("{} 内 run_id 缺失/非法——拒绝接管", MARKER_FILE)));
        }
        // 非空目录但 marker 不在（前面 read 已拒）——这里再兜底：目录内除已知测试文件外
        // 不做白名单强校验（manifest/files/日志都是合法内容），但叶子文件必须不是链接。
        let root_canon = root
            .canonicalize()
            .map_err(|e| err(format!("根目录无法解析真实路径：{}", e)))?;
        check_safe_dir(&root_canon, &tmp_canon, prod_app_data)?;
        // R2-F03：全量写入面扫描——根的直接子项逐个检查（不再只保护五个叶子）：
        // 每个子项必须是普通文件（非符号链接、nlink==1——硬链接与别名的共同特征），
        // 唯一允许的子目录是 files/（真实目录、非符号链接，其子项同样逐个检查）。
        check_write_surface(&root, &root_canon)?;
    } else {
        // 新建（或接管空目录）+ exclusive marker：优先新建而不是接管任意带标记目录
        std::fs::create_dir_all(&root).map_err(|e| err(format!("无法创建测试根目录：{}", e)))?;
        let canon = root
            .canonicalize()
            .map_err(|e| err(format!("创建后无法解析真实路径：{}", e)))?;
        check_safe_dir(&canon, &tmp_canon, prod_app_data)?;
        let marker = json!({
            "owner": MARKER_OWNER,
            "run_id": run_id,
            "pid": std::process::id(),
            "created_at": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs()).unwrap_or(0),
            "note": "本目录属于 NaYan reader 回归测试隔离配置，只可由创建它的 launcher 清理",
        });
        // O_CREAT|O_EXCL 语义：若并发有人先写了 marker，这里失败即拒绝
        let wrote = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(root.join(MARKER_FILE))
            .and_then(|mut f| f.write_all(marker.to_string().as_bytes()));
        if let Err(e) = wrote {
            return Err(err(format!("无法独占写入所有权标记：{}", e)));
        }
        marker_run_id = run_id.clone();
    }

    Ok(Some(TestProfile {
        db_path: root.join("inbox.db"),
        cfg_path: root.join("config.json"),
        log_path: root.join("nayan.log"),
        root,
        ui_dir,
        http_port: port,
        run_id,
        marker_run_id,
        native_capture_source: native_source,
    }))
}

/// 目录必须位于系统临时目录之内，且不落在任何生产数据区（组件级前缀，非字符串前缀）
fn check_safe_dir(canon: &Path, tmp_canon: &Path, prod_app_data: &Path) -> Result<(), String> {
    if !canon.starts_with(tmp_canon) {
        return Err(err(format!(
            "路径 {:?} 不在系统临时目录 {:?} 之内（fail-closed 默认策略）",
            canon, tmp_canon
        )));
    }
    if let Ok(prod) = prod_app_data.canonicalize() {
        if canon.starts_with(&prod) {
            return Err(err(format!(
                "路径 {:?} 落在生产 App 数据目录 {:?} 之内",
                canon, prod
            )));
        }
    }
    // 旧项目库目录（repo 根 data/inbox.db）也是生产数据区
    if let Some(home) = std::env::var("HOME").ok() {
        let legacy = PathBuf::from(&home).join("Documents/deepseek harness/项目/记录软件");
        if let Ok(lc) = legacy.canonicalize() {
            if canon.starts_with(&lc) {
                return Err(err(format!("路径 {:?} 落在旧项目数据目录 {:?} 之内", canon, lc)));
            }
        }
    }
    Ok(())
}

/// 全量写入面校验（R2-F03）：root 的每个直接子项必须是普通文件（非 symlink、nlink==1），
/// 唯一允许的子目录是 files/（真实目录）。硬链接（含指向根外文件的硬链接）因 nlink>1 被拒；
/// 符号链接无论指向何处一律拒绝——测试写入绝不落到根外或他人 inode。
fn check_write_surface(root: &Path, root_canon: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(root)
        .map_err(|e| err(format!("根目录无法枚举：{}", e)))?
        .collect::<Vec<_>>();
    for ent in entries.into_iter().flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        let p = ent.path();
        let meta = std::fs::symlink_metadata(&p)
            .map_err(|e| err(format!("{} 无法读取：{}", name, e)))?;
        if meta.file_type().is_symlink() {
            return Err(err(format!("{} 是符号链接——拒绝（测试写入不得经别名落盘）", name)));
        }
        if meta.is_dir() {
            if name != "files" {
                return Err(err(format!("未知子目录 {}——拒绝接管", name)));
            }
            let sub = std::fs::read_dir(&p)
                .map_err(|e| err(format!("files/ 无法枚举：{}", e)))?;
            for f in sub.into_iter().flatten() {
                let fname = f.file_name().to_string_lossy().into_owned();
                let fm = std::fs::symlink_metadata(f.path())
                    .map_err(|e| err(format!("files/{} 无法读取：{}", fname, e)))?;
                if fm.file_type().is_symlink() {
                    return Err(err(format!("files/{} 是符号链接——拒绝", fname)));
                }
                if !fm.is_file() {
                    return Err(err(format!("files/{} 不是普通文件", fname)));
                }
                if fm.nlink() != 1 {
                    return Err(err(format!(
                        "files/{} 有 {} 个硬链接——拒绝（防写入逃出隔离根）",
                        fname,
                        fm.nlink()
                    )));
                }
            }
            continue;
        }
        if !meta.is_file() {
            return Err(err(format!("{} 不是普通文件", name)));
        }
        if meta.nlink() != 1 {
            return Err(err(format!(
                "{} 有 {} 个硬链接——拒绝（防写入逃出隔离根）",
                name,
                meta.nlink()
            )));
        }
        let c = p.canonicalize().map_err(|e| err(format!("{} 无法解析真实路径：{}", name, e)))?;
        if !c.starts_with(root_canon) {
            return Err(err(format!("{} 的真实路径 {:?} 逃出测试根目录", name, c)));
        }
    }
    Ok(())
}

// ---------- 测试专用 HTTP 桥（std 实现，无新依赖；仅 127.0.0.1） ----------

struct Req {
    method: String,
    path: String, // 含 query
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<Req> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    let header_end;
    loop {
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "客户端断开"));
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = find_header_end(&buf) {
            header_end = i;
            break;
        }
        if buf.len() > 1 << 20 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "请求头过大"));
        }
    }
    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let req_line = lines.next().unwrap_or("");
    let mut parts = req_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_uppercase();
    let path = parts.next().unwrap_or("/").to_string();
    let mut content_length = 0usize;
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(content_length);
    Ok(Req { method, path, body })
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: &[u8]) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        status, ctype, body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn respond_json(stream: &mut TcpStream, status: &str, v: &Value) -> std::io::Result<()> {
    respond(stream, status, "application/json; charset=utf-8", v.to_string().as_bytes())
}

/// 启动测试桥。`handler` 直接引用生产 `handle_api`（真实业务 API + 隔离 SQLite）。
pub fn serve<F>(app: tauri::AppHandle, profile: TestProfile, handler: F) -> std::io::Result<()>
where
    F: Fn(&crate::AppState, &str, &str, &Value) -> Result<Value, String> + Send + Sync + 'static,
{
    let listener = TcpListener::bind(("127.0.0.1", profile.http_port))?;
    eprintln!(
        "[纳言测试桥] http://127.0.0.1:{} root={} db={} run={} marker_run={}",
        profile.http_port,
        profile.root.display(),
        profile.db_path.display(),
        profile.run_id,
        profile.marker_run_id
    );
    let handler = std::sync::Arc::new(handler);
    for stream in listener.incoming() {
        let Ok(mut s) = stream else { continue };
        let app = app.clone();
        let profile = profile.clone();
        let handler = handler.clone();
        std::thread::spawn(move || {
            let Ok(req) = read_request(&mut s) else { return };
            route(&mut s, &req, &app, &profile, &*handler);
        });
    }
    Ok(())
}

fn route<F>(
    s: &mut TcpStream,
    req: &Req,
    app: &tauri::AppHandle,
    profile: &TestProfile,
    handler: &F,
) where
    F: Fn(&crate::AppState, &str, &str, &Value) -> Result<Value, String>,
{
    let path_only = req.path.split('?').next().unwrap_or("");
    let body: Value = if req.body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&req.body).unwrap_or(Value::Null)
    };

    // ---- 测试控制端点（仅测试模式存在） ----
    if req.method == "GET" && path_only == "/__test/info" {
        // 身份握手：launcher 比对 run/root/db 与自己的预期，防端口碰撞串实例
        let _ = respond_json(
            s,
            "200 OK",
            &json!({
                "test_mode": true,
                "run_id": profile.run_id,
                "marker_run_id": profile.marker_run_id,
                "pid": std::process::id(),
                "root": profile.root.display().to_string(),
                "db": profile.db_path.display().to_string(),
                "config": profile.cfg_path.display().to_string(),
                "log": profile.log_path.display().to_string(),
                "port": profile.http_port,
                "native_capture_source": profile.native_capture_source,
                "nonpersistent_webviews": profile.native_capture_source.is_some(),
            }),
        );
        return;
    }
    if req.method == "GET" && path_only == "/__test/native-draft" && profile.native_capture_source.is_some() {
        // 已由真实 watcher 取得的自有快照；这里不再读系统剪贴板，不改变 draft。
        let draft = crate::clipboard_watch::test_draft_snapshot().map(|d| json!({
            "request_id": d.request_id, "generation": d.snapshot.generation,
            "text": d.snapshot.text, "html": d.snapshot.html,
        }));
        let _ = respond_json(s, "200 OK", &json!({"run_id":profile.run_id,"draft":draft}));
        return;
    }
    if req.method == "POST" && path_only == "/__test/fault" {
        let plan = FaultPlan {
            path_contains: body["path_contains"].as_str().unwrap_or("").to_string(),
            action: body["action"].as_str().unwrap_or("").to_string(),
            ms: body["ms"].as_u64().unwrap_or(0),
            times: body["times"].as_u64().unwrap_or(1).max(1) as u32,
        };
        let valid_action = ["fail", "delay", "fail_late"].contains(&plan.action.as_str());
        if plan.path_contains.is_empty() || !valid_action {
            let _ = respond_json(s, "400 Bad Request", &json!({"error": "需要 path_contains 与 action=fail|delay|fail_late"}));
            return;
        }
        set_fault(plan);
        let _ = respond_json(s, "200 OK", &json!({"ok": true}));
        return;
    }
    if req.method == "POST" && path_only == "/__test/sink" {
        // copy sink：真实 Copy Response handler 提交的载荷原文落盘，带 run 身份，
        // 供字节级比对并拒绝旧 run 记录
        let line = json!({
            "run": profile.run_id,
            "label": body["label"].as_str().unwrap_or(""),
            "text": body["text"].as_str().unwrap_or(""),
            "at_unix_ms": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64).unwrap_or(0),
        });
        let append = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(profile.root.join(SINK_FILE));
        match append.and_then(|mut f| writeln!(f, "{}", line)) {
            Ok(()) => { let _ = respond_json(s, "200 OK", &json!({"ok": true})); }
            Err(e) => { let _ = respond_json(s, "500 Internal Server Error", &json!({"error": e.to_string()})); }
        }
        return;
    }

    // ---- 被测 UI 静态文件（字节原样，白名单） ----
    if req.method == "GET" {
        let file = match path_only {
            "/" | "/index.html" => Some(("index.html", "text/html; charset=utf-8")),
            "/attachments.js" => Some(("attachments.js", "application/javascript; charset=utf-8")),
            "/rich-text.js" => Some(("rich-text.js", "application/javascript; charset=utf-8")),
            "/title-rule.js" => Some(("title-rule.js", "application/javascript; charset=utf-8")),
            "/plan-rule.js" => Some(("plan-rule.js", "application/javascript; charset=utf-8")),
            _ => None,
        };
        if let Some((name, ctype)) = file {
            match std::fs::read(profile.ui_dir.join(name)) {
                Ok(bytes) => { let _ = respond(s, "200 OK", ctype, &bytes); }
                Err(e) => { let _ = respond(s, "500 Internal Server Error", "text/plain", e.to_string().as_bytes()); }
            }
            return;
        }
    }

    // ---- 业务 API：先拒绝外部 AI 路由，再按需注入故障，最后进真实 handle_api ----
    if path_only == "/api" || path_only.starts_with("/api/") {
        let segs: Vec<&str> = path_only.trim_matches('/').split('/').filter(|x| !x.is_empty()).collect();
        let is_ai = (req.method == "POST"
            && segs.len() == 3
            && segs[0] == "api" && segs[1] == "settings" && segs[2] == "test")
            || (req.method == "POST"
                && segs.len() == 4
                && segs[0] == "api" && segs[1] == "ai" && segs[2] == "split");
        if is_ai {
            let _ = respond_json(s, "400 Bad Request", &json!({"error": "测试模式已禁用外部 AI 服务调用"}));
            return;
        }
        if let Some((action, ms)) = take_fault(&req.path) {
            match action.as_str() {
                "fail" => {
                    let _ = respond_json(s, "500 Internal Server Error", &json!({"error": "（测试注入）附件接口故障"}));
                    return;
                }
                "fail_late" => {
                    if ms > 0 {
                        std::thread::sleep(std::time::Duration::from_millis(ms));
                    }
                    let _ = respond_json(s, "500 Internal Server Error", &json!({"error": "（测试注入·迟到）附件接口故障"}));
                    return;
                }
                _ => {
                    if ms > 0 {
                        std::thread::sleep(std::time::Duration::from_millis(ms));
                    }
                }
            }
        }
        let state = app.state::<crate::AppState>();
        match handler(&state, &req.method, &req.path, &body) {
            Ok(v) => { let _ = respond_json(s, "200 OK", &v); }
            Err(e) => { let _ = respond_json(s, "500 Internal Server Error", &json!({"error": e})); }
        }
        return;
    }

    let _ = respond_json(s, "404 Not Found", &json!({"error": "not found"}));
}

#[cfg(test)]
mod native_capture_tests {
    use super::*;
    #[test]
    fn native_capture_opt_in_is_fail_closed() {
        assert_eq!(native_capture_source(0, None).unwrap(), None);
        assert_eq!(native_capture_source(4, None).unwrap(), None);
        assert_eq!(native_capture_source(4, Some("WorkBuddy")).unwrap().as_deref(), Some("WorkBuddy"));
        assert!(native_capture_source(4, Some("Another AI App")).is_ok());
        for n in 0..4 { assert!(native_capture_source(n, Some("WorkBuddy")).is_err()); }
        for s in ["", " ", "a/b", "a\\b", "a\nb"] { assert!(native_capture_source(4, Some(s)).is_err()); }
    }
}
