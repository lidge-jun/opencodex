# 080 — /effort matching + CLAUDE.md per-turn injection vs caching

Round 5 (user report 260711 20:30): "추론 강도가 제대로 매칭되고 있지 않는것 같아",
"claude.md의 캐싱로직 매턴 주입을 고려해봐". PABCD loop, manual FSM (cxc CLI absent).

## Evidence

### Local wire capture (PRIMARY, this machine)

Capture server on :18899, real `claude` 2.1.207 (`~/.local/bin/claude`, bun-native
build), user's logged-in config, `claude -p "hi" --model claude-opus-4-8 --effort high`:

```json
{ "thinking": { "type": "adaptive", "display": "omitted" },
  "output_config": { "effort": "high" }, "max_tokens": 64000 }
```

No `budget_tokens` anywhere. (`-p` runs against non-opus models hung intermittently at
startup before any network I/O — capture limited to opus; family behavior corroborated
below.)

### sol explorer findings (Tier-2 proven, 2026-07-11)

- Adaptive-thinking models (fable-5, sonnet-5, opus-4-7/4-8): Claude Code sends
  `thinking:{type:"adaptive"}` + `output_config:{effort:"low|medium|high|xhigh|max"}`.
  Fixed effort→budget tables DO NOT exist for adaptive models; `31999` was the legacy
  manual-thinking budget. Sources: CLIProxyAPI#1540 (live capture), Anthropic
  adaptive-thinking + effort docs, claude-code#8756, #65863 (3P endpoints receive the
  same body; subagents may send `thinking:{type:"disabled"}`).
- Legacy non-adaptive models still use `thinking:{type:"enabled",budget_tokens:N}`.
  CLIProxyAPI budget→level thresholds: <=512 minimal, <=1024 low, <=8192 medium,
  <=24576 high, else xhigh. LiteLLM uses its own table (1024/2048/4096/8192/16384).
- CLAUDE.md: injected into the FIRST user message only (support.claude.com 14553240,
  claude-code#47098 capture); per-turn `<system-reminder>`s APPEND to the next
  user/tool-result — prefix-safe, no per-turn cache bust.
- Top-level `cache_control` automatic caching is an official API feature; the automatic
  breakpoint consumes one of the 4 slots (explicit 4 + top-level = 400; TTL mismatch on
  the last block = 400; 20-block lookback per breakpoint). Bedrock unsupported.

### Live daemon log decode

- claude-fable-5/opus rows showed effort "high" = the OCX-side default, NOT the user's
  /effort — inbound dropped `output_config.effort` on the floor, so `reasoning` was
  `{summary:"auto"}` with no effort and downstream defaults filled it.
- gpt-5.6-sol rows "-" = adaptive requests (effort ignored); "low" rows = the
  smallFastModel (haiku slot) mapped to gpt-5.6-sol receiving legacy
  `thinking.enabled` small budgets.
- Caching re-check with the fixed accounting (usage.jsonl): steady-state turns are
  `noncache=2` tokens (e.g. in=243,493 / read=243,147 / write=344) — routed-path
  caching is effectively optimal. The "49만 / c 24.4만" screenshot was a STALE GUI
  bundle still double-adding cache detail (old displayTokenTotal); server rows for the
  same requestIds prove ~99.9% hits. Action: rebuild/redeploy the GUI bundle, then
  hard-refresh.

## Decisions

1. **Effort matching (BUG FIX)**: `anthropicToResponsesBody` now maps
   `output_config.effort` (adaptive wire) to `reasoning.effort` verbatim for the known
   ladder (minimal/low/medium/high/xhigh/max/ultra); `thinking.enabled+budget_tokens`
   keeps the existing ladder (<=4096 low, <=16384 medium, else high — unchanged, spans
   the legacy 31999 correctly); `thinking.disabled` keeps sending no reasoning.
   output_config wins over budget when both appear.
2. **CLAUDE.md / per-turn injection (NOOP by evidence)**: CC injects CLAUDE.md once at
   the first user message; reminders append at the tail. Our adapter re-serialization is
   deterministic and its breakpoints (tools/system/penultimate-user + top-level auto)
   already yield ~100% steady-state hits, and our slot math (auto + explicit<=3) and
   single-TTL policy respect the 4-slot and TTL-conflict rules the explorer verified.
   No breakpoint change needed; evidence recorded here.
3. GUI stale-bundle note: served bundle must be rebuilt after 7f80b05 for the c/w split
   to display truthfully.
