# 260820 — Sidecar selection unification (#2188)

Roadmap for implementing issue #2188 as a stacked PR chain onto dev.
Session 01a01f4b; goalplan implement-github-issue-2188-feat-sidecar-unify-w.

## Docs
- 000 (this file) — unit overview + stack map.
- 000_wp0 — branch/worktree cleanup record (executed, closed).
- 001 — research: current selection state at dev f2ebd3067.
- 010 — Layer 1: src/sidecar/auth.ts shared auth + slots (branch codex/sidecar-auth-slots → dev).
- 020 — Layer 2: src/sidecar/candidates.ts picker set + vision filter (codex/sidecar-picker-candidates → L1).
- 030 — Layer 3: web-search backend registry + candidate ∩ (no default-backend change) (codex/sidecar-websearch-slots → L2).
- 031 — future-backend research table + probe contracts (doc-only, inside L3 PR).
- 040 — Layer 4: write gates + GUI lists (codex/sidecar-write-gates → L3).
- 050 — Layer 5: ocx agent sidecar --list + docs-site + full validation (codex/sidecar-cli → L4).

## Stack invariants (DEV-STACK)
Bottom targets dev; each child targets the branch below. Merge bottom-up; retarget children after parent lands. Each layer: own tests green + typecheck before PR; full suite at top layer. Every A/C gate: xai/grok-4.6 read-only reviewer, verdict binding.

## Out of scope (issue-fixed)
Gemini/Grok/Zen/Exa executors, #2190 x_search, #398, types.ts-split rebases.


## AMENDMENT 1 (post-audit, auditor Hegel VERDICT: fail — all four blockers accepted)

### B1 — isCodexAuth must mean LOGIN, not provider presence (fixes 010)
```ts
// src/sidecar/auth.ts
isCodexAuth = listOpenAiForwardSidecarCandidates(config).length > 0
  && ( isCodexAccountUsable(config, MAIN_CODEX_ACCOUNT_ID)            // live ~/.codex auth.json token
       || (config.codexAccounts ?? []).some(a => isSelectableCodexPoolAccount(a)
             && isCodexAccountUsable(config, a.id)) )                  // any usable pool credential
```
Symmetric with the Anthropic predicate (stored OAuth + !needsReauth). Uses src/codex/account-usability.ts:17 isCodexAccountUsable; no header/request context needed. Test: forward provider present but no live token & no pool creds → isCodexAuth false → Luna slot absent.

### B2 — extend ocx agent sidecar, do NOT add ocx sidecar (fixes 001 + 050)
001 correction: src/cli/agent.ts:23 already ships `ocx agent sidecar <status|web|vision>` → PUT /api/sidecar-settings. Layer 5 extends it:
- `ocx agent sidecar web --list` / `vision --list` print the exact candidate sets via a new GET consumer (same functions as GUI).
- Writes already flow through the PUT gate added in L4 (server-side gate covers CLI automatically — the "CLI cannot bypass" property comes from gating the shared route, not from a parallel client check).
- No new top-level command. 050's src/cli/sidecar.ts is WITHDRAWN.

### B3 — claude-code webSearch write gate is REQUIRED in L4 (fixes 040)
- src/server/management/agent-settings-routes.ts:1064 writes webSearchSidecar.model ungated → same membership gate as /api/sidecar-settings (shared helper in src/server/management/web-search-sidecar-options.ts, mirroring vision-sidecar-options.ts placement; extraction happens IN L4, so L5 never restacks routes — also resolves the L5 write-gate.ts smell).
- `ocx claude config set --web-model` rides the same route → covered.
- Out of scope (explicit): `ocx config set webSearchSidecar.model` raw JSON writes bypass management gates by design (operator escape hatch, same as vision today).
- GUI contract: GET must send webSearchModels: [] when empty, never omit (dashboard-shared.ts:273 omission fallback would show the full union). Persisted-but-now-illegal model: display-grandfather into options (same as vision GET :115) but reject NEW writes.

### B4 — default-backend decision split & pinned (fixes 030)
- resolveSidecarBackend(explicit) keeps today's contract: unset → openai, no auth argument (web-search-anthropic.test.ts:58 assertion unchanged).
- resolveVisionBackend keeps today's contract: unset → anthropic when OAuth credential exists.
- The "전역 플래그로 맞춘다" issue sentence is satisfied by both resolvers CONSUMING resolveSidecarAuth for credential presence (shared auth state), NOT by unifying their default preference. Changing dual-auth default preference is a user-facing behavior change #2188 never ordered → OUT OF SCOPE, recorded for a follow-up issue.
- L3 no longer touches src/vision/index.ts at all (removes the cross-surface smell).

### Corrections
- 001: isCodexAuthContextUsable is auth-context.ts:612.

