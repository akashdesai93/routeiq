#!/usr/bin/env bash
# RouteIQ: prepare a Claude Code cloud session (Linux, Ubuntu 24.04). See docs/cloud-sessions.md.
#
# Two ways in, following https://code.claude.com/docs/en/cloud-environments:
#
#   1. Environment setup script (paste this whole file into the environment's "Setup script"
#      field). It runs as root before Claude Code launches, and its result is cached for about
#      7 days. It installs the toolchains: Node 24, Chromium's system libraries and, when
#      INSTALL_SWIFT=1 below, Swift. If the repo is already checked out it also runs `deps`.
#   2. SessionStart hook (.claude/settings.json runs `cloud-setup.sh session`). It runs at every
#      cloud session start, does nothing outside the cloud (CLAUDE_CODE_REMOTE != true), puts
#      Node 24 and Swift on PATH through CLAUDE_ENV_FILE, and runs `deps`, which is a no-op
#      when node_modules and the browser are already current.
#
# Subcommands: (none) or env | session | deps | swift
# Every step is idempotent and the script always exits 0, because a failing setup script
# stops the cloud session from starting. Failures are printed as "cloud-setup: WARN ...".

set -u

# Environment setup scripts can't read the environment's variables (they run before those
# are set), so the Swift switch is a line to edit: 1 in the native environment, 0 elsewhere.
INSTALL_SWIFT="${INSTALL_SWIFT:-0}"

NODE_MAJOR=24                 # matches .github/workflows/ci.yml and e2e.yml
SWIFT_VERSION=6.4.2           # matches the toolchain on ubuntu-24.04 used by native-core.yml
NODE_DIR=/opt/node24
SWIFT_DIR=/opt/swift

log()  { echo "cloud-setup: $*"; }
warn() { echo "cloud-setup: WARN $*" >&2; }

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else return 1
  fi
}

arch_suffix() {
  case "$(uname -m)" in
    x86_64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) echo unknown ;;
  esac
}

# Find the repo: the current git checkout, CLAUDE_PROJECT_DIR, or a routeiq checkout under /home.
repo_dir() {
  local d
  d="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$d" ] && [ -f "$d/package.json" ] && grep -q '"name": "routeiq"' "$d/package.json"; then
    echo "$d"; return 0
  fi
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$CLAUDE_PROJECT_DIR/package.json" ]; then
    echo "$CLAUDE_PROJECT_DIR"; return 0
  fi
  for d in /home/*/routeiq /home/*/*/routeiq /workspace/routeiq; do
    if [ -f "$d/package.json" ]; then echo "$d"; return 0; fi
  done
  return 1
}

node_bin() {
  if [ -x "$NODE_DIR/bin/node" ]; then echo "$NODE_DIR/bin"; else dirname "$(command -v node)"; fi
}

install_node() {
  if [ -x "$NODE_DIR/bin/node" ]; then
    log "Node $("$NODE_DIR/bin/node" --version) already in $NODE_DIR"; return 0
  fi
  local arch file base=https://nodejs.org/dist/latest-v${NODE_MAJOR}.x
  arch="$(arch_suffix)"
  file="$(curl -fsSL "$base/SHASUMS256.txt" | awk '{print $2}' | grep -E "^node-v${NODE_MAJOR}\.[0-9.]+-linux-${arch}\.tar\.xz$" | head -n1)"
  if [ -z "$file" ]; then
    warn "could not list Node $NODE_MAJOR from nodejs.org (allowlist nodejs.org); using $(node --version 2>/dev/null || echo 'no node')"
    return 1
  fi
  log "installing $file into $NODE_DIR"
  local tmp; tmp="$(mktemp -d)"
  if curl -fsSL "$base/$file" -o "$tmp/node.tar.xz" \
     && as_root mkdir -p "$NODE_DIR" \
     && as_root tar -xJf "$tmp/node.tar.xz" -C "$NODE_DIR" --strip-components=1; then
    log "Node $("$NODE_DIR/bin/node" --version) installed"
  else
    warn "Node $NODE_MAJOR install failed"
  fi
  rm -rf "$tmp"
}

# Chromium's system libraries. Needs root; the Playwright package itself comes from npm ci.
install_chromium_deps() {
  local repo="$1" bin; bin="$(node_bin)"
  [ -d "$repo/node_modules/@playwright/test" ] || { warn "no node_modules yet; skipping Playwright"; return 1; }
  if ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-* >/dev/null 2>&1; then
    log "Playwright headless Chromium already installed"; return 0
  fi
  # Same command as .github/workflows/e2e.yml.
  if [ "$(id -u)" = 0 ]; then
    (cd "$repo" && PATH="$bin:$PATH" npx playwright install --with-deps --only-shell chromium) \
      || warn "playwright install failed (allowlist cdn.playwright.dev and playwright.download.prss.microsoft.com)"
  else
    (cd "$repo" && PATH="$bin:$PATH" npx playwright install --only-shell chromium) \
      || warn "playwright install failed (allowlist cdn.playwright.dev and playwright.download.prss.microsoft.com)"
  fi
}

# npm ci only when package-lock.json changed since the last run.
deps() {
  local repo bin stamp want
  repo="$(repo_dir)" || { log "repo not checked out yet; skipping npm ci"; return 0; }
  bin="$(node_bin)"
  stamp="$repo/node_modules/.cloud-setup-lock"
  want="$(sha256sum "$repo/package-lock.json" | cut -d' ' -f1) node-$("$bin/node" --version)"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
    log "node_modules current"
  else
    log "npm ci in $repo"
    if (cd "$repo" && PATH="$bin:$PATH" npm ci --no-audit --no-fund); then
      echo "$want" > "$stamp"
    else
      warn "npm ci failed"; return 0
    fi
  fi
  install_chromium_deps "$repo"
  return 0
}

# Swift for Linux for native/RouteIQCore. Only the native session needs it:
# `bash scripts/cloud-setup.sh swift` (or INSTALL_SWIFT=1 in the environment's setup script).
install_swift() {
  if [ -x "$SWIFT_DIR/usr/bin/swift" ]; then
    log "Swift already in $SWIFT_DIR ($("$SWIFT_DIR/usr/bin/swift" --version 2>/dev/null | head -n1))"; return 0
  fi
  local plat="ubuntu2404" name="ubuntu24.04"
  if [ "$(arch_suffix)" = arm64 ]; then plat="ubuntu2404-aarch64"; name="ubuntu24.04-aarch64"; fi
  local url="https://download.swift.org/swift-${SWIFT_VERSION}-release/${plat}/swift-${SWIFT_VERSION}-RELEASE/swift-${SWIFT_VERSION}-RELEASE-${name}.tar.gz"
  log "installing Swift $SWIFT_VERSION from $url"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq \
    && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
         binutils git gnupg2 libc6-dev libcurl4-openssl-dev libedit2 libgcc-13-dev libncurses-dev \
         libpython3-dev libsqlite3-0 libstdc++-13-dev libxml2-dev libz3-dev pkg-config tzdata unzip zlib1g-dev \
    || warn "Swift system packages failed"
  local tmp; tmp="$(mktemp -d)"
  if curl -fsSL "$url" -o "$tmp/swift.tar.gz" \
     && as_root mkdir -p "$SWIFT_DIR" \
     && as_root tar -xzf "$tmp/swift.tar.gz" -C "$SWIFT_DIR" --strip-components=1; then
    log "$("$SWIFT_DIR/usr/bin/swift" --version 2>/dev/null | head -n1)"
  else
    warn "Swift install failed (allowlist download.swift.org)"
  fi
  rm -rf "$tmp"
}

# Make Node 24 (and Swift, when present) the default for the session's Bash commands.
export_path() {
  local p="$NODE_DIR/bin"
  [ -x "$SWIFT_DIR/usr/bin/swift" ] && p="$p:$SWIFT_DIR/usr/bin"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$p:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
}

cmd="${1:-env}"
case "$cmd" in
  env)
    install_node
    [ "$INSTALL_SWIFT" = 1 ] && install_swift
    deps
    ;;
  session)
    # Only in the cloud. Locally this hook is a no-op.
    [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
    [ -x "$NODE_DIR/bin/node" ] || install_node
    deps
    export_path
    ;;
  deps)  deps ;;
  swift) install_swift; export_path ;;
  *) warn "unknown subcommand '$cmd' (use env, session, deps or swift)" ;;
esac
exit 0
