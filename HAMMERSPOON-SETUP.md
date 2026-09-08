# ⌥S 全局捕获（Hammerspoon）—— 任何 App 都能收

> 🚀 **正式桌面版（app/ 目录，NaYan.app）已经内置了这个能力**，默认热键 `⌥⇧S`，与 Hammerspoon 的 ⌥S 互不冲突。
> 等你确认 App 捕获好用了，可以二选一：
> - 让 App 用回 ⌥S：把 `~/Library/Application Support/com.nayan.app/config.json` 里 `"hotkey"` 改成 `"alt+s"`，
>   然后禁用 Hammerspoon 这套（菜单栏 🔨 → 停用，或直接退出 Hammerspoon）；
> - 或者继续让 Hammerspoon 负责 ⌥S，App 用 ⌥⇧S。

## 为什么需要它

ZCode / TRAE / WorkBuddy / Antigravity 这类 Electron 应用，右键用的是**自己的菜单**，
根本不加载 macOS 系统的「服务」菜单——所以 CAPTURE-SETUP.md 那条系统右键路在这些 App 里点不出来。
Hammerspoon 走的是"选中 → 模拟 ⌘C → 读剪贴板"，只要能复制的 App 全都能用。

## 已自动完成（本机）

- ✅ Hammerspoon 已通过 Homebrew 装好（`brew install --cask hammerspoon`）
- ✅ 配置已写入 `~/.hammerspoon/init.lua`，热键 **⌥S**，带预览小窗和"吸入"动效

## 你只需要做一次（约 1 分钟）

1. 打开 Hammerspoon（应用程序里，菜单栏出现 🔨 图标即常驻）
2. 选中任意文字按 ⌥S，首次会弹权限请求：
   系统设置 → 隐私与安全性 → **辅助功能** → 勾选 Hammerspoon
3. 如果还是没反应：菜单栏 🔨 → Reload Config

## 用法

任意 App 选中文字 → **⌥S** → 右下角弹出**对话式小窗**（Gemini 风格：显示抓到的文字、来源 App 和 📁 项目，
可顺手记一句想法）→ 点「收进收件箱」或按 ⏎ → 卡片吸入右下角 + "✓ 已收进"提示；「取消」或 Esc 放弃。
收件箱页面每 4 秒自动刷新，新卡片不用手动刷新就能看到。

**自动记录来源**：卡片会带上前台 App 名字 + 窗口标题；如果窗口标题里的项目名
（通常在"|"后面）能在 文稿 / 桌面 / Projects / workspaces 下找到同名文件夹，
还会自动解析成真实路径写进卡片的 📁 位置。

> 小窗本质是一个本地网页（capture-mini.html），改样式只需编辑那个文件，不用动 init.lua；
> webview 万一创建失败，会自动退回简易小窗（hs.canvas 版）。

## 换热键

编辑 `~/.hammerspoon/init.lua` 顶部的 `HOTKEY_MODS` / `HOTKEY_KEY`，
保存后菜单栏 🔨 → Reload Config。

## 抓不到文字？（v2 有诊断日志）

v2 的抓取是双保险，顺序如下：

1. **方法一（首选）**：macOS 辅助功能**直接读**焦点元素的选中文字——不碰剪贴板、不模拟按键。
   对 Electron 应用（ZCode / TRAE / VS Code 等）会自动打开它们的"手动无障碍"开关（AXManualAccessibility）。
2. **方法二（兜底）**：模拟 ⌘C，最多等 1.2 秒看剪贴板变化。

哪一步失败，屏幕上的提示会直接说原因；详细日志在 `~/.hammerspoon/capture.log`，
反复失败时把这个文件内容发给 AI，一眼就能定位是哪一环断了。

## 与其他通道的关系

| 通道 | 适用 | 说明 |
|---|---|---|
| ⌥S 热键（本文档） | 任何 App，最全 | 主力通道 |
| 系统右键 → 服务 | 原生 App（Safari/TextEdit/访达…） | 见 CAPTURE-SETUP.md |
| 浏览器插件 | 网页 AI 对话 | 自动带原对话链接 |
| MCP（对 AI 说） | 接了 MCP 的工具 | AI 自己拆好逐条入库，见 MCP-SETUP.md |
