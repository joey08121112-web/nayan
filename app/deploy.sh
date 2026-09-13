#!/bin/bash
# 纳言标准部署脚本：构建 → 优雅退出 → 同步 /Applications → 清理开发副本 → 启动
# 用法: bash deploy.sh   （在 app/ 目录下或任意位置执行）
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/Library/Developer/CommandLineTools/usr/bin/clang
export CC=/Library/Developer/CommandLineTools/usr/bin/clang
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk

echo "① 构建..."
npx tauri build > /tmp/tauri-build.log 2>&1 || { echo "✗ 构建失败"; tail -20 /tmp/tauri-build.log; exit 1; }
grep -E "Finished 1 bundle" /tmp/tauri-build.log || true

echo "② 优雅退出旧实例..."
osascript -e 'quit app "NaYan"' 2>/dev/null || true
for i in $(seq 1 10); do pgrep -f "NaYan.app/Contents/MacOS/nayan" >/dev/null || break; sleep 0.5; done
pkill -9 -f "NaYan.app/Contents/MacOS/nayan" 2>/dev/null || true
sleep 1

echo "③ 同步 /Applications..."
rm -rf /Applications/NaYan.app
cp -R "src-tauri/target/release/bundle/macos/NaYan.app" /Applications/
rm -rf "src-tauri/target/release/bundle/macos"          # 开发副本不进 Spotlight
touch "src-tauri/target/.metadata_never_index"          # 整个 target 树防索引（重建后仍在）

echo "④ 启动..."
open /Applications/NaYan.app
sleep 3
pgrep -f "NaYan.app/Contents/MacOS/nayan" >/dev/null && echo "✓ 部署完成，运行中" || { echo "✗ 启动失败"; exit 1; }
tail -1 "$HOME/Library/Application Support/com.nayan.app/nayan.log"
