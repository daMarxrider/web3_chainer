#!/usr/bin/env bash
# Installs everything chainer needs on Linux and checks that it works.
# Supports pacman (Arch), apt (Debian, Ubuntu) and dnf (Fedora). Safe to run again.
#
#   ./scripts/install-linux.sh
set -euo pipefail

NODE_MAJOR=24
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n==> %s\n' "$*"; }
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' || echo 0; }
# Major version of the nodejs package the distribution offers; 0 if unknown.
major_of() { local v="${1#*:}"; v="${v%%.*}"; [[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo 0; }

# ---- system packages ------------------------------------------------------

if command -v pacman >/dev/null 2>&1; then
  say "Installing packages with pacman"
  packages=(git curl tar xz nodejs npm)
  if compgen -G '/var/lib/pacman/sync/*.db' >/dev/null; then
    # An existing system is not upgraded behind the user's back: Arch does not support
    # installing new packages on top of outdated ones, so that decision stays with them.
    as_root pacman -S --needed --noconfirm "${packages[@]}" || {
      echo "pacman could not install the packages. The system is probably out of date:" >&2
      echo "run 'sudo pacman -Syu', then run this script again." >&2
      exit 1
    }
  else
    # No package lists at all (a fresh install or container): a full sync is the only safe way.
    as_root pacman -Syu --needed --noconfirm "${packages[@]}"
  fi
elif command -v apt-get >/dev/null 2>&1; then
  say "Installing packages with apt"
  export DEBIAN_FRONTEND=noninteractive
  as_root apt-get update
  as_root apt-get install -y git curl ca-certificates tar xz-utils
  if [ "$(node_major)" -lt "$NODE_MAJOR" ] && [ "$(major_of "$(apt-cache policy nodejs | awk '/Candidate:/ {print $2}')")" -ge "$NODE_MAJOR" ]; then
    as_root apt-get install -y nodejs npm
  fi
elif command -v dnf >/dev/null 2>&1; then
  say "Installing packages with dnf"
  as_root dnf install -y git curl tar xz
  if [ "$(node_major)" -lt "$NODE_MAJOR" ] && [ "$(major_of "$(dnf -q repoquery --latest-limit=1 --qf '%{version}' nodejs 2>/dev/null | tail -n 1)")" -ge "$NODE_MAJOR" ]; then
    as_root dnf install -y nodejs npm
  fi
else
  echo "No supported package manager found (pacman, apt or dnf)." >&2
  echo "Install git, curl and Node.js $NODE_MAJOR or newer by hand, then run this script again." >&2
  exit 1
fi

# ---- Node.js --------------------------------------------------------------

# Distributions that ship an older Node.js get the official build from nodejs.org,
# checked against its published SHA-256 sum, under /usr/local.
if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "No official Node.js build for $(uname -m); install Node.js $NODE_MAJOR or newer by hand." >&2; exit 1 ;;
  esac
  say "Installing Node.js $NODE_MAJOR from nodejs.org"
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  line="$(curl -fsSL "$base/SHASUMS256.txt" | grep "linux-$arch.tar.xz\$")"
  file="${line##* }"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/$file" "$base/$file"
  echo "${line%% *}  $tmp/$file" | sha256sum -c -
  as_root mkdir -p /usr/local/lib/nodejs /usr/local/bin
  as_root tar -xJf "$tmp/$file" -C /usr/local/lib/nodejs
  for tool in node npm npx; do
    as_root ln -sf "/usr/local/lib/nodejs/${file%.tar.xz}/bin/$tool" "/usr/local/bin/$tool"
  done
  export PATH="/usr/local/bin:$PATH"
  hash -r
fi
if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  echo "Node.js $NODE_MAJOR or newer is still not first on the PATH (found: $(node --version 2>/dev/null || echo none))." >&2
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
mkdir -p "$HOME/.local/bin"
ln -sf "$repo/apps/cli/bin/chainer.js" "$HOME/.local/bin/chainer"
"$HOME/.local/bin/chainer" --help >/dev/null

say "Done. chainer is installed."
case ":$PATH:" in
  *":$HOME/.local/bin:"*) echo "Try it: chainer --help" ;;
  *) echo "$HOME/.local/bin is not on your PATH. Add it, or run: $HOME/.local/bin/chainer --help" ;;
esac
