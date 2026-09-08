# 纳言捕捉 · 浏览器扩展

把网页里值得留住的内容框选进 NaYan 收件箱。实现思路移植自 Wispal 的框选引擎拆解（见项目根目录 `WisPal深度拆解.html`）。

## 安装（开发者模式）

1. Chrome 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 点「加载已解压的扩展程序」，选择本目录（`extension/`）
3. 确保 NaYan 收件箱在跑：桌面 App 打开即可（或 `node server.js`，监听 `localhost:8787`）

## 三种入口

| 入口 | 操作 | 适用 |
|---|---|---|
| 浮动气泡 | 页面右缘圆形按钮，点按开始框选，拖动可移位置 | AI 对话站点（ChatGPT / Claude / Gemini / DeepSeek / Kimi / 通义 / 元宝 / 豆包 / 智谱 / Grok 等，自动出现） |
| 快捷键 | `⌘⇧Y`（Mac）/ `Ctrl+Shift+Y`（Win） | 任何网页 |
| 右键菜单 | 「🖼 框选捕获此页」 / 「📥 选中内容存入纳言」 | 任何网页；后者沿用旧的划词直存 |

## 框选流程

1. 进入框选：页面暗化、十字光标、底部提示胶囊
2. 拖一个矩形：覆盖到的**文本块**实时珊瑚色高亮，矩形变橙表示有命中；拖到屏幕上下边缘自动滚动
3. 松手：块去重合并（外层块优先），弹出玻璃批注卡
4. 批注卡：原文可编辑、「我的想法」可留空、可选项目归类（含 ＋ 新项目）→「存入收件箱」
5. 成功后可「继续框选」连续捕捉，或「打开收件箱 ↗」查看

入库字段：`quote` = 框选原文，`my_note` = 想法，`source_tool = webbox`（UI 显示「网页框选」），
`session_ref = 页面标题 | URL`（桌面端卡片渲染成「在来源中查看 ↗」跳回本页）。

## 技术说明

- 入库请求经 background service worker 中转（页面内 fetch localhost 会被 CORS 拦截）
- 内容脚本幂等：重复注入只唤起不重复装配（`window.__NAYAN_CAPTURE__` 标记）
- 快捷键/工具栏点击走 `activeTab` + `scripting` 注入，不申请全站 host 权限
- 尊重 `prefers-reduced-motion`；Esc 随时退出并回滚全部 UI
