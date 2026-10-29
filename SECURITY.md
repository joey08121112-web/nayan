# 安全策略（Security Policy）

> English summary: please report vulnerabilities privately via GitHub's Private Vulnerability Reporting (Security tab → Report a vulnerability), not in public issues.

## 支持的版本

| 版本 | 是否支持 |
| --- | --- |
| 0.4.x | ✅ |
| ≤ 0.3.x | ❌（请升级至最新 0.4.x） |

## 本地安全边界

- **API Key 凭据保护**：自 `v0.4.0` 起，用户在「设置 › AI」中配置的第三方大模型 `api_key` 存储在 macOS 系统登录钥匙串（`com.nayan.app` / `ai_api_key`）中，`config.json` 仅保留非敏感设置且文件权限收紧为 `0600`。
- **本机扩展端口防护（`127.0.0.1:8787`）**：仅绑定回环地址 `127.0.0.1`，严格校验 `Origin` 请求头（拒绝来自普通 `http://` / `https://` 网页的跨站请求）并校验 `POST` 请求的 `Content-Type: application/json`，且可在「设置 › 捕获」中随时关闭。
- **单实例唤醒端口（`127.0.0.1:58777`）**：仅绑定 `127.0.0.1`，并要求固定握手口令（`nayan:show`）通过后才会唤醒主窗口；端口被其他程序占用时纳言照常启动，不会误判为已在运行而退出。

## 如何报告安全漏洞

请使用 GitHub 仓库的**私密漏洞报告**（Private vulnerability reporting）：仓库页 → **Security** 标签 → **Report a vulnerability**。

- 请**不要**用公开 Issue、公开 PR 或讨论区报告安全问题。
- 报告里请尽量包含：影响的纳言版本（设置 › 关于）、macOS 版本与芯片、复现步骤、影响面评估。
- 我们会在收到后尽快确认（目标 7 天内），修复与披露的时间节奏双方商定。

## 披露

修复发布后，经报告者同意，我们会在仓库里公布漏洞摘要与致谢。
