#!/usr/bin/env bash
#
# Deploy Noctua. Safe to run again at any time — every step is idempotent.
#
#   ./deploy.sh                     on the host: build, restart, wait for health, report
#   ./deploy.sh user@vps.example    from a laptop: sync this checkout to the host, then do the above
#                                   there over SSH
#
# The host is never hard-coded. Pass it as the first argument or set NOCTUA_HOST.
#
#   NOCTUA_HOST        user@host to deploy to (same as the first argument)
#   NOCTUA_REMOTE_DIR  where the checkout lives on the host        (default /opt/noctua)
#   NOCTUA_PORT        published loopback port, from compose       (default 8090)
#   NOCTUA_HEALTH_S    seconds to wait for the health check        (default 120)
#
# What it deliberately does NOT do: touch the host's .env. That file holds the API key and the
# access code, it is written once by hand, and a deploy script that can overwrite it is a deploy
# script that can silently unlock the app.

set -euo pipefail

HOST="${1:-${NOCTUA_HOST:-}}"
REMOTE_DIR="${NOCTUA_REMOTE_DIR:-/opt/noctua}"
PORT="${NOCTUA_PORT:-8090}"       # must match the published port in docker-compose.yml
HEALTH_S="${NOCTUA_HEALTH_S:-120}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mdeploy failed: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------
# Remote half: sync this working tree up, then run this same script on the other end.
# ---------------------------------------------------------------------------------------------
if [ -n "$HOST" ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  say "syncing $here → $HOST:$REMOTE_DIR"
  ssh "$HOST" "mkdir -p '$REMOTE_DIR'"
  # --delete keeps the host from accumulating files deleted here. Excluded paths are protected
  # from it, which is what saves the host's .env, its data/ of past runs, and its build output.
  rsync -az --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude 'web/node_modules/' \
    --exclude 'dist/' \
    --exclude 'web/dist/' \
    --exclude 'data/' \
    --exclude '.env' \
    "$here/" "$HOST:$REMOTE_DIR/"

  say "deploying on $HOST"
  # NOCTUA_HOST is cleared so the remote copy takes the local branch below instead of trying to
  # deploy onwards to itself.
  ssh "$HOST" "cd '$REMOTE_DIR' && NOCTUA_HOST= NOCTUA_PORT='$PORT' NOCTUA_HEALTH_S='$HEALTH_S' bash deploy.sh"
  exit $?
fi

# ---------------------------------------------------------------------------------------------
# Local half: this runs on the host.
# ---------------------------------------------------------------------------------------------
cd "$(dirname "${BASH_SOURCE[0]}")"

command -v docker >/dev/null || die "docker is not installed"
command -v curl >/dev/null || die "curl is not installed — it is what waits for /healthz below"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is not available"
[ -f .env ] || die ".env is missing — copy .env.example and fill in ANTHROPIC_API_KEY and a real ACCESS_CODE"

# The app refuses to boot in production without a long access code, so catch it here rather than in
# a crash loop the operator has to read the logs to understand.
if ! grep -Eq '^ACCESS_CODE=.{12,}' .env; then
  die "ACCESS_CODE in .env must be at least 12 characters — it is the only thing guarding the app"
fi

say "building"
# `up -d --build` split in two, so the step below can ask the finished image which uid it runs as.
docker compose build

# The image runs as an unprivileged user, and ./data is bind-mounted over the directory the image
# created for it — so the mount arrives with the *host* directory's ownership, and the container
# cannot write its run logs unless that ownership matches. Asking the image is better than a
# hard-coded 1001 that a base-image bump would quietly invalidate.
say "preparing ./data"
mkdir -p data
owner="$(docker run --rm noctua:latest sh -c 'echo "$(id -u):$(id -g)"')"
if [ "$(stat -c '%u:%g' data)" != "$owner" ]; then
  chown -R "$owner" data 2>/dev/null \
    || die "./data must be owned by $owner for the container to write to it — run: sudo chown -R $owner '$PWD/data'"
fi

say "starting"
docker compose up -d

say "waiting for /healthz on 127.0.0.1:$PORT (up to ${HEALTH_S}s)"
deadline=$(( SECONDS + HEALTH_S ))
until curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    docker compose logs --tail 40 || true
    die "no healthy response after ${HEALTH_S}s — logs above"
  fi
  sleep 2
done
curl -fsS "http://127.0.0.1:$PORT/healthz"; echo

say "status"
docker compose ps
docker image inspect noctua:latest --format 'image size: {{.Size}} bytes' || true

say "last 20 log lines"
docker compose logs --tail 20

say "deployed — reverse-proxy 127.0.0.1:$PORT and remember proxy_buffering off for /api/*/events"
