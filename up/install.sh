#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Install and initialize IPQuery from this directory.
#
#   cp -r ipquery-up/ /opt/ipquery/
#   cd /opt/ipquery
#   bash install.sh
#
# This directory already contains the compiled application (dist/), the
# dependency manifest and the .env template. What it does NOT contain is
# node_modules: those are 12,466 files and 50 MB, and argon2 ships
# platform-specific binaries that must be compiled on the target anyway.
#
# So the steps are:
#
#   1. npm ci --omit=dev        install the exact dependency tree
#   2. create data/raw/         where the ETL puts its raw CSV
#   3. migrate                  apply the SQL migrations
#   4. print what remains       the .env, the admin account, the data
#
# Steps that need a secret stop and ask. This script never invents a
# database password: a deployment that makes one up is a deployment
# nobody can log into.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '[install] %s\n' "$*"; }
fail() {
  local message="$1"
  local code="${2:-1}"
  printf '[install] ERROR: %s\n' "$message" >&2
  exit "$code"
}

# ── 1. Preconditions ───────────────────────────────────────────────

command -v node >/dev/null 2>&1 || fail "node is not on PATH (need Node >= 20)"
command -v npm  >/dev/null 2>&1 || fail "npm is not on PATH"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node >= 20 required, found $(node -v)" 1
fi

[ -f "$APP_DIR/dist/cli.js" ] || fail "dist/cli.js is missing — this is not a complete release directory" 2
[ -f "$APP_DIR/package.json" ] || fail "package.json is missing" 2
[ -f "$APP_DIR/package-lock.json" ] || fail "package-lock.json is missing" 2

log "install root : $APP_DIR"
log "node        : $(node -v)"

# ── 2. Production dependencies ─────────────────────────────────────

log "installing production dependencies (npm ci --omit=dev)"
if ! (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund); then
  fail "npm ci failed — check the npm registry / network. If argon2 is the failure, install a native toolchain: apt-get install -y python3 make g++" 2
fi

# argon2 is the one native dependency and it fails late otherwise: the
# install appears to succeed and the first login request dies instead.
if [ ! -d "$APP_DIR/node_modules/argon2" ]; then
  fail "argon2 did not install — the server needs a native build toolchain (python3, make, g++)" 2
fi

# ── 3. Runtime directories ─────────────────────────────────────────

# DATA_DIR defaults to ./data, resolved against the process working
# directory. Creating it here keeps that resolution predictable.
mkdir -p "$APP_DIR/data/raw"
log "data directory ready: $APP_DIR/data/raw"

# ── 4. Environment file ────────────────────────────────────────────

if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env" 2>/dev/null || true
  log "created .env from .env.example — EDIT IT before starting the service"
  log "  required: DB_* , SESSION_SECRET , CSRF_SECRET , WEB_BASE_URL"
  log "  generate the two secrets (they must differ):"
  log "    node -e \"console.log(require('crypto').randomBytes(48).toString('base64'))\""
  NEEDS_ENV="yes"
else
  NEEDS_ENV="no"
fi

# ── 5. Migrations ──────────────────────────────────────────────────

# The migrations need a reachable database with the credentials from
# .env. If the operator has not filled them in yet, this fails — which
# is correct: running the service against a half-configured database
# is worse than stopping here.
log "applying migrations"
if ! (cd "$APP_DIR" && node dist/cli.js migrate); then
  fail "migration failed — check DB_* in .env, that the database exists, and that the user can create tables" 2
fi

# ── 6. What remains ────────────────────────────────────────────────

cat <<EOF

[install] installation complete at $APP_DIR
[install]
[install] remaining steps:
[install]
[install]   1. create the admin account (this also loads the optional
[install]      seed data and locks /init):
[install]        node dist/cli.js init --email <admin@example.com> --password '<strong-password>'
[install]
[install]   2. load the real IP data (DB-IP, about 5-15 minutes):
[install]        node dist/cli.js update
[install]
[install]   3. start the service:
[install]        node dist/cli.js serve
[install]
[install]   .env filled in now: $NEEDS_ENV
[install]
[install] verify:
[install]        node dist/cli.js migrate:status      # every row 'applied'
[install]        curl -s localhost:5001/healthz       # {"status":"ok"}
[install]        curl -s "localhost:5001/lookup?ip=8.8.8.8"
[install]

EOF
