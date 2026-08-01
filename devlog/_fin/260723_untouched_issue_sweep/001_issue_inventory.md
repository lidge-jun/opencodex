# Issue Inventory — Untouched Issue Sweep

## Code-Fix Issues

### #322 — Shim first-arg bypass (uncleblue)
- **Title:** Shim only checks $1 for CODEX_INTERNAL_COMMANDS
- **Root cause:** Unix/Windows/PS shim checks only first CLI arg against
  CODEX_INTERNAL_COMMANDS. `codex -s read-only -a untrusted app-server` has
  $1="-s", so app-server bypass is missed and ocx ensure runs.
- **Impact:** CodexBar polls defeat `ocx stop` — proxy revives every ~20s.
- **Fix scope:** src/codex/shim.ts (Unix, Windows cmd, PowerShell shim builders)
- **Priority:** High — active user pain with CodexBar

### #327 — __main__ needsReauth not exposed (jhste102lab)
- **Title:** Account list API/dashboard doesn't show __main__ invalid state
- **Root cause:** Two gaps in src/codex/auth-api.ts:
  1. listCodexAuthAccounts() main DTO omits needsReauth (pool DTOs have it)
  2. fetchMainAccountInfo() silently swallows 401/403 without marking reauth
- **Impact:** Dashboard shows no warning when main credential dies; pool rotation
  picks invalid main account causing upstream 403s
- **Fix scope:** src/codex/auth-api.ts
- **Priority:** High — silent auth failures in pool mode

### #323 — reasoning_summary_delivery compatibility (Eleven-is-cool)
- **Title:** Per-model reasoning summary delivery compatibility
- **Root cause:** ensureStrictCatalogFields() defaults supports_reasoning_summaries
  to true. Codex sends sequential_cutoff to models that reject it with 400.
- **Impact:** Third-party Responses API models fail with upstream 400
- **Fix scope:** src/codex/catalog.ts (or equivalent catalog field defaults)
- **Priority:** Medium — affects third-party Responses routes

## Triage-Comment Issues

### #320 — Pool OK but native auth expired shows login (jhste102lab)
- **Verdict:** Partially valid / CLI limitation
- **Analysis:** Codex CLI checks native auth.json before proxy intercept. Pool
  being alive cannot prevent CLI's own login gate. Shim reinstall after npm
  update is real pain. Suggest: fix #327 first (needsReauth exposure), then
  document the CLI-side limitation. "Pool should suppress login" needs upstream
  CLI changes outside OpenCodex scope.

### #324 — websockets:false returns 426 (jhste102lab)
- **Verdict:** Intended behavior + UX/docs issue
- **Analysis:** Default websockets:false, Design B. Builtin openai tries WS
  first, gets 426, should fall back to HTTP. If fallback works, it's a
  codex doctor warning, not a bug. If it blocks, user needs websockets:true.
  Needs docs/doctor message improvement.

### #326 — Tool-heavy WS continuation loop (kdnsna)
- **Verdict:** Needs-info / investigation required
- **Analysis:** Intermittent, 200-response continuation loop. Not a simple retry.
  Distinct from #215 (400 mismatch) and #272 (item ID instability). Needs
  redacted WS event sequence (response.completed presence, tool output handling,
  new resp_* creation pattern).

### #294 — Claude account pool feature request (str0203)
- **Verdict:** Roadmap park
- **Analysis:** Feature request for Claude pool parity with ChatGPT pool.
  Already triaged as roadmap item. HaydernCenterpoint noted Claude's stricter
  account security makes pool approach risky. Park with acknowledgment.
