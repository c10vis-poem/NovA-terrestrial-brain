# RESUME — Terrestrial Brain Pipeline

## Status: ONE COMMAND FROM ROUND-TRIP PROOF

### The blocker

The systemd unit at `/etc/systemd/system/terrestrial-brain.service` on the VM
(omniroute-brain, 34.31.112.77) does NOT pass `OPENROUTER_API_KEY` to the TB
process. The key IS in `.env.local` but systemd's `EnvironmentFile` isn't
propagating it (possibly because the `Environment=` lines that follow override
the file's namespace). Fix:

```bash
# ON THE VM (gcloud compute ssh omniroute-brain --zone=us-central1-a):
sudo sed -i '/Environment=VAULT_MEMORIES_DIR/a Environment=OPENROUTER_API_KEY=<THE_KEY>' /etc/systemd/system/terrestrial-brain.service
sudo systemctl daemon-reload
sudo systemctl restart terrestrial-brain
```

The key is the OpenRouter API key (starts with `sk-or-v1-`). On phone: `cat ~/.openwiki/.env`.

### After fixing, verify with:

```bash
# From phone:
curl -s -X POST http://34.31.112.77:8000/ingest-note \
  -H "x-brain-key: $TB_MCP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "Unique pipeline test: The NovAExorpus vault verification code is LUNAR-42-DELTA.", "title": "Pipeline Round-Trip Test"}'
```

Expected: `{"success":true,"message":"Captured 1 thought from ..."}`.

Then check vault file was written:
```bash
gcloud compute ssh omniroute-brain --zone=us-central1-a --command="ls /home/u0_a538/NovAExorpus-vault/memories/"
```

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
