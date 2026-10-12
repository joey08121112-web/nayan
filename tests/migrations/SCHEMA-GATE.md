# 服务 schema 门控与 Rust 规格一致性矩阵（P1-B02-REPAIR-03 / R3-F01）

共享模块：`schema-gate.mjs`（仓库根，MCP/sync 复用；本轮授权新增）。
被对齐的 Rust 规格：`app/src-tauri/src/migrations.rs` 的 ColSpec 体系（SUG_V2_SPECS/SUG_LEGACY_SPECS 链/STEPS/ATTACHMENTS/SESSION_ALIASES）。

## 接受规则（两服务同一入口，v2 与 legacy 同核验）

| 库形态 | 判定 | 依据（Rust 同口径） |
|---|---|---|
| Rust 迁移产出的 v2（四表+全列+content_envelope，类型/NOT NULL/主键全符） | 接受 | validate_current_v2 |
| legacy v0-4（核心 13 列，无 user_msg/window_id/envelope） | 接受（quote-only INSERT 兼容） | validate_legacy_v0 链 |
| legacy v0-5（+user_msg） | 接受 | 同上 |
| legacy v1 未版本化（+window_id，uv=0——现行生产真实形态） | 接受 | 同上（Rust 规格选择器同款三分支） |
| quote TEXT→INTEGER（任一版本） | **拒绝**（错误指明 quote 类型漂移） | validate_table_structure |
| CTAS 丢主键/NOT NULL/类型（id INT、title INTEGER、title 可空…） | 拒绝 | 同上 |
| attachments(id) 残库 / 缺表 / 未知表 / 未知列 | 拒绝 | known_tables_only/no_unknown_columns |
| 伪 v2（v1 表标 uv2，缺 envelope）/ v0 却有 envelope / 未来版本 | 拒绝 | 版本-形态矛盾 |
| 缺服务实际 INSERT 使用列（含 sync 的 session_ref） | 拒绝（列集合精确相等） | 同上 |
| v0-4（无 user_msg） | 接受；**MCP**：INSERT 本就不含 user_msg → 原样可写；**sync**：INSERT 列集按库实际列动态构建（无 user_msg 分支），quote-only 原样可写（R4-F01 兼容写入） | validate_legacy_v0 链（v0-4 最早期核心列） |

## 一致性测试

`tests/migrations/schema-gate-consistency.mjs`：同一批合成库先取 Rust 真实判定
（open_and_migrate 驱动，exit0=接受），再过 JS 门控，断言 9 组矩阵双方一致
（正例 3：Rust-init v2 / v1-full / v0-5 legacy；负例 6：quote INTEGER v0/v2、
CTAS、attachments(id)、伪 v2、v0+envelope）。

## 真实服务矩阵（external-writers.mjs，23 例）

A–J2（11 既有）+ K 系列（12 新增）：KM0/KS0/KM2/KS2 四组合 quote INTEGER
（因 quote 类型被拒，错误信息核验）；K5 拒绝后 schema/版本/pragma 逐项不变；
K6 正例 TEXT 库写入逐字符文本保留（typeof=text）；K7 MCP v2 丢主键（修正上轮
不实声明）；K8a/b/c title INTEGER / NOT NULL 丢失 / 缺 session_ref。

## 边界

- **服务可写能力声明（R4-F01 修正）**：gate 通过 ≠ 两服务行为全同——v0-4 形态 MCP 的 INSERT 天然不含 user_msg；sync 自 R4 起按库实际列集选择 INSERT 分支（v0-4 走无 user_msg SQL + 参数集同步剔除；v0-5/v1/v2 维持含 user_msg 形态）。两服务对全部已接受形态的实际 INSERT 用列均已逐项核对（L1–L5 真实服务用例 + K8c 反例）。
- 门控为纯只读预检（PRAGMA），在任何持久写入与服务就绪信号之前；不修库。
- legacy 通过后仍只允许 quote-only INSERT（结构化正文保护在 Rust 侧）。
- 未升级旧二进制不受控制；闲置连接/全局锁不属本模块（见恢复 guard 边界）。
