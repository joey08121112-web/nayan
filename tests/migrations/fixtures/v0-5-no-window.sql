-- v0-5-no-window：63e47cb 初始公开版形态（有 kind/user_msg/steps.result，无 window_id）

-- 出处：git show 63e47cb:app/src-tauri/src/main.rs（open_db DDL 逐行提取，仅去除 Rust 字符串字面量定界符）

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
        );;

CREATE TABLE IF NOT EXISTS steps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            suggestion_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            is_cmd INTEGER DEFAULT 0,
            done INTEGER DEFAULT 0,
            ord INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            result TEXT DEFAULT ''
        );;
