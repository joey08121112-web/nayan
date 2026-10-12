//! Original screen pixels are separate from derived OCR; no format inference or DB schema change.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use rusqlite::Connection;
use std::{fs, io::Write, path::{Path, PathBuf}, sync::Mutex};

const MAX_PNG: usize = 32 * 1024 * 1024;
#[derive(Clone)]
pub struct Draft { pub png: Vec<u8>, pub text: String, pub width: u32, pub height: u32, pub ocr_error: String }
static DRAFT: Mutex<Option<(String, Draft)>> = Mutex::new(None);

impl Draft {
    pub fn from_result(v: &Value, text: String) -> Result<Self, String> {
        let encoded = v["image"]["png"].as_str().ok_or("截图没有原图")?;
        if encoded.len() > MAX_PNG * 4 / 3 + 4 { return Err("选区原图超过 32MB，请缩小选区".into()); }
        let png = STANDARD.decode(encoded).map_err(|_| "原图编码错误")?;
        let (width, height) = dimensions(&png)?;
        if v["image"]["width"].as_u64() != Some(width as u64) || v["image"]["height"].as_u64() != Some(height as u64) {
            return Err("原图尺寸不一致".into());
        }
        Ok(Self { png, text, width, height, ocr_error: v["ocrError"].as_str().unwrap_or("").into() })
    }
    pub fn preview(&self) -> Value {
        json!({"dataUrl": format!("data:image/png;base64,{}", STANDARD.encode(&self.png)),
            "width":self.width,"height":self.height,"textOrigin":"ocr","ocrError":self.ocr_error})
    }
}
fn dimensions(png: &[u8]) -> Result<(u32,u32),String> {
    if png.len() > MAX_PNG || !png.starts_with(b"\x89PNG\r\n\x1a\n") { return Err("无效 PNG 原图".into()); }
    // Decode, rather than trusting caller-provided PNG headers.
    let image = tauri::image::Image::from_bytes(png).map_err(|_| "PNG 原图损坏")?;
    Ok((image.width(),image.height()))
}
pub fn stage(rid: &str, draft: Draft) { *DRAFT.lock().unwrap() = Some((rid.into(),draft)); }
pub fn get(rid: &str) -> Option<Draft> { DRAFT.lock().unwrap().as_ref().filter(|(id,_)| id == rid).map(|(_,d)|d.clone()) }

fn directory(root: &Path) -> Result<PathBuf,String> {
    let dir=root.join("captures");
    match fs::symlink_metadata(&dir) {
        Ok(m) if !m.is_dir() || m.file_type().is_symlink() => return Err("原图目录不能是链接或文件".into()),
        Ok(_) => {},
        Err(e) if e.kind()==std::io::ErrorKind::NotFound => fs::create_dir(&dir).map_err(|e|e.to_string())?,
        Err(e) => return Err(e.to_string()),
    }
    Ok(dir)
}
pub fn save(conn:&Connection, root:&Path, body:&Value, draft:&Draft) -> Result<Value,String> {
    let rid=body["request_id"].as_str().ok_or("原图请求身份缺失")?;
    if rid.is_empty() || !rid.bytes().all(|b| b.is_ascii_alphanumeric() || b==b'-') {
        return Err("原图请求身份非法".into());
    }
    let c:crate::content::CapturedContent=serde_json::from_value(body["content"].clone()).map_err(|e|e.to_string())?;
    if c.request_id()!=rid || c.acquisition()!=crate::content::AcquisitionKind::RegionOcr
        || c.format()!=crate::content::DeclaredFormat::Plain
        || c.original()!=&(crate::content::Original::Text { text:draft.text.clone() }) {
        return Err("原图与识别文字请求不一致，拒绝收录".into());
    }
    let path=directory(root)?.join(format!("{rid}.png"));
    conn.execute_batch("SAVEPOINT capture_image").map_err(|e|e.to_string())?;
    let mut created=false;
    let result=(|| {
        let row=crate::create_with_content(conn,body)?;
        let sid=row["id"].as_i64().ok_or("收录没有条目身份")?;
        if row["duplicate"]==true {
            let count:i64=conn.query_row("SELECT COUNT(*) FROM attachments WHERE suggestion_id=?1 AND path=?2",rusqlite::params![sid,path.to_string_lossy()],|r|r.get(0)).map_err(|e|e.to_string())?;
            if count!=1 || fs::read(&path).map_err(|e|e.to_string())?!=draft.png { return Err("已保存原图缺失或改变，请检查原文件".into()); }
        } else {
            let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e|e.to_string())?;
            created=true;
            file.write_all(&draft.png).and_then(|_|file.sync_all()).map_err(|e|e.to_string())?;
            conn.execute("INSERT INTO attachments (suggestion_id,path,name) VALUES (?1,?2,'选区原图.png')",rusqlite::params![sid,path.to_string_lossy()]).map_err(|e|e.to_string())?;
        }
        conn.execute_batch("RELEASE capture_image").map_err(|e|e.to_string())?;
        Ok(row)
    })();
    if result.is_err() {
        let _=conn.execute_batch("ROLLBACK TO capture_image; RELEASE capture_image");
        if created { fs::remove_file(&path).map_err(|e|format!("{}；原图清理失败：{}",result.as_ref().unwrap_err(),e))?; }
    }
    result
}
pub fn read(conn:&Connection,root:&Path,id:i64,sid:i64)->Result<Value,String> {
    let path:String=conn.query_row("SELECT path FROM attachments WHERE id=?1 AND suggestion_id=?2 AND name='选区原图.png'",rusqlite::params![id,sid],|r|r.get(0)).map_err(|_|"原图不属于当前条目")?;
    let p=Path::new(&path);
    let dir=root.join("captures");
    if p.parent()!=Some(dir.as_path()) {return Err("不是纳言保存的选区原图".into());}
    let dm=fs::symlink_metadata(&dir).map_err(|e|e.to_string())?;
    let m=fs::symlink_metadata(p).map_err(|e|e.to_string())?;
    if dm.file_type().is_symlink() || !dm.is_dir() || m.file_type().is_symlink() || !m.is_file() || m.len()>MAX_PNG as u64 {return Err("原图文件不安全或过大".into());}
    let png=fs::read(p).map_err(|e|e.to_string())?;
    let (width,height)=dimensions(&png)?;
    Ok(json!({"dataUrl":format!("data:image/png;base64,{}",STANDARD.encode(png)),"width":width,"height":height}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize,Ordering};
    static NEXT:AtomicUsize=AtomicUsize::new(0);
    fn fixture(text:&str)->Draft {
        let png=include_bytes!("../icons/32x32.png").to_vec();
        let (w,h)=dimensions(&png).unwrap();
        Draft::from_result(&json!({"image":{"png":STANDARD.encode(png),"width":w,"height":h},"ocrError":""}),text.into()).unwrap()
    }
    fn setup()->(Connection,PathBuf) {
        let c=Connection::open_in_memory().unwrap();crate::migrations::migrate(&c).unwrap();
        let root=std::env::temp_dir().join(format!("nayan-owned-image-test-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));
        fs::create_dir(&root).unwrap();(c,root)
    }
    fn body(text:&str)->Value {crate::build_capture_payload(text,None,"Fixture","","",0,"box").unwrap().as_object().map(|p|{let mut b=p.clone();b.insert("title".into(),json!("框选"));Value::Object(b)}).unwrap()}
    #[test] fn image_roundtrip_idempotence_and_wrong_owner() {
        let (conn,root)=setup();let d=fixture("sudo groupadd datasafe");let b=body(&d.text);
        let row=save(&conn,&root,&b,&d).unwrap();let sid=row["id"].as_i64().unwrap();
        assert_eq!(save(&conn,&root,&b,&d).unwrap()["duplicate"],true);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM suggestions",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM attachments",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        let id=conn.query_row("SELECT id FROM attachments",[],|r|r.get(0)).unwrap();
        let image=read(&conn,&root,id,sid).unwrap();
        assert_eq!(STANDARD.decode(image["dataUrl"].as_str().unwrap().split(',').nth(1).unwrap()).unwrap(),d.png);
        assert!(read(&conn,&root,id,sid+1).is_err());fs::remove_dir_all(root).unwrap();
    }
    #[test] fn no_text_and_ocr_error_still_preserve_image() {
        let (conn,root)=setup();let mut d=fixture("");d.ocr_error="Vision failed".into();
        let b=body("");assert_eq!(d.preview()["ocrError"],"Vision failed");
        assert!(save(&conn,&root,&b,&d).is_ok());fs::remove_dir_all(root).unwrap();
    }
    #[test] fn attachment_failure_rolls_back_row_and_created_file() {
        let (conn,root)=setup();let d=fixture("test");let b=body("test");
        conn.execute_batch("CREATE TRIGGER reject_image BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
        assert!(save(&conn,&root,&b,&d).unwrap_err().contains("injected failure"));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM suggestions",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(fs::read_dir(root.join("captures")).unwrap().count(),0);
        assert!(conn.is_autocommit());fs::remove_dir_all(root).unwrap();
    }
    #[test] fn mismatched_text_and_preexisting_file_refused_without_overwrite() {
        let (conn,root)=setup();let d=fixture("A");
        assert!(save(&conn,&root,&body("B"),&d).is_err());
        let b=body("A");let p=directory(&root).unwrap().join(format!("{}.png",b["request_id"].as_str().unwrap()));fs::write(&p,b"protected").unwrap();
        assert!(save(&conn,&root,&b,&d).is_err());assert_eq!(fs::read(p).unwrap(),b"protected");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM suggestions",[],|r|r.get::<_,i64>(0)).unwrap(),0);fs::remove_dir_all(root).unwrap();
    }
    #[test] fn symlink_capture_directory_refused() {
        let (conn,root)=setup();std::os::unix::fs::symlink(std::env::temp_dir(),root.join("captures")).unwrap();
        assert!(save(&conn,&root,&body("A"),&fixture("A")).is_err());fs::remove_dir_all(root).unwrap();
    }
    #[test] fn reopened_database_reads_original_without_draft_memory() {
        let (_,root)=setup();let path=root.join("inbox.db");let d=fixture("恢复后读回");
        let conn=crate::migrations::open_and_migrate(&path).unwrap();let row=save(&conn,&root,&body(&d.text),&d).unwrap();
        let id=conn.query_row("SELECT id FROM attachments",[],|r|r.get(0)).unwrap();drop(conn);
        let reopened=crate::migrations::open_and_migrate(&path).unwrap();
        assert_eq!(read(&reopened,&root,id,row["id"].as_i64().unwrap()).unwrap(),d.preview().as_object().map(|p|json!({"dataUrl":p["dataUrl"],"width":p["width"],"height":p["height"]})).unwrap());
        drop(reopened);fs::remove_dir_all(root).unwrap();
    }
}
