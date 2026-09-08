# 全局右键捕获设置（选中文字 → 右键 → 进收件箱）

两种方式，可同时用。

## 方式一：macOS 系统级右键 —— 任何 App 都能用（推荐）

原理：macOS「快捷指令」的"快速操作"会出现在所有 App 的选中文字右键菜单里——
包括终端里的 Claude Code / Codex / DeepSeek Harness，也包括浏览器网页。

一次性配置（约 2 分钟）：

1. 打开「快捷指令」App（启动台搜 Shortcuts）
2. 点 + 新建，顶部命名为：添加到建议收件箱
3. 右侧操作库搜索「运行 Shell 脚本」，双击添加
4. 面板里：
   - Shell 选 /bin/zsh
   - 输入传递方式选「作为自变量」或「至 stdin」均可
   - 脚本内容填一行：
     node "/Users/ami/Documents/deepseek harness/项目/记录软件/capture.js"
5. 右侧信息面板勾选「用作快速操作」，并勾选「文本」
6. 保存

用法：任意 App 里选中文字 → 右键 → 服务 → 添加到建议收件箱
首次触发时 macOS 可能弹权限请求，允许即可。
成功后右上角会出现系统通知「已收进：…」。

提示：在「系统设置 → 键盘盘 → 键盘快捷键 → 服务」里还可以给它绑定全局热键。

## 方式二：浏览器插件 —— 网页 AI 对话专用（带原文链接）

适用于 ChatGPT / Claude / Gemini 等网页版：选中文字右键直接出现
「📥 添加到建议收件箱」，卡片会自动带原页面标题和链接，点击可跳回原对话。

安装（一次性）：

1. Chrome 或 Edge 打开 chrome://extensions
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录下的 extension 文件夹
4. 在任意网页选中文字 → 右键 → 📥 添加到建议收件箱
5. 扩展图标角标显示 ✓ 表示入库成功

## 前提

收件箱服务需要在运行：

~~~bash
cd "/Users/ami/Documents/deepseek harness/项目/记录软件"
node server.js
~~~

没启动时捕获会通知「失败：请先启动 node server.js」。

## 测试

~~~bash
echo "手动测试一条" | DEBUG=1 node capture.js
~~~
