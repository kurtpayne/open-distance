# Source this (don't execute) to put cargo + rustc on PATH.
# Usage:  . scripts/rust_env.sh
#
# Homebrew's rustup is keg-only and doesn't symlink cargo/rustc into
# /opt/homebrew/bin. The toolchain itself lives under ~/.rustup. We just
# prepend the active stable toolchain's bin dir so cargo build / cargo
# test / cargo run all work.
RUST_BIN="${HOME}/.rustup/toolchains/stable-aarch64-apple-darwin/bin"
if [[ -d "$RUST_BIN" && ":$PATH:" != *":$RUST_BIN:"* ]]; then
  export PATH="$RUST_BIN:$PATH"
fi
# Make rustup itself reachable for target / toolchain updates.
RUSTUP_BIN="/opt/homebrew/opt/rustup/bin"
if [[ -d "$RUSTUP_BIN" && ":$PATH:" != *":$RUSTUP_BIN:"* ]]; then
  export PATH="$RUSTUP_BIN:$PATH"
fi
