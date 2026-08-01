# 010 — Local codex-rs pull and clones (measured)

- Measured: 2026-07-23 Asia/Seoul
- Method: `git fetch/pull` + `git rev-parse` / `status -sb` on local clones

## Clones

| Path | Remote origin | Branch at measure | HEAD |
| --- | --- | --- | --- |
| `/Users/jun/Developer/codex/120_codex-cli` | `https://github.com/openai/codex.git` | `main` tracking `origin/main` | `4462b9deef211723b781b426f5e5d36a5777115f` |
| `/Users/jun/Developer/codex/120_codex-cli/codex-rs` | same repo nested path | same | same tip (monorepo path) |
| `/Users/jun/Developer/codex/121_openai-codex` | `https://github.com/openai/codex.git` | feature `codex/spawn-agent-metadata-ux` | `fde7de4d0480695079e5aa79ef010ecf239f824a` |
| `121` `origin/main` / local `main` ref | same | updated without checkout switch of feature branch | `4462b9dee...` |

Additional remotes on both clones: `fork` → `https://github.com/lidge-jun/codex.git`.

## Pull evidence (120)

- Pre-pull `main`: `2e8c3756f`
- Command: `git fetch origin --prune && git pull --ff-only origin main`
- Post-pull tip subject: `4462b9dee 2026-07-23 06:28:27 +0000 Allow disabling the multi-agent wait tool (#34887)`
- Dirty residual after pull: untracked `website/` only (`git status -sb` → `## main...origin/main` + `?? website/`)

## 121 handling

- Did **not** hard-reset feature worktree onto main.
- Fetched `origin/main` and fast-forwarded local `main` ref to `4462b9dee`.
- Feature branch tip remains `fde7de4d0` message: `fix(multi-agent-v2): expose spawn_agent metadata by default...`

## Why this matters for OpenCodex

OpenCodex does not vendor codex-rs. Compatibility work is catalog/config/Responses-proxy alignment against measured upstream contracts at this SHA.
