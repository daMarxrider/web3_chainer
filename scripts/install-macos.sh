#!/usr/bin/env bash
# Installs everything chainer needs on macOS and checks that it works.
# Uses Homebrew, installing it first if it is missing. Safe to run again.
#
#   ./scripts/install-macos.sh
set -euo pipefail

NODE_MAJOR=24
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n==> %s\n' "$*"; }
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' || echo 0; }

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS. On Linux use scripts/install-linux.sh." >&2
  exit 1
fi

# ---- Homebrew -------------------------------------------------------------

if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
# Homebrew lives in /opt/homebrew on Apple silicon and /usr/local on Intel.
for prefix in /opt/homebrew /usr/local; do
  if [ -x "$prefix/bin/brew" ]; then eval "$("$prefix/bin/brew" shellenv)"; fi
done

# ---- packages -------------------------------------------------------------

say "Installing packages with Homebrew"
brew install git tor
if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  brew install node
  hash -r
fi
if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  echo "Node.js $NODE_MAJOR or newer is still not first on the PATH (found: $(node --version 2>/dev/null || echo none))." >&2
  echo "An older Node.js earlier on the PATH is probably shadowing Homebrew's." >&2
  exit 1
fi
echo "Node.js $(node --version), npm $(npm --version)"

# ---- project --------------------------------------------------------------

say "Installing the project's packages"
cd "$repo"
npm ci

say "Running the tests"
npm test

say "Adding the chainer command"
bin="$(brew --prefix)/bin"
ln -sf "$repo/apps/cli/bin/chainer.js" "$bin/chainer"
"$bin/chainer" --help >/dev/null

say "Done. chainer is installed. Try it: chainer --help"
echo "Tor is installed but not started. To route chainer through it, run:"
echo "  brew services start tor"
echo "  chainer config set proxy socks5://127.0.0.1:9050"
