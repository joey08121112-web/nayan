use super::*;

struct Fixture { st: AppState, root: PathBuf }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("nayan-r9-trash-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(root.join("captures")).unwrap();
        let conn = migrations::open_and_migrate(&root.join("inbox.db")).unwrap();
        let cfg = root.join("config.json");
        Self { st: AppState { db: Mutex::new(conn), cfg: Mutex::new((load_config(&cfg), cfg)) }, root }
    }
    fn call(&self, m: &str, p: &str, b: Value) -> Value { handle_api(&self.st, m, p, &b).unwrap() }
    fn add(&self, title: &str) -> i64 { self.call("POST", "/api/suggestions", json!({"title":title,"quote":"原文 · 🐱"}))["id"].as_i64().unwrap() }
    fn delete(&self, id: i64) { self.call("DELETE", &format!("/api/suggestions/{}", id), Value::Null); }
    fn image(&self, id: i64, p: &PathBuf, name: &str) {
        fs::write(p, b"pixels").unwrap();
        self.st.db.lock().unwrap().execute("INSERT INTO attachments(suggestion_id,path,name) VALUES (?1,?2,?3)", rusqlite::params![id,p.to_string_lossy(),name]).unwrap();
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }

#[test]
fn soft_delete_restore_preserves_content_steps_attachment_and_list() {
    let f=Fixture::new(); let id=f.add("保留原文");
    f.call("PATCH", &format!("/api/suggestions/{}",id), json!({"list_id":1,"wait_note":"等确认","remind_on":"2030-01-01"}));
    f.call("POST", &format!("/api/suggestions/{}/steps",id), json!({"steps":["一步"]}));
    let p=f.root.join("captures/a.png"); f.image(id,&p,"选区原图.png");
    let before=f.call("GET","/api/suggestions",Value::Null)[0].clone(); f.delete(id);
    assert!(f.call("GET","/api/suggestions",Value::Null).as_array().unwrap().is_empty());
    let trashed=f.call("GET","/api/suggestions?trash=1",Value::Null)[0].clone();
    assert!(trashed["deleted_at"].is_string()); assert!(p.exists());
    let mut restored=f.call("POST",&format!("/api/suggestions/{}/restore",id),Value::Null);
    restored["deleted_at"]=Value::Null; assert_eq!(restored,before);
    assert_eq!(fs::read(p).unwrap(),b"pixels");
}

#[test]
fn soft_delete_retry_keeps_original_deletion_time() {
    let f=Fixture::new(); let id=f.add("重试"); f.delete(id);
    f.st.db.lock().unwrap().execute("UPDATE suggestions SET deleted_at='2030-01-01T00:00:00Z' WHERE id=?1",[id]).unwrap();
    f.delete(id);
    assert_eq!(f.call("GET","/api/suggestions?trash=1",Value::Null)[0]["deleted_at"],"2030-01-01T00:00:00Z");
}

#[test]
fn trashed_excluded_from_search_counts_and_comparison_members() {
    let f=Fixture::new(); let a=f.add("可搜索的关键词"); let b=f.add("另一家回答");
    let g=f.call("POST","/api/compare-groups",json!({"ids":[a,b]})); let gid=g["group"]["id"].as_i64().unwrap();
    f.call("POST",&format!("/api/compare-groups/{}/split-paragraphs",gid),Value::Null);
    f.delete(a);
    let d=f.call("GET",&format!("/api/compare-groups/{}",gid),Value::Null);
    assert_eq!(d["members"].as_array().unwrap().len(),1);
    assert!(d["points"].as_array().unwrap().iter().all(|p|p["suggestion_id"]!=a));
    assert!(f.call("GET","/api/suggestions?q=关键词",Value::Null).as_array().unwrap().is_empty());
    f.call("PATCH",&format!("/api/suggestions/{}",b),json!({"list_id":1})); f.delete(b);
    assert_eq!(f.call("GET","/api/lists",Value::Null)[0]["count"],0);
    assert!(handle_api(&f.st,"POST","/api/compare-groups",&json!({"ids":[a,b]})).is_err());
}

#[test]
fn permanent_delete_requires_trash_and_cleans_all_associations() {
    let f=Fixture::new();let a=f.add("清理");let b=f.add("保留");
    f.call("POST","/api/compare-groups",json!({"ids":[a,b]}));
    f.call("POST",&format!("/api/suggestions/{}/steps",a),json!({"steps":["step"]}));
    let p=f.root.join("captures/a.png");f.image(a,&p,"选区原图.png");
    assert!(handle_api(&f.st,"DELETE",&format!("/api/suggestions/{}?purge=1",a),&Value::Null).is_err());
    assert!(p.exists());f.delete(a);
    assert_eq!(f.call("DELETE",&format!("/api/suggestions/{}?purge=1",a),Value::Null)["removed_images"],1);
    assert!(!p.exists());
    let c=f.st.db.lock().unwrap();
    for (t,col) in [("suggestions","id"),("steps","suggestion_id"),("attachments","suggestion_id"),("compare_points","suggestion_id")] {
        assert_eq!(c.query_row(&format!("SELECT COUNT(*) FROM {} WHERE {}=?1",t,col),[a],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
}

#[test]
fn empty_trash_keeps_live_items_and_user_files() {
    let f=Fixture::new();let a=f.add("删");let b=f.add("留");
    let p=f.root.join("用户自己的.png");f.image(a,&p,"选区原图.png");f.delete(a);
    assert_eq!(f.call("POST","/api/trash/empty",Value::Null)["purged"],1);
    assert!(p.exists());assert_eq!(f.call("GET","/api/suggestions",Value::Null)[0]["id"],b);
    assert_eq!(f.call("POST","/api/trash/empty",Value::Null)["purged"],0);
}

#[test]
fn purge_expired_uses_injected_time_and_strict_30_day_boundary() {
    let f=Fixture::new(); let ids:Vec<_>=(0..5).map(|_|f.add("期限")).collect();
    let dates=[Some("2030-01-01T23:59:59Z"),Some("2030-01-02T00:00:00Z"),Some("2030-01-02T00:00:01Z"),Some("bad-date"),None];
    {let c=f.st.db.lock().unwrap();for (id,d) in ids.iter().zip(dates){c.execute("UPDATE suggestions SET deleted_at=?1 WHERE id=?2",rusqlite::params![d,id]).unwrap();}}
    let p=f.root.join("captures/expired.png"); f.image(ids[0],&p,"选区原图.png");
    let mut c=f.st.db.lock().unwrap();
    assert_eq!(trash::purge_expired(&mut c,&f.root.join("captures"),"2030-02-01T00:00:00Z").unwrap(),1);
    assert_eq!(c.query_row("SELECT COUNT(*) FROM suggestions",[],|r|r.get::<_,i64>(0)).unwrap(),4);assert!(!p.exists());
    assert_eq!(trash::purge_expired(&mut c,&f.root.join("captures"),"2030-02-01T00:00:00Z").unwrap(),0);
}

#[test]
fn purge_shared_capture_keeps_other_reference() {
    let f=Fixture::new();let a=f.add("甲");let b=f.add("乙");let p=f.root.join("captures/shared.png");
    f.image(a,&p,"选区原图.png");f.image(b,&p,"选区原图.png");f.delete(a);
    assert_eq!(f.call("DELETE",&format!("/api/suggestions/{}?purge=1",a),Value::Null)["removed_images"],0);assert!(p.exists());
    f.delete(b);assert_eq!(f.call("DELETE",&format!("/api/suggestions/{}?purge=1",b),Value::Null)["removed_images"],1);
}

#[cfg(unix)]
#[test]
fn purge_does_not_follow_capture_symlink() {
    let f=Fixture::new();let a=f.add("链接");let user=f.root.join("用户原图.png");fs::write(&user,b"safe").unwrap();
    let p=f.root.join("captures/link.png");std::os::unix::fs::symlink(&user,&p).unwrap();
    f.st.db.lock().unwrap().execute("INSERT INTO attachments(suggestion_id,path,name) VALUES (?1,?2,'选区原图.png')",rusqlite::params![a,p.to_string_lossy()]).unwrap();
    f.delete(a);f.call("DELETE",&format!("/api/suggestions/{}?purge=1",a),Value::Null);assert!(user.exists()&&p.exists());
}

#[test]
fn purge_transaction_failure_keeps_db_and_capture() {
    let f=Fixture::new();let a=f.add("回滚");let p=f.root.join("captures/rollback.png");f.image(a,&p,"选区原图.png");f.delete(a);
    f.st.db.lock().unwrap().execute_batch("CREATE TRIGGER block_purge BEFORE DELETE ON suggestions BEGIN SELECT RAISE(ABORT,'blocked'); END;").unwrap();
    assert!(handle_api(&f.st,"DELETE",&format!("/api/suggestions/{}?purge=1",a),&Value::Null).is_err());assert!(p.exists());
    let c=f.st.db.lock().unwrap();assert!(c.is_autocommit());
    assert_eq!(c.query_row("SELECT COUNT(*) FROM attachments WHERE suggestion_id=?1",[a],|r|r.get::<_,i64>(0)).unwrap(),1);
}
