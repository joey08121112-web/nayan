-- v0-4-pre-usermsg：推断的历史更早形态（无 user_msg、无 steps.result、无 window_id、无 attachments/session_aliases 表）
-- 依据（Inferred，非 git 直接提取）：main.rs「v0.4：user_msg=我的话；steps.result=执行结果；v0.5：window_id」注释
-- + mcp-server.js:20-23 兼容 ALTER 清单（kind/user_msg/result/window_id 均为后补列）


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
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        );;

CREATE TABLE IF NOT EXISTS steps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            suggestion_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            is_cmd INTEGER DEFAULT 0,
            done INTEGER DEFAULT 0,
            ord INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );;
