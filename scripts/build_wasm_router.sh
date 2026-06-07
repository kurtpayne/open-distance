#!/usr/bin/env bash
# Build rust-router/ to a WASM module and copy it into the path wrangler
# expects. Run this whenever you change anything under rust-router/src/.
#
# The compiled .wasm is committed to the repo (it's only ~30 KB) so CI doesn't
# need a Rust toolchain. If the binary doesn't match the source on a PR,
# reviewers will see the .wasm diff.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v cargo >/dev/null 2>&1; then
  if [[ -d "$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin" ]]; then
    # shellcheck disable=SC1091
    . "$ROOT/scripts/rust_env.sh"
  else
    echo "ERROR: cargo not on PATH. Install rustup: brew install rustup && rustup default stable && rustup target add wasm32-unknown-unknown" >&2
    exit 1
  fi
fi

cd "$ROOT/rust-router"
cargo build --release --target wasm32-unknown-unknown
SRC="target/wasm32-unknown-unknown/release/od_router.wasm"
[[ -f "$SRC" ]] || { echo "ERROR: $SRC missing after build" >&2; exit 1; }
size=$(wc -c < "$SRC" | tr -d ' ')
echo "[build_wasm_router] built $SRC ($size bytes)"
