#!/bin/bash
# P1-R1-F01 外部 API 探针：在隔离临时 Cargo crate 中编译/运行负例与正例。
# 负例要求：编译失败 且 诊断含 "is private"（E0616 类）；否则 FAIL。
# 正例要求：编译并运行成功（断言全过）。全程只读真实 content.rs，不改源码、无生产数据。
set -u
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PROBE_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d /tmp/nayan-content-probe-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src/bin"
cat > "$WORK/Cargo.toml" <<TOML
[package]
name = "content-probe"
version = "0.0.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
TOML
cp "$PROBE_DIR/negative.rs" "$WORK/src/bin/negative.rs"
cp "$PROBE_DIR/positive.rs" "$WORK/src/bin/positive.rs"
# 真实 content.rs 只读引用（#[path] 相对 bin 文件解析 → 需复制一份到工作 crate 保持路径可用）
cp "$REPO_ROOT/app/src-tauri/src/content.rs" "$WORK/content_copy_for_path.rs"
sed -i '' 's|#\[path = "../../../../app/src-tauri/src/content.rs"\]|#[path = "../../content_copy_for_path.rs"]|' "$WORK/src/bin/negative.rs" "$WORK/src/bin/positive.rs"

overall=0
# ---- 负例：期望编译失败 + 私有字段诊断 ----
if cargo build --manifest-path "$WORK/Cargo.toml" --bin negative --offline -q >"$WORK/neg.log" 2>&1; then
  echo "FAIL negative: 对私有字段赋值竟然编译通过——不变量仍可被外部改坏"
  overall=1
else
  if grep -q "is private" "$WORK/neg.log"; then
    echo "PASS negative: 编译失败且诊断为私有字段（节选）："
    grep -m2 "is private" "$WORK/neg.log" | sed 's/^/    /'
  else
    echo "FAIL negative: 编译失败但诊断不是预期的私有字段错误："
    head -5 "$WORK/neg.log" | sed 's/^/    /'
    overall=1
  fi
fi
# ---- 正例：期望编译并运行成功 ----
if cargo run --manifest-path "$WORK/Cargo.toml" --bin positive --offline -q >"$WORK/pos.log" 2>&1; then
  echo "PASS positive: $(tail -1 "$WORK/pos.log")"
else
  echo "FAIL positive:"
  head -8 "$WORK/pos.log" | sed 's/^/    /'
  overall=1
fi
exit $overall
