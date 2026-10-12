# P1-T02 / S01 — Writer 清单、路径与 schema 基线（迁移实施前记录）

## 实际 writer 与 DB 路径（代码事实，实施前）

| Writer | 打开/建库行为（改造前） | 默认/override 路径 | 启动入口 |
|---|---|---|---|
| Rust App（main.rs open_db） | 启动 DDL + ALTER 吞错补列（无 user_version） | `~/Library/Application Support/com.nayan.app/inbox.db`；`cfg.db_path` 可覆盖 | App 启动 setup；后台旧库导入线程二次 open_db（同主库） |
| mcp-server.js | **自带整套 DDL，先 ALTER 后 CREATE**（自行建库/升级） | `DB_PATH` env → 优先 App 主库 → `项目/data/inbox.db` | MCP 客户端拉起 |
| sync-server.js | 只检查 suggestions 可读，不建表 | `DB_PATH` env → App 主库 | launchd com.nayan.sync / 手动 |
| test-mcp.mjs（测试） | 经 MCP 自建临时库（改造前） | mkdtemp 隔离 | 手动 |
| test_profile.rs（测试桥） | 只在测试模式读写隔离根目录 | NAYAN_TEST_PROFILE | 测试 |

**旧后台导入**：main.rs 启动线程在主库为空时从 `项目/data/inbox.db`（legacy_dir）ATTACH 导入——仍以 open_db 打开主库，改造后自动受权威迁移约束（测试模式跳过，不接生产库）。

## 历史 schema 链条（fixtures 出处）

| 形态 | 内容 | 出处 |
|---|---|---|
| v0-4-pre-usermsg | suggestions 无 user_msg/window_id；steps 无 result；无 attachments/session_aliases | **Inferred**：main.rs v0.4/v0.5 注释 + mcp-server.js:20-23 兼容 ALTER 清单（非 git 直接提取） |
| v0-5-no-window | 有 user_msg/steps.result，无 window_id/attachments/session_aliases | **git 提取**：`git show 63e47cb:app/src-tauri/src/main.rs`（初始公开版） |
| v1-full | 现行完整四表（含 window_id），user_version=0 | **git**：`git show bf37884:app/src-tauri/src/main.rs`（open_db DDL） |
| v2（本批引入） | v1 + `suggestions.content_envelope TEXT NULL` + `PRAGMA user_version=2` | migrations.rs |
| unknown-extra | v1 + 未知列/未知表 | 合成负例 |
| future | user_version=99 | 合成负例 |

## 版本概念区分

DB `PRAGMA user_version`（本模块，2）≠ envelope 内 `schema_version`（content.rs 契约，1）。二者独立演进，不得混用。

## 迁移前基线命令（cwd = 仓库根）

```sh
# fixtures 语法与形态自检（sqlite3 只读）
for f in tests/migrations/fixtures/*.sql; do T=$(mktemp -d); sqlite3 "$T/b.db" < "$f" && echo "OK $f"; rm -rf "$T"; done
# 迁移前 quote 哈希/行数/主键记录：见 batches/P1-B02/evidence/s01-baseline.json
```

## S05 后的写入面（代码事实）

- MCP：INSERT suggestions(quote-only)/steps、status 更新、删除——**无 quote 更新路由**（update_suggestion 仅 status），故无结构化正文保护分支需求（如实声明）。
- sync：INSERT suggestions(quote-only)——同上。
- quote 更新路由仅存在于 Rust PATCH /api/suggestions/:id → 已由 `migrations::quote_update_allowed` 守卫（structured 行拒绝）。
