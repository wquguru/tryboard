# TryBoard Justfile — thin wrappers over tools/*; the scripts stay the source of truth (AGENTS.md §5).
# Hosting: static site on Cloudflare Pages, built locally and uploaded (DECISIONS 2026-10-22 "托管与运维入口").


# Cloudflare Pages project and production URL (TRYBOARD_SITE_URL overrides canonical / sitemap / Atom per build).
PAGES_PROJECT := env("TRYBOARD_PAGES_PROJECT", "tryboard")
SITE_URL := "https://tryboard.indaloop.app"
PREVIEW_URL := "https://preview." + PAGES_PROJECT + ".pages.dev"

# M1 budget: wasm first load ≤ 2 MB (raw, uncompressed).
WASM_BUDGET := "2000000"

# List recipes.
default:
    @just --list

# ==== Dev ====

# Core unit tests.
test:
    . ~/.cargo/env && cd core && cargo test

# cargo fmt (core).
fmt:
    . ~/.cargo/env && cd core && cargo fmt

# clippy + comment lint (files changed vs HEAD; `just lint all` = whole tree) + i18n + config cross-check + guardrails.
lint scope='changed':
    #!/usr/bin/env bash
    set -euo pipefail
    (. ~/.cargo/env && cd core && cargo clippy --all-targets -q -- -D warnings)
    # The whole tree still has legacy findings (accept.sh doesn't gate on it), so default to what you touched.
    if [ "{{scope}}" = all ]; then python3 tools/lint_comments.py
    else
        files=$( { git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u | while read -r f; do [ -f "$f" ] && echo "$f" || true; done)
        [ -z "$files" ] || python3 tools/lint_comments.py $files
    fi
    (cd web && node --test test/i18n.test.ts >/dev/null)
    python3 tools/check_config.py
    python3 tools/lint_size.py

# Build acceptance firmware (all, or one name).
fw name='':
    tools/build_fw.sh {{name}}

# Build wasm + web into web/dist (TRYBOARD_SITE_URL sets canonical / sitemap / Atom).
web:
    tools/build_web.sh

# Prepare web/public only, then start the Vite dev server on :5180.
dev:
    tools/build_web.sh --no-vite
    cd web && npm run dev

# Serve the built web/dist on :5180.
preview:
    cd web && npm run preview

# Run firmware natively, e.g. `just run firmware/build/blink/flash.bin --oled`.
run flash *args:
    . ~/.cargo/env && cd core && cargo run -q -p tryboard-cli --release -- run ../{{flash}} {{args}}

# ==== Acceptance ====

# Full acceptance (Reviews/accept.md); pass --no-web / --no-qemu through.
accept *args:
    tools/accept.sh {{args}}

# Golden CLI snapshots: `just golden save` before a refactor, `just golden check [ids]` after.
golden action='check' *ids:
    tools/golden.py {{action}} {{ids}}

# One web regression, e.g. `just webtest mobile` or `just webtest webtest blink 'LED'`.
webtest name *args:
    node tools/webtest/{{name}}.mjs {{args}}

# Fail when the built wasm exceeds the first-load budget.
size-check:
    #!/usr/bin/env bash
    set -euo pipefail
    f=web/dist/wasm/tryboard.wasm
    [ -f "$f" ] || { echo "✗ $f missing — run: just web"; exit 1; }
    n=$(wc -c < "$f" | tr -d ' ')
    gz=$(wc -c < "$f.gz" 2>/dev/null | tr -d ' ' || echo '?')
    echo "wasm: $n bytes (gzip $gz), budget {{WASM_BUDGET}}"
    [ "$n" -le {{WASM_BUDGET}} ] || { echo "✗ wasm over budget"; exit 1; }

# ==== Ops ====

# Toolchain presence only (no secrets involved): rust + wasm target, IDF, node, wrangler, agent-browser, disk.
doctor:
    #!/usr/bin/env bash
    ok() { echo "  ✓ $1"; }; bad() { echo "  ✗ $1"; fail=1; }
    fail=0
    . ~/.cargo/env 2>/dev/null
    command -v cargo >/dev/null && ok "cargo $(cargo --version | cut -d' ' -f2)" || bad "cargo (rustup)"
    rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown && ok "wasm32-unknown-unknown" || bad "rustup target add wasm32-unknown-unknown"
    [ -d ~/esp/esp-idf-v5.5 ] && ok "ESP-IDF ~/esp/esp-idf-v5.5" || bad "ESP-IDF v5.5.1 (~/esp/esp-idf-v5.5)"
    [ -d third_party/esp-rom-elfs ] && ok "third_party (ROM)" || bad "third_party missing — tools/fetch_third_party.sh"
    v=$(node -v 2>/dev/null); [ "${v%%.*}" = v24 ] && ok "node $v" || bad "node 24 (nvm), got ${v:-none}"
    [ -d web/node_modules ] && ok "web/node_modules" || bad "cd web && npm ci"
    command -v wrangler >/dev/null && ok "wrangler $(wrangler --version 2>/dev/null | tail -1)" || bad "wrangler (only needed for deploy)"
    command -v agent-browser >/dev/null && ok "agent-browser" || bad "agent-browser (browser acceptance)"
    free=$(df -g . | awk 'NR==2{print $4}'); [ "$free" -ge 20 ] && ok "disk ${free} GB free" || echo "  ! disk ${free} GB free (< 20): skip large toolchains, clean core/target or Reviews/"
    exit $fail

# Refuses a dirty tree (the recorded commit would lie); `just deploy prod force` overrides. Production needs a human OK (AGENTS §10).
# Build and upload to Cloudflare Pages: `just deploy` (production) or `just deploy preview`.
deploy target='prod' force='':
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{target}}" in prod) branch=main; url="{{SITE_URL}}" ;; preview) branch=preview; url="{{PREVIEW_URL}}" ;;
      *) echo "✗ target must be prod or preview"; exit 1 ;; esac
    if [ -n "$(git status --porcelain)" ] && [ "{{force}}" != force ]; then
        echo "✗ uncommitted changes — commit them, or: just deploy {{target}} force"; exit 1
    fi
    TRYBOARD_SITE_URL="$url" tools/build_web.sh
    just size-check
    dirty=false; [ -n "$(git status --porcelain)" ] && dirty=true
    wrangler pages deploy web/dist --project-name {{PAGES_PROJECT}} --branch "$branch" \
        --commit-hash "$(git rev-parse HEAD)" --commit-message "$(git log -1 --format=%s)" --commit-dirty=$dirty
    echo "deployed $(git describe --always --dirty) → $url — check with: just smoke $url"

# Serve web/dist under local Pages emulation (applies _headers / clean URLs) on :8799; then `just smoke http://localhost:8799`.
# The pinned compatibility date stays within what the bundled workerd supports.
pages-local:
    wrangler pages dev web/dist --port 8799 --compatibility-date 2026-08-01

# List recent Pages deployments (rollback: Cloudflare dashboard → Deployments → Rollback).
deployments:
    wrangler pages deployment list --project-name {{PAGES_PROJECT}}

# Post-deploy smoke: pages answer 200 with no-cache; wasm is immutable; previews carry noindex.
smoke base=SITE_URL:
    #!/usr/bin/env bash
    set -uo pipefail
    base="{{base}}"; base="${base%/}"; fail=0
    hdr() { curl -sSI --max-time 20 "$1" | tr -d '\r'; }
    check() { if echo "$2" | grep -qi "$3"; then echo "  ✓ $1: $3"; else echo "  ✗ $1: missing $3"; fail=1; fi; }
    for p in / /app /levels /changelog; do
        h=$(hdr "$base$p"); check "$p" "$h" '^HTTP/[0-9.]* 200'; check "$p" "$h" 'cache-control: no-cache'
    done
    h=$(hdr "$base/wasm/tryboard.wasm"); check /wasm "$h" '^HTTP/[0-9.]* 200'; check /wasm "$h" 'immutable'
    check /wasm "$h" 'content-type: application/wasm'
    h=$(hdr "$base/robots.txt"); check /robots.txt "$h" '^HTTP/[0-9.]* 200'
    case "$base" in *.pages.dev) check "preview /" "$(hdr "$base/")" 'x-robots-tag: noindex' ;; esac
    exit $fail
