#!/usr/bin/env bash
# Local QM for WORLD: Postgres container + local sandbox + pi harness on Anthropic,
# WorldHooks ingress, Memorable procedural memory on the WorldHook owner scope.
#
#   scripts/world-dev.sh env     # write qm.env (once; keeps existing secrets)
#   scripts/world-dev.sh pg      # start the Postgres container
#   scripts/world-dev.sh up      # env + pg + start QM in the foreground (PORT, default 8091)
#
# Secrets come from the WORLD repo (PRESENT_DIR, default ~/dev/present):
#   perception/.env   ANTHROPIC_API_KEY
#   .env.memorable    MEMORABLE_API_KEY, MEMORABLE_API_URL
# qm.env is gitignored (*.env). Never commit it.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

PRESENT_DIR="${PRESENT_DIR:-$HOME/dev/present}"
PORT="${PORT:-8091}"
PG_PORT="${PG_PORT:-55433}"
PG_NAME="${PG_NAME:-world-qm-postgres}"
ENV_FILE="$root/qm.env"
SCOPE="${WORLD_SCOPE:-personal:stephen}"

envval() { # envval FILE KEY
  [[ -f "$1" ]] || return 0
  grep -E "^(export +)?$2=" "$1" | tail -1 | sed -E "s/^(export +)?$2=//; s/^[\"']//; s/[\"']\$//"
}

cmd_pg() {
  if docker ps --format '{{.Names}}' | grep -qx "$PG_NAME"; then return 0; fi
  if docker ps -a --format '{{.Names}}' | grep -qx "$PG_NAME"; then
    docker start "$PG_NAME" >/dev/null
  else
    docker run -d --name "$PG_NAME" --restart unless-stopped \
      -e POSTGRES_USER=qm -e POSTGRES_PASSWORD=qm -e POSTGRES_DB=qm \
      -p "127.0.0.1:${PG_PORT}:5432" -v world-qm-pgdata:/var/lib/postgresql/data postgres:16 >/dev/null
  fi
  for _ in $(seq 1 30); do
    docker exec "$PG_NAME" pg_isready -U qm -d qm >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "postgres did not become ready" >&2
  return 1
}

cmd_env() {
  local anthropic mkey murl
  anthropic="$(envval "$PRESENT_DIR/perception/.env" ANTHROPIC_API_KEY)"
  mkey="$(envval "$PRESENT_DIR/.env.memorable" MEMORABLE_API_KEY)"
  murl="$(envval "$PRESENT_DIR/.env.memorable" MEMORABLE_API_URL)"
  [[ -n "$anthropic" ]] || { echo "ANTHROPIC_API_KEY missing in $PRESENT_DIR/perception/.env" >&2; exit 1; }
  local keep_secret=""
  [[ -f "$ENV_FILE" ]] && keep_secret="$(envval "$ENV_FILE" WORLD_HOOKS_SECRET)"
  gen() { openssl rand -hex 32; }
  local db="postgres://qm:qm@127.0.0.1:${PG_PORT}/qm"
  local mpc='{"providers":[{"id":"procedures","type":"memorable"}],"routes":[{"provider":"default","scopes":["personal","channel","group","team","org"],"capture":"automatic"},{"provider":"procedures","scopes":["personal"],"capture":"automatic","manage":false,"label":"Procedures"}]}'
  umask 077
  if [[ -f "$ENV_FILE" ]]; then
    # keep every existing secret, only refresh the credentials pulled from WORLD
    sed -i '' -E '/^(ANTHROPIC_API_KEY|MEMORABLE_API_KEY|MEMORABLE_API_URL)=/d' "$ENV_FILE"
  else
    cat >"$ENV_FILE" <<EOF
ORG_ID=world
PORT=${PORT}
HARNESS=pi
PI_MODEL=${PI_MODEL:-claude-sonnet-5}
CORE_SIGNING_SECRET=$(gen)
CAPABILITY_SECRET=$(gen)
PORTAL_IDENTITY_SECRET=$(gen)
CONNECTOR_SECRET_KEY=$(gen)
PORTAL_SESSION_SECRET=$(gen)
SKILL_SIGNING_SECRET=$(gen)
DATABASE_URL=${db}
SESSION_STORE=postgres
RUN_STORE=postgres
ARTIFACT_STORE=postgres
DATA_DIR=${root}/data/world
SANDBOX_BACKEND=local
LOCAL_SANDBOX_IMAGE=qm-sandbox-local:latest
SANDBOX_RESOURCES_ENABLED=true
PUBLIC_API_URL=http://host.docker.internal:${PORT}
WORLD_HOOKS_FILE=${root}/deploy/worldhooks/world-hooks.json
WORLD_HUD_URL=${WORLD_HUD_URL:-http://localhost:8787/hud}
WORLD_HOOKS_SECRET=${keep_secret:-world-$(openssl rand -hex 24)}
MEMORY_PROVIDER_CONFIG=${mpc}
MEMORABLE_BACKEND=qm
MEMORABLE_VARIANT=l2
MEMORABLE_DB_URL=${db}
EOF
  fi
  {
    echo "ANTHROPIC_API_KEY=${anthropic}"
    [[ -n "$mkey" ]] && echo "MEMORABLE_API_KEY=${mkey}"
    [[ -n "$murl" ]] && echo "MEMORABLE_API_URL=${murl}"
  } >>"$ENV_FILE"
  mkdir -p "$root/data/world"
  echo "wrote $ENV_FILE (secrets not shown)"
}

cmd_up() {
  [[ -f "$ENV_FILE" ]] || cmd_env
  cmd_pg
  docker image inspect qm-sandbox-local:latest >/dev/null 2>&1 || npm run sandbox:local:build
  [[ -f .generated/connector-sdk/sdk.cjs ]] || npm run build:connector-sdk
  exec node --env-file="$ENV_FILE" src/index.ts
}

cmd_consent() {
  echo "MEMORABLE_BACKEND=qm MEMORABLE_DB_URL=postgres://qm:qm@127.0.0.1:${PG_PORT}/qm memorable enable --scope ${SCOPE}"
}

case "${1:-up}" in
  env) cmd_env ;;
  pg) cmd_pg ;;
  up) cmd_up ;;
  consent) cmd_consent ;;
  *) echo "usage: $0 [env|pg|up|consent]" >&2; exit 2 ;;
esac
