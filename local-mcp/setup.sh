#!/usr/bin/env bash
# Stand up terrestrial-brain-mcp's local Postgres+pgvector backend from
# scratch (no Supabase account, no Docker) and start the MCP server.
# See local-db-client.ts and the PR it shipped in for why this exists.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_ROLE="brain_app"
PG_PASS="brain_local_dev"
PG_DB="terrestrial_brain"

log() { echo "[terrestrial-brain-setup] $*"; }

is_termux() { [ -n "${PREFIX:-}" ] && [[ "$PREFIX" == *com.termux* ]]; }

# --- Postgres + pgvector ---------------------------------------------------
if is_termux; then
  # Termux ships its own native Postgres (bionic build) but no pgvector
  # package for it — build the extension from source against Termux's own
  # pg_config instead of routing through proot-Debian (which only has PG 17,
  # not 16, and would add a second, slower, non-native Postgres for no gain).
  PGDATA_LOCAL="$REPO_ROOT/local-mcp/.pgdata"
  PG_LOG="$REPO_ROOT/local-mcp/.pgdata.log"
  PGVECTOR_SRC="$REPO_ROOT/local-mcp/.pgvector-src"

  if [ ! -f "$PGDATA_LOCAL/PG_VERSION" ]; then
    log "Termux: initializing native Postgres data dir ..."
    initdb -D "$PGDATA_LOCAL" -U postgres --auth=trust >/dev/null
  fi
  if ! pg_ctl -D "$PGDATA_LOCAL" status >/dev/null 2>&1; then
    log "Termux: starting native Postgres ..."
    pg_ctl -D "$PGDATA_LOCAL" -l "$PG_LOG" -o "-p 5432" start
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && break
      sleep 1
    done
  fi

  if ! psql -U postgres -h 127.0.0.1 -tAc "SELECT 1 FROM pg_extension WHERE extname='vector'" 2>/dev/null | grep -q 1; then
    if [ ! -d "$PGVECTOR_SRC" ]; then
      log "Cloning pgvector source ..."
      git clone --depth 1 https://github.com/pgvector/pgvector.git "$PGVECTOR_SRC"
    fi
    log "Building pgvector against Termux's Postgres ..."
    # Termux's own pg_config bakes in /usr/bin/mkdir, /usr/bin/install (plain
    # Linux paths that don't exist here — Termux only has $PREFIX) and links
    # without libm (bionic keeps math fns out of libc, unlike glibc), so all
    # three need overriding for this build specifically.
    (cd "$PGVECTOR_SRC" && make PG_CONFIG="$(command -v pg_config)" clean >/dev/null 2>&1
     cd "$PGVECTOR_SRC" && make PG_CONFIG="$(command -v pg_config)" SHLIB_LINK="-lm" \
       && make install PG_CONFIG="$(command -v pg_config)" \
            MKDIR_P="$(command -v mkdir) -p" INSTALL="$(command -v install)") \
      || log "pgvector build failed — see output above; extension install below will then fail too"
  fi
  PSQL=(psql -U postgres -h 127.0.0.1)
else
  if ! dpkg -s postgresql-17-pgvector >/dev/null 2>&1; then
    log "Installing postgresql-17-pgvector ..."
    apt-get update -qq && apt-get install -y postgresql-17-pgvector
  fi
  pg_lsclusters 2>/dev/null | grep -q "^17 *main.*online" || pg_ctlcluster 17 main start
  PSQL=(sudo -u postgres psql)
fi

if ! "${PSQL[@]}" -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PG_ROLE'" | grep -q 1; then
  log "Creating role/database ..."
  "${PSQL[@]}" -c "CREATE ROLE $PG_ROLE LOGIN PASSWORD '$PG_PASS';"
  "${PSQL[@]}" -c "CREATE DATABASE $PG_DB OWNER $PG_ROLE;"
  for r in anon authenticated service_role; do
    "${PSQL[@]}" -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='$r') THEN CREATE ROLE $r NOLOGIN; END IF; END \$\$;"
  done
  "${PSQL[@]}" -c "GRANT service_role TO $PG_ROLE;"
  "${PSQL[@]}" -d "$PG_DB" <<SQL
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS \$f\$ SELECT 'service_role'::text; \$f\$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT NULL::uuid; \$f\$;
GRANT ALL ON SCHEMA extensions TO $PG_ROLE;
GRANT ALL ON SCHEMA public TO $PG_ROLE;
GRANT USAGE ON SCHEMA auth TO $PG_ROLE;
GRANT EXECUTE ON FUNCTION auth.role() TO $PG_ROLE;
GRANT EXECUTE ON FUNCTION auth.uid() TO $PG_ROLE;
ALTER DATABASE $PG_DB SET search_path TO public, extensions;
SQL

  log "Applying migrations ..."
  export PGPASSWORD="$PG_PASS"
  for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
    psql -h 127.0.0.1 -U "$PG_ROLE" -d "$PG_DB" -v ON_ERROR_STOP=1 -f "$f" 2>&1 | grep -i error && log "  (non-fatal, see above: $(basename "$f"))"
  done
  # Statements that require the `postgres` role (ALTER DEFAULT PRIVILEGES ...
  # FOR ROLE postgres) are skipped above by design — irrelevant when this
  # role owns everything it creates. The two role-scoped grants that don't
  # need superuser still apply here:
  psql -h 127.0.0.1 -U "$PG_ROLE" -d "$PG_DB" -v ON_ERROR_STOP=1 <<SQL 2>&1 | grep -i error
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
SQL
else
  log "Database already provisioned, skipping schema setup."
fi

# --- local-mcp/ tooling (deno, pg, mcp sdk via npm) ------------------------
if [ ! -d "$REPO_ROOT/local-mcp/node_modules" ]; then
  log "Installing local-mcp tooling ..."
  (cd "$REPO_ROOT/local-mcp" && npm install)
fi

# --- MCP_ACCESS_KEY (fresh per environment, never committed) --------------
if [ ! -f "$REPO_ROOT/local-mcp/.env.local" ]; then
  echo "MCP_ACCESS_KEY=$(openssl rand -hex 24)" > "$REPO_ROOT/local-mcp/.env.local"
  log "Generated new MCP_ACCESS_KEY -> local-mcp/.env.local"
fi
MCP_KEY=$(cut -d= -f2 "$REPO_ROOT/local-mcp/.env.local")

# --- start the MCP server ---------------------------------------------------
DENO_BIN="$REPO_ROOT/local-mcp/node_modules/.bin/deno"
log "Starting MCP server on :8000 (LOCAL_PG_URL set, OPENROUTER_BASE -> OmniRoute) ..."
cd "$REPO_ROOT/supabase/functions/terrestrial-brain-mcp"
LOCAL_PG_URL="postgres://$PG_ROLE:$PG_PASS@127.0.0.1:5432/$PG_DB" \
MCP_ACCESS_KEY="$MCP_KEY" \
OPENROUTER_BASE="${OPENROUTER_BASE:-http://127.0.0.1:20128/v1}" \
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-set-a-real-omniroute-key}" \
nohup "$DENO_BIN" run --allow-net --allow-env --allow-read --allow-write index.ts \
  > "$REPO_ROOT/local-mcp/server.log" 2>&1 &
disown
log "MCP server starting (PID $!) — log at local-mcp/server.log. Verify: curl http://127.0.0.1:8000"
