#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# One-shot deployment for the IPQuery server.
#
#   ./deploy.sh <install-dir>
#
# Copies the runtime bundle (dist/, package.json, lockfile, .env.example,
# up/) into <install-dir>, installs production dependencies, applies the
# migrations, and prints what remains for the operator: create the .env,
# initialize the admin, and start the service.
#
# The script is deliberately split in two. Everything that can be
# automated safely runs here; everything that needs a secret (the
# database password, the session/CSRF keys) stops and asks. A deploy
# that invents a password is a deploy nobody can log into.
#
# Exit codes:
#   0  bundle installed and migrated
#   1  a prerequisite is missing (node, npm, existing install dir)
#   2  a step failed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE_DIR="${REPO_ROOT}/up/deploy"

log()  { printf '[deploy] %s\n' "$*"; }
# fail <message> [exit-code] — print the message and exit. The optional
# second argument is the exit code (1 = missing prerequisite,
# 2 = a step failed); it is NOT part of the message.
fail() {
  local message="$1"
  local code="${2:-1}"
  printf '[deploy] ERROR: %s\n' "$message" >&2
  exit "$code"
}

# ── 1. Preconditions ───────────────────────────────────────────────

command -v node >/dev/null 2>&1 || fail "node is not on PATH (need Node >= 20)"
command -v npm  >/dev/null 2>&1 || fail "npm is not on PATH"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node >= 20 required, found $(node -v)" 1
fi

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  fail "usage: $0 <install-dir>   (e.g. $0 /opt/ipquery)" 1
fi

# Resolve to an absolute path without requiring the dir to exist yet.
case "$TARGET" in
  /*) ABS_TARGET="$TARGET" ;;
  *)  ABS_TARGET="$(pwd)/$TARGET" ;;
esac

if [ -e "$ABS_TARGET" ] && [ ! -d "$ABS_TARGET" ]; then
  fail "target exists and is not a directory: $ABS_TARGET" 1
fi

log "repo root : $REPO_ROOT"
log "target    : $ABS_TARGET"
log "node      : $(node -v)"

# ── 2. Build the runtime bundle ───────────────────────────────────
#
# dist/ is gitignored, so it is built here rather than shipped. The
# bundle directory holds everything the server needs that is NOT a
# build artifact or a secret.

log "building dist/ (tsc + copy runtime assets)"
if ! (cd "$REPO_ROOT" && npm run build); then
  fail "build failed — cannot assemble the bundle" 2
fi

for required in dist/cli.js dist/storage/migrations/024_provider_call_counter_minute.sql; do
  if [ ! -f "$REPO_ROOT/$required" ]; then
    fail "build output is missing $required" 2
  fi
done

# ── 3. Install into the target ─────────────────────────────────────

mkdir -p "$ABS_TARGET"

# dist/ holds the compiled app, the SQL schema, every migration, and
# the web assets (Handlebars views, static files, i18n bundles) that
# @fastify/view, @fastify/static and req.t() read at runtime.
log "copying dist/ into $ABS_TARGET"
rm -rf "$ABS_TARGET/dist"
cp -R "$REPO_ROOT/dist" "$ABS_TARGET/dist"

# package.json + package-lock.json let `npm ci --omit=dev` reproduce
# the exact dependency tree that was tested.
for f in package.json package-lock.json; do
  if [ -f "$REPO_ROOT/$f" ]; then
    cp "$REPO_ROOT/$f" "$ABS_TARGET/$f"
  fi
done

# The env template and the bootstrap assets (runbook, seed SQL) travel
# with the bundle so the operator has everything in one directory.
cp "$REPO_ROOT/.env.example" "$ABS_TARGET/.env.example"
mkdir -p "$ABS_TARGET/up"
cp "$REPO_ROOT/up/init-runbook.md" "$ABS_TARGET/up/init-runbook.md"
cp "$REPO_ROOT/up/seed-ip-ranges.sql" "$ABS_TARGET/up/seed-ip-ranges.sql"

# A place for the ETL's raw CSV downloads. Must exist and be writable
# before the ETL runs, or the download stage fails at the first file.
mkdir -p "$ABS_TARGET/data/raw"

# ── 4. Production dependencies ─────────────────────────────────────

log "installing production dependencies (npm ci --omit=dev)"
if ! (cd "$ABS_TARGET" && npm ci --omit=dev --no-audit --no-fund); then
  fail "npm ci failed — check the npm registry / network" 2
fi

# argon2 is a native module; it needs a toolchain on the target, and
# it is the one dependency that commonly fails to install. Say so
# loudly rather than letting the first request die at runtime.
if [ ! -d "$ABS_TARGET/node_modules/argon2" ]; then
  fail "argon2 did not install — the server needs a native build toolchain (python3, make, g++)" 2
fi

# ── 5. Migrations ──────────────────────────────────────────────────
#
# The database password lives in the operator's .env, which does not
# exist yet at this point. If it does, migrate now; otherwise the
# operator runs the command printed below.

if [ -f "$ABS_TARGET/.env" ]; then
  log "found .env — applying migrations"
  if ! (cd "$ABS_TARGET" && node dist/cli.js migrate); then
    fail "migration failed — check DB_* in .env and that the database exists" 2
  fi
  MIGRATED="yes"
else
  MIGRATED="no"
fi

# ── 6. What the operator still has to do ──────────────────────────

cat <<EOF

[deploy] bundle installed at $ABS_TARGET
[deploy]
[deploy] next steps:
[deploy]   1. create the environment file
[deploy]        cd $ABS_TARGET
[deploy]        cp .env.example .env
[deploy]        \$EDITOR .env          # DB_*, SESSION_SECRET, CSRF_SECRET, WEB_BASE_URL
[deploy]
[deploy]   2. generate the two secret keys (they must differ)
[deploy]        node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
[deploy]
[deploy]   3. initialize (migrates, creates the admin, locks /init)
[deploy]        node dist/cli.js init --email <admin@example.com> --password '<strong-password>'
[deploy]
[deploy]   4. load the IP data (optional but needed for real lookups)
[deploy]        node dist/cli.js update
[deploy]
[deploy]   5. start the service
[deploy]        node dist/cli.js serve
[deploy]
[deploy] migrations applied now: $MIGRATED
[deploy] verify afterwards:
[deploy]        node dist/cli.js migrate:status   # every row 'applied'
[deploy]        curl -s localhost:5001/lookup?ip=8.8.8.8

EOF
