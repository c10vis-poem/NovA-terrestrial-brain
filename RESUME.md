# RESUME — Terrestrial Brain Pipeline

## Status: ROUND-TRIP PROVEN (2026-09-18)

Phone → TB → OpenRouter → Postgres → vault markdown — fully verified.
Test thought `LUNAR-42-DELTA` is in DB (id `8c79f79f`) and in vault
(`memories/2026-09-18-The-NovAExorpus-vault-verification-code.md`).

### Fixes applied this session (on VM, not in repo code)
- `thoughts.reliability` column changed from `double precision` to `text`
  (code passes `"less reliable"`, not a number)
- `thoughts` table gained `reference_id`, `note_snapshot_id`, `metadata` columns
- `deno.json` got `"nodeModulesDir": "auto"` and `postgres` import
- systemd unit: `OPENROUTER_BASE` changed from localhost OmniRoute to real
  OpenRouter; `OPENROUTER_API_KEY` added
- Rejection logging added to `freshIngest` in helpers.ts on VM

### What's verified working

| Component | Status | Evidence |
|-----------|--------|----------|
| TB server | Running | `Listening on http://0.0.0.0:8000/` in journalctl |
| Auth gate | Working | `{"error":"Invalid or missing access key"}` without key, MCP protocol response with key |
| DB schema | Correct | Direct insert returned UUID; thoughts table has content, embedding, metadata, reference_id, note_snapshot_id columns |
| DB permissions | Granted | `GRANT ALL ON thoughts TO brain_app` executed |
| OpenRouter API | Works from VM | Test script got 200 + embedding vector from `openai/text-embedding-3-small` |
| Firewall | Open | Port 8000 reachable from phone (`curl http://34.31.112.77:8000/` returns JSON) |
| Phone env vars | Set | `TB_MCP_URL` and `TB_MCP_KEY` in `$PREFIX/etc/secrets.env` |
| Vault write-through code | Committed | `writeVaultNote()` in helpers.ts, wired into thoughts.ts, projects.ts, tasks.ts — pushed to fork hash `7f545fd` |
| systemd unit | Created | `/etc/systemd/system/terrestrial-brain.service`, auto-restarts |
| deno.json | Fixed | Added `postgres` import, set `"nodeModulesDir": "auto"` |

### What's NOT done

- Round-trip proof (blocked on the one env var above)
- Vault git repo remote not added (`git remote add origin`)
- Obsidian Git plugin not configured
- mem0 vault export script (like writeVaultNote but for mem0)
- notebook-lm integration
- Web UI dashboards on VM
- mem0 self-hosting on VM
- Bootstrap.sh update (points at localhost, services are on VM)
- Systemd unit for OmniRoute
- Shell alias `cc="claude --output-style router-guard"`
- Global ~/.claude/CLAUDE.md rewrite
- Reasoning Bank / Continual Harness (spec-only, not on disk)

### Key files modified this session

- `~/repos/NovA-terrestrial-brain/supabase/functions/terrestrial-brain-mcp/helpers.ts` — added `writeVaultNote()`
- `~/repos/NovA-terrestrial-brain/supabase/functions/terrestrial-brain-mcp/tools/thoughts.ts` — vault write on capture
- `~/repos/NovA-terrestrial-brain/supabase/functions/terrestrial-brain-mcp/tools/projects.ts` — vault write on create
- `~/repos/NovA-terrestrial-brain/supabase/functions/terrestrial-brain-mcp/tools/tasks.ts` — vault write on create
- VM: `/etc/systemd/system/terrestrial-brain.service` — systemd unit
- VM: `/home/u0_a538/NovA-terrestrial-brain/local-mcp/deno.json` — added postgres, nodeModulesDir auto
- VM: `/home/u0_a538/NovA-terrestrial-brain/local-mcp/.env.local` — MCP_ACCESS_KEY, OPENROUTER vars
- Phone: `$PREFIX/etc/secrets.env` — TB_MCP_URL, TB_MCP_KEY
- `~/.claude/skills/obsidian-vault/SKILL.md` — corrected (not Drive-synced, vault is write endpoint)
- `~/repos/NovAExorpus/CLAUDE.md` — corrected vault description
- `~/repos/NovAExorpus/.claude/output-styles/router-guard.md` — added multi-write pipeline protocol
- `~/repos/aesop-xi/tools/setup-graph-pipeline.sh` — created, ran successfully
