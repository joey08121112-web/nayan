# 贡献指南（Contributing）

谢谢你想给纳言出力。这个项目小而认真：**测试都是真组件**（真实 `index.html`、真实 Rust 后端、无头 Chrome、真实子进程），所以贡献流程的核心就一句话——**改动前后都跑全量测试，数字只能变好**。

## 环境准备

- macOS 13+，Apple 芯片（Intel 未测试）
- Xcode Command Line Tools（`xcode-select --install`）
- Rust（rustup）
- Node.js 22.5+（MCP 与同步服务使用内置 `node:sqlite`）
- `cd app && npm install`（装 @tauri-apps/cli）

## 跑测试

```bash
# 一键全量（约 4 分钟）：cargo + 全部 node 套件，逐项与 scripts/test-baseline.json 对账
node scripts/test-all.mjs

# 只跑你改到的部分
node scripts/test-all.mjs --only dom,rich

# Rust 侧
cd app/src-tauri && cargo test

# 单个套件（输出默认进系统临时目录，不会弄脏仓库）
node tests/renderer/dom.test.mjs
```

`test-all.mjs` 的判定：失败>0、退出码非 0、超时、**通过数比基线少**都会标红并以退出码 1 结束。比基线**多**是好事（绿），但请顺手把 `scripts/test-baseline.json` 里对应项的数字更新掉。

## 提 PR 前要过的关

1. `node scripts/test-all.mjs` 全绿，数字不比基线差（基线规则见上文「跑测试」）；
2. 如果你改了 `app/ui/index.html` 引入新的 js 文件：把它加进 `app/src-tauri/src/test_profile.rs` 的静态文件白名单，否则 real-app 系列测试里页面会直接报错；
3. 如果你改了数据库 schema（`app/src-tauri/src/migrations.rs`）：`schema-gate.mjs` 必须同口径更新，`tests/migrations/`（含 `schema-gate-consistency`、`external-writers`）必须全过；
4. `git status` 干净——测试不应往仓库写任何东西（输出目录默认都在系统临时目录）。

PR 会触发 CI（GitHub Actions，macos-14）：`cargo test --locked` 加无需图形界面的测试套件。CI 只覆盖一部分，本地全量仍然以 `node scripts/test-all.mjs` 为准。

## 约定

- **界面样式**：跟随现有 vanilla CSS 风格，不要引入前端框架/构建器；新样式不要发明新的卡片/按钮体系。
- **注释**：中文，讲「为什么」和「坑」，不复述代码。
- **数据安全**：测试与示例数据一律用合成内容，不要把真实用户数据写进代码或夹具。
- **隐私红线**：不要提交任何本机绝对路径（`/Users/...`）、密钥或真实收件内容；夹具一律用合成数据。
- **兼容**：外部写入方（MCP / sync-server）依赖 schema 门控，别做「只改一侧」的不兼容改动。

## 报问题

开 Issue 时请附：macOS 版本、纳言版本（设置 › 关于）、复现步骤、`~/Library/Application Support/com.nayan.app/nayan.log` 里相关的几行（**注意先摘掉你不想公开的内容**）。

安全问题请勿开公开 Issue，直接私下联系维护者。
