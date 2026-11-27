#!/usr/bin/env bash
# Builds, signs and uploads the Android APK of a release on this machine, so the signing key never
# leaves it. Normally run by the pre-push hook (.githooks/pre-push) when a v* tag is pushed.
#
#   scripts/android-release.sh setup <keystore.jks> <key alias> [<keyring attribute> <value> ...]
#       once per machine: remembers the keystore and alias (this repository's git config) and turns
#       the hooks on. With attribute/value pairs it uses the keystore password already in the
#       desktop keyring under them (nothing new is stored); without, secret-tool asks for the
#       password and stores it under service chainer-android, key release
#   scripts/android-release.sh build <tag>
#       builds the release APK of the checked-out tag and signs it (the hook runs this before the
#       push; a failure stops the push)
#   scripts/android-release.sh upload <tag>
#       waits for the draft release CI makes for the tag and attaches the signed APK to it (the hook
#       runs this in the background after the push)
#
# The keystore password is read from the keyring entry named by git config chainer.androidKeyring
# (default: service chainer-android key release); it is never written to a file. One key for all releases: Android refuses an update signed differently.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ANDROID_DIR="$ROOT/apps/gui/src-tauri/gen/android"
UNSIGNED="$ANDROID_DIR/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
OUT_DIR="$ANDROID_DIR/app/build/outputs/signed"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/chainer"
# How much free memory a build wants; an earlier build next to the emulator ran 14 GiB out.
MIN_FREE_MB=7000

die() { echo "android-release: $*" >&2; exit 1; }
say() { echo "android-release: $*" >&2; }

DEFAULT_KEYRING='service chainer-android key release'

keyring_attrs() { git -C "$ROOT" config chainer.androidKeyring || echo "$DEFAULT_KEYRING"; }

password() {
  local attrs
  read -ra attrs <<<"$(keyring_attrs)"
  secret-tool lookup "${attrs[@]}" 2>/dev/null \
    || die "no key password in the keyring under '${attrs[*]}'; run: scripts/android-release.sh setup <keystore.jks> <alias> [<attribute> <value> ...]"
}

apk_name() { echo "chainer_${1#v}_android.apk"; }

build_tools() {
  local sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
  [ -n "$sdk" ] || die "ANDROID_HOME is not set"
  local bt
  bt=$(ls -d "$sdk"/build-tools/* 2>/dev/null | sort -V | tail -n 1)
  [ -x "$bt/apksigner" ] || die "no apksigner under $sdk/build-tools"
  echo "$bt"
}

setup() {
  local ks=${1:-} alias=${2:-}
  [ -n "$ks" ] && [ -n "$alias" ] || die "usage: setup <keystore.jks> <key alias> [<keyring attribute> <value> ...]"
  shift 2
  [ $(($# % 2)) -eq 0 ] || die "keyring attributes come in attribute/value pairs"
  [[ "$*" != *$'\n'* ]] || die "keyring attributes cannot contain line breaks"
  [ -f "$ks" ] || die "no keystore at $ks"
  ks=$(cd "$(dirname "$ks")" && pwd)/$(basename "$ks")
  git -C "$ROOT" config chainer.androidKeystore "$ks"
  git -C "$ROOT" config chainer.androidKeyAlias "$alias"
  if [ $# -gt 0 ]; then
    git -C "$ROOT" config chainer.androidKeyring "$*"
    say "using the keystore password already in the keyring under: $*"
  else
    git -C "$ROOT" config --unset chainer.androidKeyring || true
    say "key password for $ks (stored in the keyring, not in a file):"
    # shellcheck disable=SC2086
    secret-tool store --label='chainer Android release key' $DEFAULT_KEYRING
  fi
  # Check the password and alias now rather than at the next release.
  CHAINER_KS_PASS=$(password) keytool -list -keystore "$ks" -alias "$alias" -storepass:env CHAINER_KS_PASS >/dev/null 2>&1 \
    || die "the keystore did not open with that password and alias '$alias'"
  git -C "$ROOT" config core.hooksPath .githooks
  say "set up: pushing a v* tag now builds, signs and attaches the APK"
}

build() {
  local tag=${1:-}
  [ -n "$tag" ] || die "usage: build <tag>"
  local ks alias version
  ks=$(git -C "$ROOT" config chainer.androidKeystore) || die "not set up; run: scripts/android-release.sh setup <keystore.jks> <alias>"
  alias=$(git -C "$ROOT" config chainer.androidKeyAlias) || die "no key alias; run setup again"
  [ -f "$ks" ] || die "the keystore $ks is gone"

  # The APK must come from exactly the tagged code.
  [ "$(git -C "$ROOT" rev-parse HEAD)" = "$(git -C "$ROOT" rev-parse "$tag^{commit}")" ] \
    || die "check out $tag before pushing it (the APK is built from the working tree)"
  [ -z "$(git -C "$ROOT" status --porcelain)" ] || die "the working tree has changes; the APK would not match $tag"
  version=$(node -p "require('$ROOT/package.json').version")
  [ "$tag" = "v$version" ] || die "the tag $tag does not match the app version $version"
  (cd "$ROOT" && node scripts/version.ts check)

  pgrep -f qemu-system >/dev/null && die "an emulator is running; shut it down first (the build and the emulator do not fit in memory together)"
  local free_mb
  free_mb=$(awk '/MemAvailable/ {print int($2 / 1024)}' /proc/meminfo)
  [ "$free_mb" -ge "$MIN_FREE_MB" ] || die "only $free_mb MB of memory free; the build wants $MIN_FREE_MB MB"

  local pass bt
  pass=$(password)
  bt=$(build_tools)
  export NDK_HOME=${NDK_HOME:-$(ls -d "${ANDROID_HOME:-$ANDROID_SDK_ROOT}"/ndk/* 2>/dev/null | sort -V | tail -n 1)}
  [ -d "$NDK_HOME" ] || die "no Android NDK found; set NDK_HOME"

  say "building the release APK for $tag (a few minutes)"
  rm -f "$UNSIGNED"
  (cd "$ROOT" && CARGO_BUILD_JOBS=6 npm run tauri -w @chainer/gui -- android build --apk) >&2
  (cd "$ANDROID_DIR" && ./gradlew --stop -q) || true
  [ -f "$UNSIGNED" ] || die "the build left no APK at $UNSIGNED"

  mkdir -p "$OUT_DIR"
  local aligned="$OUT_DIR/aligned.apk" signed
  signed="$OUT_DIR/$(apk_name "$tag")"
  "$bt/zipalign" -f -p 4 "$UNSIGNED" "$aligned"
  CHAINER_KS_PASS=$pass "$bt/apksigner" sign --ks "$ks" --ks-key-alias "$alias" \
    --ks-pass env:CHAINER_KS_PASS --out "$signed" "$aligned"
  rm -f "$aligned" "$signed.idsig"
  "$bt/apksigner" verify "$signed" || die "the signed APK did not verify"
  say "signed: $signed"
}

upload() {
  local tag=${1:-}
  [ -n "$tag" ] || die "usage: upload <tag>"
  local file
  file="$OUT_DIR/$(apk_name "$tag")"
  [ -f "$file" ] || die "no signed APK at $file; run build first"
  local repo id=''
  repo=$(cd "$ROOT" && gh repo view --json nameWithOwner --jq .nameWithOwner)
  # CI's release job makes the draft a moment after the tag arrives.
  for _ in $(seq 1 60); do
    id=$(gh api "repos/$repo/releases" --paginate --jq ".[] | select(.tag_name == \"$tag\") | .id" | head -n 1)
    [ -n "$id" ] && break
    sleep 20
  done
  [ -n "$id" ] || die "no release for $tag after 20 minutes; did the release workflow run?"
  # A re-run replaces an APK attached earlier.
  local old
  old=$(gh api "repos/$repo/releases/$id/assets" --jq ".[] | select(.name == \"$(basename "$file")\") | .id")
  [ -n "$old" ] && gh api --method DELETE "repos/$repo/releases/assets/$old"
  gh api --method POST -H "Content-Type: application/vnd.android.package-archive" \
    "https://uploads.github.com/repos/$repo/releases/$id/assets?name=$(basename "$file")" \
    --input "$file" --jq .browser_download_url
}

notify() { command -v notify-send >/dev/null && notify-send "chainer $1" "$2" || true; }

case ${1:-} in
  setup) shift; setup "$@" ;;
  build) shift; build "$@" ;;
  upload) shift; upload "$@" ;;
  upload-notify)
    # The hook's background form: log to a file, tell the desktop how it went.
    shift
    mkdir -p "$LOG_DIR"
    log="$LOG_DIR/android-release-$1.log"
    if "$0" upload "$1" >"$log" 2>&1; then notify "$1" "Android APK attached to the draft release"
    else notify "$1" "Android APK upload failed, see $log"; fi ;;
  *) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
