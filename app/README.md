# 纳言（NaYan）· 桌面版

「建议收件箱」的 macOS 桌面应用：Tauri 2 + Rust + SQLite，零外部依赖（不需要 Node 常驻）。

## 功能

- **菜单栏常驻**：托盘图标 → 打开收件箱 / 立即捕获 / 开机自启 / 退出；点关闭按钮 = 隐藏到菜单栏
- **全局快捷键捕获**：
  - `⌥⇧S` 划词快记：选中文字 → 快捷键 → 对话式小窗（可记一句想法）→ 入箱
  - `⌥⇧X` 框选识别：框选屏幕区域 → 保存区域原图 + 本地 OCR 识别文字入箱
- **AI 可选增强（默认关闭）**：设置里可配自己的 API Key（智谱 / DeepSeek / OpenAI 兼容 / 本机 Ollama），支持阅读页「✦ AI 整理」、拆成步骤、同题对比、排成清单与起短标题；关闭时全部走本地规则处理
- **外部通道互通**：默认数据库位于 `~/Library/Application Support/com.nayan.app/inbox.db`，与仓库根目录的 `mcp-server.js` 及 `sync-server.js` 共享同一主库

## 开发与构建

```bash
cd app
npm install
npx tauri dev     # 开发模式
npx tauri build   # 产出 app/src-tauri/target/release/bundle/macos/NaYan.app 与 dmg
```

日常开发机可使用一键脚本完成构建、替换 `/Applications/NaYan.app` 并重启：

```bash
bash app/deploy.sh
```

## 数据与配置目录

运行数据存放在 `~/Library/Application Support/com.nayan.app/`：

- `inbox.db`：SQLite 主数据库（启动时由 Rust 端权威迁移自动初始化或升级）
- `config.json`：应用设置（快捷键、AI 来源与各功能开关、剪贴板监听名单等，均可在应用内「设置」直接修改并即时生效）
- `nayan.log`：运行日志

## 首次使用（系统权限）

1. 打开 `NaYan.app`（首次打开会有三步引导）
2. **划词收录（`⌥⇧S`）**：需在「系统设置 › 隐私与安全性 › 辅助功能」中开启纳言
3. **框选收录（`⌥⇧X`）**：需在「系统设置 › 隐私与安全性 › 屏幕录制」中开启纳言

## 调整应用标识与图标

修改 `src-tauri/tauri.conf.json` 里的 `productName` 和 `identifier` 即可，图标位于 `src-tauri/icons/`。
