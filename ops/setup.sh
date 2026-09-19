#!/usr/bin/env bash
# ops/setup.sh — Level 0 developer environment
# Target: Ubuntu 24.04 inside WSL2 (also works on any Debian/Ubuntu box, e.g. the free cloud VM later).
# Installs: build tools, Rust, Solana CLI (Agave), Node LTS via nvm, Yarn, Anchor via AVM.
# Safe to re-run: every step checks whether it is already done.
# Downloads force IPv4, time out after 30 s, and retry 5 times (flaky CDN routes on some ISPs).
# Sources: the official Solana docs page "Install Dependencies" (solana.com/docs/intro/installation/dependencies).
set -eo pipefail

log() { printf '\n== %s ==\n' "$*"; }
CURL="curl -4 -sS --connect-timeout 30 --retry 5 --retry-delay 5 --retry-all-errors"

log "1/6 System packages"
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libudev-dev llvm libclang-dev \
  protobuf-compiler libssl-dev curl git

log "2/6 Rust (rustup, stable toolchain)"
if [ ! -x "$HOME/.cargo/bin/rustc" ]; then
  $CURL -fL https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init -o /tmp/rustup-init
  chmod +x /tmp/rustup-init
  /tmp/rustup-init -y --no-modify-path
  rm -f /tmp/rustup-init
fi
if ! grep -q '/.cargo/env' "$HOME/.bashrc"; then
  echo '. "$HOME/.cargo/env"' >> "$HOME/.bashrc"
fi
# shellcheck disable=SC1090
. "$HOME/.cargo/env"
rustc --version
cargo --version

log "3/6 Solana CLI (Agave, stable channel)"
SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"
if [ ! -x "$SOLANA_BIN/solana" ]; then
  sh -c "$($CURL -fL https://release.anza.xyz/stable/install)"
fi
if ! grep -q 'solana/install/active_release/bin' "$HOME/.bashrc"; then
  echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> "$HOME/.bashrc"
fi
export PATH="$SOLANA_BIN:$PATH"
solana --version

log "4/6 Node LTS via nvm, plus Yarn"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  $CURL -fL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install --lts
nvm use --lts
nvm alias default 'lts/*'
npm install --global yarn
node -v
npm -v
yarn -v

log "5/6 Anchor via AVM (Anchor Version Manager)"
export PATH="$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
if ! command -v avm >/dev/null 2>&1; then
  $CURL -fL https://raw.githubusercontent.com/otter-sec/anchor/master/avm/install | sh
fi
avm --version
avm install latest
avm use latest
if ! grep -q '/.avm/bin' "$HOME/.bashrc"; then
  echo 'export PATH="$HOME/.avm/bin:$PATH"' >> "$HOME/.bashrc"
fi
anchor --version || echo "anchor not on PATH yet: open a NEW terminal and run: anchor --version"

log "6/6 Git defaults for WSL"
git config --global core.autocrlf input
git config --global init.defaultBranch main

log "Done"
echo "Open a NEW terminal so PATH changes apply, then run:"
echo "  rustc --version && solana --version && node -v && anchor --version"