# 把「建议收件箱」接入你的 AI 工具（阶段 2 已完成）

MCP server：/Users/ami/Documents/deepseek harness/项目/记录软件/mcp-server.js

提供 7 个工具（stdio 传输，零依赖，直接 node 运行）：

- add_suggestion —— 把一条建议写进收件箱（自动记录来源工具和项目路径）
- add_suggestions —— **批量**逐条入箱（「把这几条建议都记下来」用这个，一次传全部条目）
- list_suggestions —— 读取收件箱（开工前让 AI 接着上次继续；带步骤清单）
- update_suggestion —— 更新状态（做完标记 done）
- set_steps —— 把某条建议整理成有序步骤清单（「把 #12 拆成步骤」，命令保持原样并标 is_cmd）
- add_step —— 给某条建议追加一步
- update_step —— 步骤打勾 / 改内容

## Claude Code

本项目已配好（.mcp.json，进入本目录自动生效）。想让**所有项目**都能用，运行：

~~~bash
claude mcp add --scope user suggestion-inbox -- node "/Users/ami/Documents/deepseek harness/项目/记录软件/mcp-server.js"
~~~

## Codex CLI

编辑 ~/.codex/config.toml，加入：

~~~toml
[mcp_servers.suggestion-inbox]
command = "node"
args = ["/Users/ami/Documents/deepseek harness/项目/记录软件/mcp-server.js"]
~~~

## OpenCode

项目根目录的 opencode.json：

~~~json
{
  "mcp": {
    "suggestion-inbox": {
      "type": "local",
      "command": ["node", "/Users/ami/Documents/deepseek harness/项目/记录软件/mcp-server.js"]
    }
  }
}
~~~

## DeepSeek Harness

DSH 内置 MCP 客户端（支持 stdio / streamable-http）。在配置中添加一个 MCP server：

- transport: stdio
- command: node
- args: ["/Users/ami/Documents/deepseek harness/项目/记录软件/mcp-server.js"]

## 怎么用

配好后在任意对话里说：

- 「把这个建议记到收件箱：给设置页加防抖」→ AI 调 add_suggestion，自动带上项目和工具名
- 「把这几条建议逐条记到收件箱」→ AI 调 add_suggestions，一次全部入库
- 「读一下我的建议收件箱」→ AI 调 list_suggestions，接着上次没做完的继续
- 「把 #12 拆成步骤清单，命令标出来」→ AI 调 set_steps
- 「#12 的第一步做完了」→ AI 调 update_step 打勾
- 「这条做完了，#4」→ AI 调 update_suggestion 标记 done

## 验证

~~~bash
node test-mcp.mjs
~~~

## ZCode（智谱）

用户级配置文件：~/.zcode/cli/config.json ，在顶层加入：

```json
{
  "mcp": {
    "servers": {
      "suggestion-inbox": {
        "command": "node",
        "args": ["/Users/ami/Documents/deepseek harness/项目/记录软件/mcp-server.js"]
      }
    }
  }
}
```

也可以在 ZCode 设置面板 → MCP → 完整配置模式里直接粘贴上面的 JSON。
保存后重开项目即生效；对话里说「把这个建议记到收件箱」即可入库，卡片来源会显示为 Z Code。

## Antigravity（Google）

配置文件：~/.gemini/antigravity/mcp_config.json （实际指向 ~/.gemini/config/mcp_config.json）
在 mcpServers 里加入：

```json
"suggestion-inbox": {
  "command": "node",
  "args": ["/Users/ami/Documents/deepseek harness/项目/记录软件/mcp-server.js"]
}
```

也可以在 Antigravity 里：Agent 面板「…」→ MCP Servers → Manage MCP Servers → View raw config 直接编辑。
保存后重启 Antigravity 生效。（本机已由助手自动合并完成，备份为 mcp_config.json.bak-inbox）
