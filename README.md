# 建议收件箱（阶段 1 MVP）

把散落在各个 AI 编程助手（DeepSeek Harness / Claude Code / Codex / OpenCode / Z Code…）
会话里的好建议，收集成一个带来源追溯的本地待办池。一次只专注一条。

> 🚀 **产品化进行中**：`app/` 目录是正式桌面应用（工作代号 **纳言 NaYan**，Tauri 2 + Rust 实现）——
> 菜单栏常驻、全局快捷键捕获、对话框小窗、开机自启，直接双击 NaYan.app 使用，
> 自动迁移本项目 data/inbox.db 的历史数据。见 `app/README.md`。

## 启动

~~~bash
cd "/Users/ami/Documents/deepseek harness/项目/记录软件"
node server.js        # 或 npm start
~~~

然后浏览器打开 http://localhost:8787

- 数据库：data/inbox.db（SQLite 单文件，备份它即可）
- 换端口：PORT=9000 node server.js
- 零依赖：只需 Node 22+（内置 node:sqlite），不需要 npm install

## 功能（对应路线图第 1 阶段）

- 快速添加：摘要（必填）+ AI 原文 + 我的想法 + 来源工具 + 项目路径
- 收件箱流：专注中 → 待办 → 收件箱 → 完成 排序，来源一目了然
- 状态流转：收件箱 → 待办 → 专注中 → 完成 / 放弃，可重新打开
- 一次只专注一条：点「开始专注」时，上一条专注中的自动退回待办
- 筛选：按状态统计与过滤

## 功能（v0.3 新增）

- **步骤清单**：卡片可拆成多步，做一步勾一步；命令步骤点 ⧉ 一键复制，不怕聊天记录被顶上去
- **批量入箱**：AI 一次把多条建议逐条入库（MCP add_suggestions）
- **AI 拆步**：点卡片「🪄 AI 拆步」调用你自己配的大模型 API（OpenAI 兼容格式，Key 只存本机 data/config.json，⚙️ 里配置）
- **⌥S 全局捕获**：任何 App（含 ZCode / WorkBuddy / TRAE / 终端）选中文字 → ⌥S → 对话式小窗（可记想法）→ 吸入收件箱，见 HAMMERSPOON-SETUP.md
- **界面**：Clippop 风格侧栏 + 按天分组卡片网格 + 🌙/☀️ 深浅色切换 + 页面每 4 秒自动刷新

## HTTP API（阶段 2 的 MCP server 将调用这些接口）

~~~text
GET    /api/suggestions              列表（?status=&tool=&q= 过滤）
POST   /api/suggestions              新增 {title, quote?, my_note?, source_tool?, workspace?, ...}
PATCH  /api/suggestions/:id          更新（status: inbox|todo|doing|done|dropped）
DELETE /api/suggestions/:id          删除
~~~

## 阶段 2 已完成：MCP 接入

mcp-server.js 提供 7 个工具：add_suggestion / add_suggestions（批量）／ list_suggestions /
update_suggestion / set_steps（拆步骤清单）／ add_step / update_step。
按 MCP-SETUP.md 注册到你的 AI 工具后，对话里说「把这个建议记到收件箱」「把 #12 拆成步骤」即可自动入库
（自动带上来源工具和项目路径）。协议验证：node test-mcp.mjs

---

## 服务常驻（已配置）

本机已安装 launchd 服务 `com.suggestion-inbox.server`：**开机自启、崩溃自动重启**，
无需手动运行 node server.js。网页地址 http://localhost:8787 常年可用。
日志：data/server.log / data/server.err.log。
手动管理命令：

```bash
launchctl kickstart -k gui/$(id -u)/com.suggestion-inbox.server   # 重启服务
launchctl bootout gui/$(id -u)/com.suggestion-inbox.server        # 停止并移除
```
