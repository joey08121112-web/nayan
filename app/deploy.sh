#!/bin/bash
# 纳言标准部署脚本：构建 → 优雅退出 → 同步 /Applications → 清理开发副本 → 启动 → 校验
# 用法: bash deploy.sh   （在 app/ 目录下或任意位置执行）
# R9-B3：dmg 打包失败但 .app 已产出时自动做手动收尾；结束后校验二进制新鲜度与页面日志。
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/Library/Developer/CommandLineTools/usr/bin/clang
export CC=/Library/Developer/CommandLineTools/usr/bin/clang
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk
# 发布包里依赖库的报错位置写成 ~/.cargo/…，不带构建机的用户目录
export RUSTFLAGS="--remap-path-prefix=$HOME=~"

BUNDLE_APP="src-tauri/target/release/bundle/macos/NaYan.app"
LOG="$HOME/Library/Application Support/com.nayan.app/nayan.log"

echo "① 构建..."
BUILD_START=$(date +%s)
if npx tauri build > /tmp/tauri-build.log 2>&1; then
  grep -E "Finished 1 bundle" /tmp/tauri-build.log || true
else
  # dmg 打包一步（bundle_dmg.sh）失败时 .app 往往已经构建好；
  # 确认二进制是本次构建的产物，就走手动收尾，否则才算真构建失败。
  BIN="$BUNDLE_APP/Contents/MacOS/nayan"
  if [ -f "$BIN" ] && [ "$(stat -f %m "$BIN")" -gt "$BUILD_START" ]; then
    echo "⚠ dmg 打包失败，但 .app 已构建好（二进制为本次构建），自动手动收尾"
    tail -3 /tmp/tauri-build.log
    ls -d /Volumes/dmg.* 2>/dev/null | while read -r v; do
      echo "  卸载残留卷 $v"; hdiutil detach "$v" -force >/dev/null 2>&1 || true
    done
    rm -f src-tauri/target/release/bundle/macos/rw.*.dmg 2>/dev/null || true
  else
    echo "✗ 构建失败（.app 未产出或不是本次构建）"; tail -20 /tmp/tauri-build.log; exit 1
  fi
fi

echo "② 优雅退出旧实例..."
PRE_MARKS=$(grep -c "页面脚本初始化完成" "$LOG" 2>/dev/null || true); : "${PRE_MARKS:=0}"
osascript -e 'quit app "NaYan"' 2>/dev/null || true
for i in $(seq 1 10); do pgrep -f "NaYan.app/Contents/MacOS/nayan" >/dev/null || break; sleep 0.5; done
pkill -9 -f "NaYan.app/Contents/MacOS/nayan" 2>/dev/null || true
sleep 1

echo "③ 同步 /Applications..."
BUNDLED_SHA=$(shasum -a 256 "$BUNDLE_APP/Contents/MacOS/nayan" | cut -d' ' -f1)
rm -rf /Applications/NaYan.app
cp -R "$BUNDLE_APP" /Applications/
rm -rf "src-tauri/target/release/bundle/macos"          # 开发副本不进 Spotlight
touch "src-tauri/target/.metadata_never_index"          # 整个 target 树防索引（重建后仍在）

echo "④ 启动..."
open /Applications/NaYan.app
sleep 3
pgrep -f "NaYan.app/Contents/MacOS/nayan" >/dev/null && echo "✓ 部署完成，运行中" || { echo "✗ 启动失败"; exit 1; }

echo "⑤ 校验..."
INSTALLED="/Applications/NaYan.app/Contents/MacOS/nayan"
if [ "$(stat -f %m "$INSTALLED")" -lt "$BUILD_START" ]; then
  echo "✗ /Applications 里的二进制不是本次构建的（修改时间早于构建开始）"; exit 1
fi
echo "✓ 新装二进制修改时间晚于本次构建开始（$(stat -f '%Sm' "$INSTALLED")）"
if [ "$(shasum -a 256 "$INSTALLED" | cut -d' ' -f1)" = "$BUNDLED_SHA" ]; then
  echo "✓ 安装副本与构建产物 sha256 一致"
else
  echo "✗ 安装副本与构建产物 sha256 不一致"; exit 1
fi
# 框选的像素识别助手必须在包里（bundle.externalBin），不能依赖构建机上的 target/ 目录
OCR="/Applications/NaYan.app/Contents/MacOS/nayan-ocr"
if [ -x "$OCR" ] && file "$OCR" | grep -q "Mach-O"; then
  echo "✓ 像素识别助手已打进安装包"
else
  echo "✗ 安装包里缺少可执行的 nayan-ocr（框选在 Electron 类窗口会失败）"; exit 1
fi
# 等新的「页面脚本初始化完成」标记出现（最多 20 秒），再看它之后有没有 JS 报错
NEW_MARKS=""
for i in $(seq 1 20); do
  NEW_MARKS=$(grep -c "页面脚本初始化完成" "$LOG" 2>/dev/null || true); : "${NEW_MARKS:=0}"
  [ "$NEW_MARKS" -gt "$PRE_MARKS" ] && break
  sleep 1
done
if [ "${NEW_MARKS:-0}" -gt "$PRE_MARKS" ]; then
  MARK_LINE=$(grep -n "页面脚本初始化完成" "$LOG" | tail -1 | cut -d: -f1)
  ERRORS=$(tail -n +"$((MARK_LINE + 1))" "$LOG" | grep -c "JS错误" || true); : "${ERRORS:=0}"
  if [ "$ERRORS" -eq 0 ]; then
    echo "✓ 页面脚本初始化完成，其后无 JS 报错"
  else
    echo "✗ 页面脚本初始化之后有 $ERRORS 条 JS 报错（部署已生效，需人工看日志）"
    tail -n +"$((MARK_LINE + 1))" "$LOG" | grep "JS错误" | head -5
    exit 1
  fi
else
  echo "✗ 20 秒内没等到「页面脚本初始化完成」标记，需人工看日志"; exit 1
fi
tail -1 "$LOG"
