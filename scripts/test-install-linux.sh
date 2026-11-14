#!/usr/bin/env bash
# Tests scripts/install-linux.sh on clean Arch, Debian, Ubuntu and Fedora systems.
#
# Needs no Docker, Podman or root: each system is an official base image unpacked into a
# folder and entered through a user namespace with `unshare` (part of util-linux, which every
# distribution ships). Images are fetched from Docker Hub with curl and cached.
#
#   ./scripts/test-install-linux.sh                 # all four
#   ./scripts/test-install-linux.sh debian fedora   # only these
#
# Requirements on the host: unshare, newuidmap (and an /etc/subuid entry), curl, python3, tar.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cache="${CHAINER_TEST_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/chainer-install-test}"
work="$(mktemp -d "${TMPDIR:-/tmp}/chainer-install-test.XXXXXX")"
declare -A IMAGES=([arch]=archlinux:latest [debian]=debian:stable [ubuntu]=ubuntu:latest [fedora]=fedora:latest)
[ "$#" -gt 0 ] || set -- arch debian ubuntu fedora

in_userns() { unshare --map-auto --map-root-user --mount --pid --fork "$@"; }
# Files inside a root folder belong to mapped IDs, so removing them also needs the namespace.
trap 'in_userns rm -rf "$work"' EXIT

# Downloads the layers of an official image for this machine's architecture; prints their paths.
fetch_image() {
  local name="${1%%:*}" tag="${1##*:}" dir="$cache/$1"
  mkdir -p "$dir"
  python3 - "$name" "$tag" "$dir" <<'PY'
import json, os, platform, sys, urllib.request

name, tag, out = sys.argv[1:]
arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}[platform.machine()]
registry = f'https://registry-1.docker.io/v2/library/{name}'
kinds = ', '.join(f'application/vnd.{k}+json' for k in (
    'oci.image.index.v1', 'oci.image.manifest.v1',
    'docker.distribution.manifest.list.v2', 'docker.distribution.manifest.v2'))

def get(url, headers):
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers))

token = json.load(get(f'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/{name}:pull', {}))['token']
auth = {'Authorization': f'Bearer {token}', 'Accept': kinds}
manifest = json.load(get(f'{registry}/manifests/{tag}', auth))
if 'manifests' in manifest:  # one entry per architecture
    digest = next(m['digest'] for m in manifest['manifests']
                  if m['platform']['architecture'] == arch and m['platform']['os'] == 'linux')
    manifest = json.load(get(f'{registry}/manifests/{digest}', auth))
for layer in manifest['layers']:
    path = os.path.join(out, layer['digest'].replace(':', '-'))
    if not os.path.exists(path):
        with get(f'{registry}/blobs/{layer["digest"]}', auth) as src, open(path + '.part', 'wb') as dst:
            while chunk := src.read(1 << 20):
                dst.write(chunk)
        os.rename(path + '.part', path)
    print(path)
PY
}

run_distro() {
  local distro="$1" root="$work/$1"
  mapfile -t layers < <(fetch_image "${IMAGES[$distro]}")
  # shellcheck disable=SC2016  # expanded inside the namespace
  in_userns bash -euo pipefail -c '
    root="$1"; repo="$2"; shift 2
    mkdir -p "$root"
    for layer in "$@"; do tar -xf "$layer" -C "$root"; done
    mount --bind "$root" "$root"   # package managers want the root to be a mount point
    mount --rbind /dev "$root/dev"
    mount --rbind /sys "$root/sys"
    mount -t proc proc "$root/proc"
    cp --remove-destination /etc/resolv.conf "$root/etc/resolv.conf"
    # A clean copy of the working tree: no node_modules, nothing from the host.
    mkdir -p "$root/chainer"
    tar -C "$repo" --exclude=./node_modules --exclude=./.git -cf - . | tar -C "$root/chainer" -xf -
    chroot "$root" /usr/bin/env -i HOME=/root TERM=dumb \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      bash -c "/chainer/scripts/install-linux.sh && /root/.local/bin/chainer --help | head -n 1 && /chainer/scripts/install-linux.sh >/dev/null && echo SECOND-RUN-OK"
  ' _ "$root" "$repo" "${layers[@]}"
}

failed=()
for distro in "$@"; do
  [ -n "${IMAGES[$distro]:-}" ] || { echo "Unknown system \"$distro\" (choose from: ${!IMAGES[*]})" >&2; exit 2; }
  printf '\n######## %s (%s) ########\n' "$distro" "${IMAGES[$distro]}"
  if run_distro "$distro" 2>&1 | tee "$work/$distro.log" | tail -n "${CHAINER_TEST_LINES:-25}" && grep -q SECOND-RUN-OK "$work/$distro.log"; then
    echo "PASS: $distro"
  else
    echo "FAIL: $distro"
    failed+=("$distro")
  fi
done

echo
[ "${#failed[@]}" -eq 0 ] && echo "All systems passed: $*" || { echo "Failed: ${failed[*]}"; exit 1; }
