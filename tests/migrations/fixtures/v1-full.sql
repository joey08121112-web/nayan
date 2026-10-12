-- v1-full：现行完整 schema（bf37884 main.rs::open_db 的 DDL 原样，user_version=0 的历史形态）
-- 出处：git show bf37884:app/src-tauri/src/main.rs（open_db）
CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    quote TEXT DEFAULT '',
    my_note TEXT DEFAULT '',
    source_tool TEXT DEFAULT 'other',
    workspace TEXT DEFAULT '',
    session_ref TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    status TEXT DEFAULT 'inbox',
    kind TEXT DEFAULT 'suggestion',
    priority INTEGER DEFAULT 2,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    user_msg TEXT DEFAULT ''
);
-- 注：bf37884 的 open_db 在 DDL 后以 ALTER 补 window_id（吞错模式）；此处模拟其最终形态：
ALTER TABLE suggestions ADD COLUMN window_id INTEGER DEFAULT 0;
CREATE TABLE IF NOT EXISTS steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    suggestion_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    is_cmd INTEGER DEFAULT 0,
    done INTEGER DEFAULT 0,
    ord INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    result TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    suggestion_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS session_aliases (
    app TEXT NOT NULL,
    session_ref TEXT NOT NULL,
    window_id INTEGER NOT NULL DEFAULT 0,
    alias TEXT NOT NULL DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (app, session_ref, window_id)
);
