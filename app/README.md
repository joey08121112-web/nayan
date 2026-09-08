# 纳言（NaYan）· 桌面版

「建议收件箱」的正式桌面应用：Tauri 2 + Rust + SQLite，零外部依赖（不需要 Node 常驻）。

## 功能

- **菜单栏常驻**：托盘图标 → 打开收件箱 / 立即捕获 / 开机自启 / 退出；点关闭按钮 = 隐藏到菜单栏
- **全局快捷键捕获**：默认 `⌥⇧S`（避免和 Hammerspoon 的 ⌥S 冲突；确认稳定后可改）
  选中文字 → 快捷键 → 对话式小窗（可记一句想法）→ 吸入动效入箱
- **AI 拆步**：设置里配自己的 API Key（智谱 / DeepSeek / OpenAI / 自定义 OpenAI 兼容）
- **数据自动迁移**：首次启动自动使用本项目 `data/inbox.db` 历史数据（MCP server 继续读写同一个库）
- 浏览器版（`http://localhost:8787`，node server.js）与 App 共存互不影响，数据互通

## 开发

```bash
cd app
npm install
npx tauri dev     # 开发模式
npx tauri build   # 产出 app/src-tauri/target/release/bundle/macos/NaYan.app
```

## 改配置

配置文件：`~/Library/Application Support/com.nayan.app/config.json`

```json
{
  "provider": "glm",
  "base_url": "https://open.bigmodel.cn/api/paas/v4",
  "model": "glm-4.6",
  "api_key": "你的 Key",
  "hotkey": "alt+shift+s",
  "db_path": null
}
```

- `hotkey`：捕获快捷键（格式如 `alt+s` / `ctrl+alt+s`），改完重启 App 生效
- `db_path`：自定义数据库路径；默认自动用本项目的 `data/inbox.db`（有历史数据时）

## 首次使用（授权）

1. 打开 NaYan.app
2. 按 `⌥⇧S` 捕获文字（首次需授权）：
   系统设置 → 隐私与安全性 → **辅助功能** → 打开 NaYan
3. 菜单栏出现图标即常驻

## 重命名产品

改 `src-tauri/tauri.conf.json` 里的 `productName` 和 `identifier` 即可，图标在 `src-tauri/icons/`。
