# 009 — Final Triage Result (D-phase summary)

One PABCD cycle, 2026-07-23. P: 000_plan + 001_inventory. A: independent
reviewer (gpt-5.6-terra) GO-WITH-FIXES, 2 blockers folded (#291→bucket 1,
#288 stays bucket 2 with expanded lane scope). B: 6 parallel Sol workers
(gpt-5.6-sol / priority / high). C: main session re-verified the load-bearing
anchors, including an independent re-run of `codex debug models --bundled`.

## Final buckets

### Bucket 1 — answer + close (4)

| # | Why | Draft/action |
|---|---|---|
| 280 | Reporter confirmed fix (missing enabled `openai` provider; config issue, fail-closed by design) | 008 draft reply → close as resolved |
| 291 | Already shipped: provider workspace Settings tab edits adapter/baseUrl/model/auth (ProviderSettings.tsx:115 → PATCH /api/providers, management-api.ts:631) | 008 draft reply → close after reporter confirmation |
| 288 | Configuration-driven: error text is Codex-client-side, but candidates come from OpenCodex's catalog; base mode keeps only upstream V2 pins (Sol/Terra). Workaround: `ocx v2 mode v2` (src/cli/v2.ts:98) + subagentModels, or omit `model` | Reply in Chinese (007 doc) → close as configuration/current-behavior; reopen only if a V2-marked `Ark/*` row is still rejected |
| 297 | Mechanism real, trigger NOT reproduced: local codex-cli 0.144.5 bundled catalog already unions all six rungs (independently re-verified 2026-07-23), so the clamp preserves max/ultra; stripping is correct for strict-enum binaries like 0.133.0 | Reply with the 0.144.5 evidence + ask for reporter's binary version / bundled-catalog output (needs-info). Implement Option B (version-gate) ONLY if a parser-capable/bundled-ladder mismatch is demonstrated |

### Bucket 2 — investigate/fix now (6 issues, 5 work items)

| # | Verdict | Direction | Effort |
|---|---|---|---|
| 295 + 300 | Confirmed opencodex bug (#295, inaccurate "hidden/not in schema/never claim" wording at responses.ts:214 + roster computed from catalog resolution, not the runtime contract) + confirmed feature gap (#300, no off switch) | One combined change: neutral wording, runtime-consistent roster, exclusion diagnostics, `multiAgentGuidanceEnabled` (default on) | 1–2 days |
| 289 | Confirmed opencodex bug: key-auth openai-responses always builds `${base}/v1/responses` (openai-responses.ts:443-444) | Optional relative `responsesPath` on provider config; absent = current behavior; no Volcengine special-case | 0.5–1 day |
| 292 | Reframed: discovery path has NO destination guard at all (fetchProviderModels, catalog.ts:1440-1455); reporter's `SyntaxError` = 2xx non-JSON intermediary body hitting `res.json()`; real defects are missing policy parity on discovery + poor diagnostics | Guard discovery URL with full provider config + content-type-aware diagnostics; ask reporter for status/content-type trace | 0.5 day |
| 287 | Confirmed opencodex capability/GUI-contract bug: darwin-only injection (system-env.ts:210) but Linux gets an actionable toggle + success response | Option (b): disable Auto-connect on non-Darwin with localized "macOS-only; use ocx claude" explanation (reporter accepts this). Linux injection tracked separately | 4–8 h |
| 290 | Needs-repro, distinct from #92 (fails BEFORE child creation). OpenCodex normalizes zero-arg-byte calls to `{}` but no inspected path erases non-empty args | Keep open, `needs-info`: request four-boundary capture; recommend `ocx v2 mode v1` meanwhile | capture 3–5 h |

### Bucket 3 — long-term (1)

| # | Scope |
|---|---|
| 294 | AUTOMATIC Claude pool routing (quota-aware routing, affinity, cooldown, failover). Multi-account Claude already exists (ProviderAuthPanel.tsx:149/192; management-api.ts:1567) but requests use only the active account (src/oauth/index.ts:215). Roadmap-scale |

## Verification evidence (C phase)

- `git status --short`: clean except gitignored devlog — zero production code touched.
- `codex --version` → 0.144.5; `codex debug models --bundled` → gpt-5.6-sol/terra
  `['low','medium','high','xhigh','max','ultra']`, luna `+max` (6-rung union confirmed
  by main session, matching 002 doc).
- src/codex/catalog.ts:1440-1455 read directly: discovery `fetch` with no
  destination-policy guard; `res.ok` check then `res.json()`; catch logs
  `error.name` (SyntaxError chain confirmed).
- src/server/responses.ts:214 read directly: default guidance contains
  "hidden"/"not in the schema"/"never claim" verbatim.
- src/cli/v2.ts:98: `ocx v2 mode v1|default|v2` exists (#288 workaround real).
- gui ProviderSettings.tsx:115 + management-api.ts:631: edit capability exists (#291).
- Worker-reported test runs: destination-policy-resolved 17/17 pass (004 lane);
  007 lane 51 tests pass (2 suites blocked by missing zod/v4 — pre-existing env issue,
  not caused by this unit).

## Not done (explicit non-goals)

- No GitHub comments/closes/labels posted — drafts in 007/008 await user approval.
- No source fixes — each bucket-2 item now has a scoped direction + effort for its own PR.
- No push.

---

## Addendum 2026-07-23 — bucket-1 actions executed (user-approved)

| # | Action | Evidence |
|---|---|---|
| 280 | reply + close | https://github.com/lidge-jun/opencodex/issues/280#issuecomment-5053490275 |
| 291 | reply + close | https://github.com/lidge-jun/opencodex/issues/291#issuecomment-5053490282 |
| 288 | reply + close | https://github.com/lidge-jun/opencodex/issues/288#issuecomment-5053493021 |
| 297 | reply + close (not-repro; reopen on version evidence) | https://github.com/lidge-jun/opencodex/issues/297#issuecomment-5053493027 |

Extra evidence captured for #297 before closing: this machine's synced
`/Users/jun/.codex/opencodex-catalog.json` retains `max`/`ultra` on
gpt-5.6-sol, gpt-5.6-terra, AND gpt-5.5 — the clamp is a no-op under
codex-cli 0.144.5, consistent with the six-rung bundled-catalog union.

Remaining open from triage: #287, #289, #290 (needs-info reply not yet
posted — outside the approved bucket-1 batch), #292, #294, #295, #300.

---

## Addendum 2 — implementation complete (2026-07-23, same day)

All five bucket-2 fixes landed on `codex/bucket2-fixes-260723`, one PABCD
cycle per decade doc, main-session implementation with Sol micro-audits:

| WP | Issue | Commits | Gates |
|---|---|---|---|
| 2 | #289 | f464f966 + ea39977d | focused 68/68, full 3519/3519, tsc, privacy, docs build |
| 3 | #292 | a4bd1d85 | focused 106/106, full 3525/3525, tsc, privacy |
| 4 | #287 | c771aaa5 | 32/32 API + 5/5 GUI SSR, full 3527/3527, tsc, lint:gui, gui build |
| 5 | #295 | f4f90e94 + 95b8717c | focused 31/31, full 3531/3531, tsc, privacy, docs build |
| 6 | #300 | 44082437 + 70d1251e | focused 97/97, full 3542/3542, tsc, lint:gui, build:gui, docs build |

Deviations recorded: WP4 helper split to `gui/src/pages/claude-autoconnect.ts`
(react-refresh lint rule); WP5 kept the v1-injectionPrompt case as a separate
test; WP6 adapted 4 existing PUT toEqual assertions for the additive response
field. WP6 also fixed a real latent bug found in audit: PUT /api/injection-model
was not a true partial update (absent model key deleted stored model+effort).
#290 needs-info reply posted (issuecomment-5053809339), issue stays open.
No push performed; PR split decision left to the user.
