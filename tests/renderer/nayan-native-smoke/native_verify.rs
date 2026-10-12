// Included only in a mechanically patched temporary product-source copy.
use super::*;
use std::os::unix::fs::MetadataExt;
use std::io::Write;
static PHASE: Mutex<String> = Mutex::new(String::new());
static EVENTS: Mutex<Vec<Value>> = Mutex::new(Vec::new());
extern "C" { fn kill(pid: i32, sig: i32) -> i32; fn geteuid() -> u32; }

pub fn preflight() -> Result<(), String> {
    let root = PathBuf::from(std::env::var("NAYAN_TEST_PROFILE").map_err(|_| "native test requires isolated profile")?);
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    let temp = std::env::temp_dir().canonicalize().map_err(|e| e.to_string())?;
    let st = fs::symlink_metadata(&root).map_err(|e| e.to_string())?;
    if root != canonical || canonical.parent() != Some(temp.as_path()) || st.file_type().is_symlink()
        || !st.is_dir() || st.uid() != unsafe { geteuid() } { return Err("native profile alias/path/owner rejected".into()); }
    let marker = root.join("nayan-test-owned.json");
    let m = fs::symlink_metadata(&marker).map_err(|_| "native profile requires pre-existing marker")?;
    if !m.is_file() || m.file_type().is_symlink() || m.nlink() != 1 || m.uid() != st.uid() { return Err("native marker type rejected".into()); }
    let value: Value = serde_json::from_slice(&fs::read(marker).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let run = std::env::var("NAYAN_TEST_RUN_ID").map_err(|_| "run required")?;
    if value["owner"] != "nayan-reader-regression" || value["run_id"].as_str() != Some(run.as_str()) { return Err("native marker owner/run rejected".into()); }
    if let Some(pid) = value["active_pid"].as_i64() {
        if pid > 0 && pid != std::process::id() as i64 && unsafe { kill(pid as i32,0) } == 0 { return Err("native profile has live owner".into()); }
    }
    Ok(())
}

pub fn install(app: &mut tauri::App, p: &test_profile::TestProfile) -> Result<(), Box<dyn std::error::Error>> {
    let win = tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::App("index.html".into()))
        .title("NaYan · 隔离原生验证") .inner_size(1180.,780.) .incognito(true)
        .initialization_script(format!("Object.defineProperty(window, '__NATIVE_MODE__', {{value:{}}});\n{}", serde_json::to_string(&std::env::var("NAYAN_NATIVE_MODE").unwrap_or_else(|_| "smoke".into()))?, include_str!("observer.js"))).build()?;
    let root = p.root.clone();
    win.with_webview(move |webview| {
        use cocoa::base::{id,BOOL,NO};
        use objc::{msg_send,sel,sel_impl};
        unsafe {
            let wv = webview.inner() as id;
            let cfg: id = msg_send![wv,configuration];
            let store: id = msg_send![cfg,websiteDataStore];
            let persistent: BOOL = msg_send![store,isPersistent];
            let value = json!({"nonPersistent":persistent==NO,"pid":std::process::id(),"root":root});
            let file = root.join("native-isolation.json");
            let wrote = fs::OpenOptions::new().write(true).create_new(true).open(file)
                .and_then(|mut f|f.write_all(value.to_string().as_bytes()));
            if wrote.is_err() || persistent != NO { eprintln!("native isolation proof failed");std::process::exit(4); }
        }
    })?;
    Ok(())
}

pub fn record(message: &tauri::ipc::InvokeMessage<tauri::Wry>) {
    let phase = PHASE.lock().unwrap().clone();
    let body = match message.payload() { tauri::ipc::InvokeBody::Json(v)=>v.clone(), _=>Value::Null };
    let mut events = EVENTS.lock().unwrap();
    let seq = events.len();
    events.push(json!({"seq":seq,"phase":phase,"cmd":message.command(),"method":body["method"],"path":body["path"]}));
}
#[tauri::command]
pub fn native_phase(name: String) -> Result<bool,String> {
    if !test_profile::test_mode() { return Err("only isolated native test".into()); }
    if !["init","smoke","performance","race","hostile-window","controls","teardown"].contains(&name.as_str()) { return Err("unknown phase".into()); }
    *PHASE.lock().unwrap()=name; Ok(true)
}
#[tauri::command]
pub fn native_seed(state: State<'_, AppState>, label: String) -> Result<Value,String> {
    if !test_profile::test_mode() { return Err("only isolated native fixture setup".into()); }
    // Fixed synthetic fixtures only. This setup bypasses the POST character cap; the reader
    // then uses the unchanged real GET/content handler. Never claim this is capture acceptance.
    let data: Value=serde_json::from_str(include_str!("../ui/__native-fixtures.json")).map_err(|e|e.to_string())?;
    let text=if label=="inject" {data["injection"]["text"].as_str()} else {
        data["fixtures"].as_array().and_then(|a|a.iter().find(|f|f["label"].as_str()==Some(label.as_str()))).and_then(|f|f["text"].as_str())
    }.ok_or("unknown fixed fixture")?;
    let req=format!("wk-{}",label);
    let c:content::CapturedContent=serde_json::from_value(json!({"schema_version":1,"request_id":req,"format":"markdown","format_provenance":"declared","acquisition":"manual","original":{"kind":"text","text":text},"fidelity":{"truncated":false},"canonical":text,"canonical_unavailable_reason":null,"plain_projection":{"status":"available","text":text}})).map_err(|e|e.to_string())?;
    let db=state.db.lock().map_err(|e|e.to_string())?;
    db.execute("INSERT INTO suggestions (title,source_tool,workspace) VALUES (?1,'native-test','Synthetic')",[req.clone()]).map_err(|e|e.to_string())?;
    let id=db.last_insert_rowid();migrations::write_content(&db,id,&c)?;
    Ok(json!({"id":id,"req":req,"fixtureSetup":true}))
}
#[tauri::command]
pub fn native_checkpoint(value: Value) -> Result<bool,String> {
    if !test_profile::test_mode() { return Err("only isolated native test".into()); }
    let root=PathBuf::from(std::env::var("NAYAN_TEST_PROFILE").map_err(|e|e.to_string())?);
    let data=json!({"value":value,"pid":std::process::id(),"run":std::env::var("NAYAN_TEST_RUN_ID").unwrap_or_default()});
    fs::OpenOptions::new().write(true).create_new(true).open(root.join("native-checkpoint.json"))
        .and_then(|mut f|f.write_all(data.to_string().as_bytes())).map_err(|e|e.to_string())?;
    Ok(true)
}
#[tauri::command]
pub fn native_result(app: AppHandle, state: State<'_, AppState>, result: Value) -> Result<bool,String> {
    if !test_profile::test_mode() { return Err("only isolated native test".into()); }
    let root=PathBuf::from(std::env::var("NAYAN_TEST_PROFILE").map_err(|e|e.to_string())?);
    let events=EVENTS.lock().map_err(|e|e.to_string())?.clone();
    let db=state.db.lock().map_err(|e|e.to_string())?;
    let mut stmt=db.prepare("SELECT id,quote,content_envelope FROM suggestions ORDER BY id").map_err(|e|e.to_string())?;
    let stored: Vec<Value>=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"quote":r.get::<_,Option<String>>(1)?,"content_envelope":r.get::<_,Option<String>>(2)?})))
        .map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?;
    let value=json!({"js":result,"ipc":events,"stored":stored,"pid":std::process::id(),"run":std::env::var("NAYAN_TEST_RUN_ID").unwrap_or_default()});
    let wrote=fs::OpenOptions::new().write(true).create_new(true).open(root.join("native-result.json"))
        .and_then(|mut f|f.write_all(value.to_string().as_bytes()));
    if let Err(e)=wrote { eprintln!("native result write failed: {}",e);app.exit(4);return Err(e.to_string()); }
    // Only a write/ack channel. Controller evaluates native/DOM/DB evidence.
    std::thread::spawn(move || {std::thread::sleep(std::time::Duration::from_millis(50));app.exit(0);});
    Ok(true)
}
