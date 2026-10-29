# 隐私说明（Privacy）

> English summary: NaYan keeps everything on your Mac. It makes no network requests on its own — the only outbound traffic goes to an AI provider you explicitly configure, and only when you use an AI feature. No analytics, no crash reporting, no update checks, no accounts, no cloud sync.

对应版本：0.3.1。

## 你的数据都在这台电脑上

纳言是本地优先的应用，没有云端。全部数据存放在一个目录里：

```
~/Library/Application Support/com.nayan.app/
├── inbox.db      全部记录（SQLite：建议、步骤、清单、同题对比、回收站）
├── config.json   设置（含你填的 AI API Key，见下文）
└── nayan.log     运行日志
```

- **附件不复制文件**：一条记录的附件只是记住原文件在本机的路径，原件在哪里仍在那里；删除记录不会动到原文件。
- **删除全部数据**：退出纳言后删掉上面这个目录，数据就全部消失了。没有别处副本。

## 什么时候会联网

**默认情况下（不配置 AI），纳言不发出任何网络请求。**

唯一会联网的情形：你在「设置 › AI」选择「自己的 Key」，并主动使用已开启的 AI 功能——包括**拆成步骤、同题对比拆要点、排成清单、起短标题，以及阅读页「✦ AI 整理」（理成要点 / 清理排版 / 重起标题）**——时，纳言会把**当时那条内容的标题与正文**（若你在设置里填写了「给 AI 的补充要求」，也会随系统提示词一并附上）直接发给你选定的服务商，结果直接返回本机。源码内置的可选地址：

| 服务商 | 请求地址 |
| --- | --- |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` |
| DeepSeek | `https://api.deepseek.com` |
| OpenAI | `https://api.openai.com/v1` |
| 本机 Ollama | `http://127.0.0.1:11434/v1`（不出本机） |
| 自定义 | 你自己填写的 OpenAI 兼容 base_url |

- API Key 只保存在本机 `config.json`，不会出现在任何请求目的地之外的地方。
- 各项 AI 功能在「设置 › AI」里均有独立开关（关闭时自动走本机规则处理，不发网络请求）；每个 AI 功能第一次使用前，界面都会明确提示这段内容将发给哪家服务商，可以随时拒绝。
- 「纳言订阅」尚未推出。在它推出之前，纳言没有官方服务器。

## 只在本机回环地址上的通信

| 端口 | 谁在用 | 说明 |
| --- | --- | --- |
| 58777 | 桌面 App | 单实例守卫（防止同时开两个纳言），只绑定 `127.0.0.1`，只接受本机连接 |
| 8787 | `sync-server.js`（可选） | 给浏览器扩展用的本机写入服务；需要时手动运行，只绑定 `127.0.0.1` |
| — | `mcp-server.js`（可选） | 给 AI 编程助手用的 MCP 服务器，stdio 进程通信，不使用网络 |

浏览器扩展只在 `extension/manifest.json` 列出的 AI 对话网站上运行，读取你在页面里选中的内容，只发给本机的 `http://localhost:8787`，不发往任何外部地址。桌面 App 的界面与后端之间通过 App 内部通道通信，不监听网络端口。

## 没有的东西

纳言不包含、也不打算悄悄添加：

- 统计、分析、遥测
- 崩溃收集与上报
- 自动更新检查
- 账号、登录、云同步
- 广告与第三方追踪

## 系统权限

| 权限 | 用在哪 | 不授权会怎样 |
| --- | --- | --- |
| 辅助功能（Accessibility） | 划词收录时读取选中文字与来源窗口 | 划词收录不可用，其余功能正常 |
| 屏幕录制（Screen Recording） | 框选截图与本地文字识别（OCR） | 框选收录不可用，其余功能正常 |

两项权限都按需授予，可以只给一项，也可以都不给（用「记一条」手动输入、MCP、扩展等通道不受影响）。
