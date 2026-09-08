# 原生化路线：替换 Hammerspoon（三步走）

> 目标：框选/划词捕获全部做进 NaYan.app 自身（Rust + Apple 公开 API），HS 退场。
> 全程零第三方许可依赖：AX（辅助功能）、CGEvent（模拟按键）、NSPasteboard（剪贴板）、Vision（OCR）都是系统 API。
> 原则：每步结束都有一个**能日用**的东西，验收通过再进下一步。

---

## 第 0 步 · 权限地基（半天，随第 1 步一起做）

NaYan 要自己持有「辅助功能」权限（现在这个权限授给了 Hammerspoon）。

- `ax_capture.rs` 里实现 `ax_trusted()` 检测（`AXIsProcessTrustedWithOptions`）
- 未授权时：捕获窗口引导 → 一键深链打开系统设置对应面板
  `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
- ⚠️ 关键坑：TCC 授权跟随**代码签名**。开发期用固定的自签 identity 签 app（`signingIdentity`），
  否则每次重新 build 都可能要重新勾授权。上架用 Developer ID 签名，天然稳定。

---

## 第 1 步 · 原生划词捕获（替换 ⌥S）｜约 1 天

**做什么**：按 ⌥⇧S，NaYan 自己完成"读取选中文字"，不再依赖 HS。

**新建 `app/src-tauri/src/ax_capture.rs`**：

```
frontmost_app()          -> (pid, 应用名, 窗口标题)
read_selected_text(pid)  -> Result<String, AxError>
  ① AXUIElementCreateApplication → AXFocusedUIElement → AXSelectedText
  ② Chromium/Electron 系：先设 AXManualAccessibility=true，等 0.6~1.2s 再读（尖峰已验证）
  ③ 读到 AXSelectedTextRange 时顺带取 AXBounds（选中区域屏幕坐标，第 3 步 OCR 要用）
simulate_copy()          -> Result<String>   // ⌘C 兜底：CGEvent 发键 + changeCount 轮询
                                             //  + 用完恢复原剪贴板（现有 HS 版没做的改进）
```

**三级降级链**（每次捕获在日志和小窗标注走的哪条通道）：

```
AX 直读（干净、快） → 模拟 ⌘C（万能兜底） → 提示"该 App 不支持，试试框选 ⌥⇧X"
```

**接线**：热键 handler 调 ax_capture → 文本仍走现有 `capture-data` 事件 → 现有 capture 小窗
（想法 + 项目记忆 + 来源自动记录，一行 UI 不用改）。`resolveWorkspace`（窗口标题猜项目路径）从 Lua 移植进 Rust。

**验收**：备忘录 / Safari / Chrome / Obsidian / 终端 五个靶子实测——前四个走 AX 通道且剪贴板未被覆盖，
终端自动落到 ⌘C 通道。HS 的 ⌥⇧S 绑定解除（init.lua 注释掉热键，其余保留）。

---

## 第 2 步 · 框选原生化（替换 ⌥⇧X）｜约 1~2 天

**做什么**：把 HS 的框选搬进 NaYan，成为产品自带能力，视觉升到产品级。

**新窗口**：`boxselect`（tauri.conf.json 注册）——全屏透明 WebviewWindow（光标所在屏），
`transparent + always_on_top + decorations:false`，overlay UI 用扩展那套液态玻璃视觉
（暗化遮罩 + 虚线选框 + 底部提示胶囊 + 命中块珊瑚色高亮，`prefers-reduced-motion` 降级）。

**数据流**（复用 capture-data 的事件模式）：

```
⌥⇧X → 开 overlay + Rust 后台线程 AX 走查（预取，大页面 1~3s，提示"正在读取界面文本…"）
    → 候选块（文本+屏幕坐标，上限 2500）推给 overlay
    → JS 里做矩形映射（纯算术，不 IPC）：垂直覆盖≥50% 且横向≥24px，或面积≥45%
    → 松手：选中块文本回传 Rust → 行/段落重组（移植 boxCompose：同行合并+行距分段+中英空格）
    → 现有 capture 小窗 → 入箱
Esc / 拖动过小 → 取消并回滚
```

**配置**：`config.json` 加 `"hotkey_box": "alt+shift+x"`。多屏 v1 只做光标所在屏（与 HS 版一致），全屏多屏留待后续。

**验收**：Chrome 文章框选一段 → 文本质量 ≈ HS 版（段落可读、无碎片行）；
Obsidian / 备忘录 同样可用；拖拽跟手、取消干净。两条 ⌥⇧X 通道并存灰度几天，HS 版确认无优势后删。

---

## 第 3 步 · 剪贴板被动通道 + OCR 兜底｜约 1.5 天

**3a 剪贴板监听（性价比最高，半天）**：

- 每 2s 轮询 `NSPasteboard.changeCount`（检测变化**不触发**系统隐私提示）
- 有新复制 → 菜单栏轻提示带预览："收进纳言？（⏎ 直接入箱 / 点开补想法）"
- 规则：忽略 NaYan 自己写入的、忽略 <10 字符、可开关
- ⚠️ macOS 15+ 首次读剪贴板**内容**会弹一次系统「允许粘贴」，引导点一次即可

**3b OCR 兜底（1 天）**：

- 触发：捕获小窗加「🖼 截屏识别」按钮 + 热键 ⌥⇧C
- 流程：复用第 2 步的 overlay 框选 → `CGWindowListCreateImage` 截取该区域 →
  `VNRecognizeTextRequest`（zh-Hans + en）→ 文本进捕获小窗
- 需要用户授「屏幕录制」权限（同样做引导深链）
- 适用：终端输出、视频字幕、AX 读不到的自绘界面

**设置页**：设置面板加「捕获通道」区（划词/框选/剪贴板监听/OCR 四个开关 + 热键自定义）。

---

## HS 退场条件与迁移

- 第 1、2 步原生化版本**日用一周**无回退 → 删 init.lua 里的捕获段（框选 + ⌥S），HS 仅留你自用的其他脚本
- 迁移清单：热键语义不变（⌥⇧S 划词 / ⌥⇧X 框选）、`capture.log` 日志改写入 NaYan 自己的日志、
  resolveWorkspace 行为对齐（同为"窗口标题最后一段在常见目录找路径"）

## 风险与对策

| 风险 | 对策 |
|---|---|
| 重编译后辅助功能授权失效 | 开发期固定自签 identity；上架 Developer ID |
| AX 各 App 差异大 | 三级降级链 + 验收矩阵实测；日志标通道便于排障 |
| Chromium AX 树过大导致慢 | 后台预取 + 候选上限 2500 + 深度/节点熔断 |
| macOS 15+ 剪贴板隐私提示 | 文档说明 + 设置页引导，一次授权 |
| Overlay 窗口在 Tahoe 的渲染怪象（红绿灯前科） | 第 2 步先做透明无框窗口实测，有怪象换 NSPanel 方案 |

## 总工作量

第 1 步 1 天 → 第 2 步 1~2 天 → 第 3 步 1.5 天，全程以现有 HS 版为对照基准（算法都是验证过的，只是换语言落地）。
