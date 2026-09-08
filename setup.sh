#!/bin/bash
# 「建议收件箱」一键配置：服务常驻 + 自动注册到已装的 AI 工具
# 重复运行安全（幂等）
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || true)"
[ -z "$NODE" ] && echo "未找到 node，请先安装 Node.js (https://nodejs.org)" && exit 1
SCRIPT="$DIR/mcp-server.js"

echo "== 1/3 网页服务 =="
if curl -s -o /dev/null -m 2 http://localhost:8787/; then
  echo "  已在运行，跳过"
else
  PLIST="$DIR/com.suggestion-inbox.server.plist"
  if [ -f "$PLIST" ]; then
    mkdir -p "$HOME/Library/LaunchAgents"
    cp "$PLIST" "$HOME/Library/LaunchAgents/com.suggestion-inbox.server.plist"
    launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.suggestion-inbox.server.plist" 2>/dev/null \
      || launchctl load -w "$HOME/Library/LaunchAgents/com.suggestion-inbox.server.plist" 2>/dev/null
  else
    mkdir -p "$DIR/data"
    nohup "$NODE" "$DIR/server.js" >> "$DIR/data/server.log" 2>&1 &
  fi
  sleep 1
fi
curl -s -o /dev/null -m 3 http://localhost:8787/ && echo "  OK" || echo "  未就绪（可稍后手动 node server.js）"

echo "== 2/3 注册到 AI 工具（自动检测已装的）=="
if command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -q suggestion-inbox; then echo "  Claude Code: 已注册"; 
  else claude mcp add --scope user suggestion-inbox -- "$NODE" "$SCRIPT" >/dev/null 2>&1 && echo "  Claude Code: OK"; fi
else echo "  Claude Code: 未安装，跳过"; fi

if [ -f "$HOME/.codex/config.toml" ]; then
  if grep -q "suggestion-inbox" "$HOME/.codex/config.toml"; then echo "  Codex: 已注册";
  else printf '\n[mcp_servers.suggestion-inbox]\ncommand = "node"\nargs = ["%s"]\n' "$SCRIPT" >> "$HOME/.codex/config.toml" && echo "  Codex: OK"; fi
else echo "  Codex: 未安装，跳过"; fi

if [ -f "$HOME/.zcode/cli/config.json" ]; then
  if grep -qE "suggestion-inbox|记录对话" "$HOME/.zcode/cli/config.json" 2>/dev/null; then echo "  ZCode: 已注册";
  else "$NODE" "$DIR/merge-mcp.mjs" "$HOME/.zcode/cli/config.json" zcode "$SCRIPT" && echo "  ZCode: OK"; fi
else echo "  ZCode: 未安装，跳过"; fi

AG=""
[ -f "$HOME/.gemini/config/mcp_config.json" ] && AG="$HOME/.gemini/config/mcp_config.json"
[ -z "$AG" ] && [ -f "$HOME/.gemini/antigravity/mcp_config.json" ] && AG="$HOME/.gemini/antigravity/mcp_config.json"
if [ -n "$AG" ]; then
  if grep -q "suggestion-inbox" "$AG" 2>/dev/null; then echo "  Antigravity: 已注册";
  else "$NODE" "$DIR/merge-mcp.mjs" "$AG" agents "$SCRIPT" && echo "  Antigravity: OK"; fi
else echo "  Antigravity: 未安装，跳过"; fi


# 全局右键快速操作（Automator 服务，自动安装）
WF_DIR="$DIR/添加到建议收件箱.workflow"
if [ -d "$WF_DIR" ]; then
  mkdir -p "$HOME/Library/Services"
  rm -rf "$HOME/Library/Services/添加到建议收件箱.workflow"
  cp -R "$WF_DIR" "$HOME/Library/Services/" && /System/Library/CoreServices/pbs -flush 2>/dev/null
  echo "  全局右键服务: OK"
fi

echo "== 3/3 打开收件箱 =="
open "http://localhost:8787"
echo ""
echo "完成！剩余两件可选项（见 CAPTURE-SETUP.md）："
echo "  · 浏览器右键：chrome://extensions 加载 extension 文件夹"
echo "  · 全局选中右键：创建快捷指令（一次性 2 分钟）"