# 001 — Verdicts (evidence-backed)

| PR | Verdict | Core rationale |
|---|---|---|
| #67 cursor multi-account OAuth | CHERRY-PICK onto dev | Clean scope (+72/-19): JWT sub/email -> OAuthCredentials identity, GUI add-account poll accepts done:true (same-account re-login), store doc updated, tests included. No overlap with our commits. Base=preview but dev-compatible (oauth/cursor.ts, store.ts, gui/Providers.tsx untouched by us). |
| #69 docs unsafeAllowNativeLocalExec | CHERRY-PICK onto dev (manual conflict resolution) | Real doc gap fixed (flag placement providers.cursor + dashboard path + config reference section + registry note + parity test). Conflicts expected: docs-site providers.md L113 region (our ultra/grok edits) + parity test region. Content correct vs current code. |
| #70 config.toml bypass warning | REQUEST-CHANGES | Erdos: over-detects bypass (dormant [model_providers.*] tables and root profile flagged without effective-routing resolution, project-config-warnings.ts:51/71/89); trusted-project check missing trust_level (:55/:182); dashboard 5s polling scan I/O. Feature direction good; needs detector tightening + negative tests. |
| #73 cursor transport fixes | REQUEST-CHANGES | Heisenberg: predates de12fc8 refresh — discovery.ts conflicts (would resurrect stale grok/kimi/composer ids + glm-5.2 200k downgrade); isCursorBenignCancelError treats ANY NGHTTP2_CANCEL as benign (can mask real stream errors; expectedClose path exists); live prefix filter can false-activate sibling bases (*-1m). Core fixes (error mapping, 429 handling, auto->default, request-log metadata) are wanted after rebase. |
| #74 debug CLI/GUI | REQUEST-CHANGES | Kuhn: compile blocker (server/index.ts re-exports httpStatusForRequestLogTerminal/httpStatusFromTerminalError not exported by request-log.ts at PR head); Date.now() polling cursor loses same-ms log lines; /api/debug* sensitive surface lacks HTTP-level auth/CORS/redaction tests; CLI usage-logs tails local file instead of live proxy endpoint. |

Issues:
- #71 (guigeng, EN): v2.6.x behavior is INTENTIONAL — Design B injection (src/codex/inject.ts:95-105)
  points codex's built-in openai provider at the proxy via one root openai_base_url line instead of
  a [model_providers.opencodex] table, so threads keep native provider tags (history-safe; README
  "History-safe injection"). Old-style sections are migrated. Answer + ask if anything actually
  broke; not a bug on its face.
- #72 (22nsuk, KR): (1) resource_exhausted transport errors — real report, matches PR #73 scope;
  answer that a fix is in review. (2) effort mismatch by design: Codex advertises low/medium/high
  (CURSOR_REASONING_EFFORTS) and cursorEffortSuffix maps Codex TOP -> model TOP tier, so fable-5
  "높음" -> xhigh(매우 높음) suffix (src/adapters/cursor/effort-map.ts:19,55-60). Thinking toggle is
  Cursor-side representation. Explain + note we may widen advertised tiers as follow-up.

Landing order (WP2): #67 first (no conflicts), then #69 (manual doc conflict resolution), gates
after each; push dev; comment landings; close cherry-picked PRs with comment referencing the
landing commit. #70/#73/#74 comments only.

## A-phase fold-back (reviewer gpt-5.5 "Euclid", FAIL -> wording corrections, verdicts unchanged)
- #67: precise wording = "applies cleanly to dev (git apply --check exit 0); zero file
  intersection with our commits 08ecd31/de12fc8 (PR files: oauth/cursor.ts, oauth/store.ts,
  gui/Providers.tsx, tests) ; no preview-only dependency".
- #69: only tests/provider-registry-parity.test.ts:108 hunk mechanically fails against dev; docs +
  registry hunks apply with offsets. Landing = apply with 3way, fix parity hunk semantically
  (keep our >=38 + grok-4.5 assertions + add PR note assertions).
- Euclid verified #71/#72 reply facts (inject.ts:31,94,401,415; history-provider.ts:569;
  discovery.ts:10,136; effort-map.ts:19,61) and spot-checked all three REQUEST-CHANGES rationales.
- Landing refinement: #67 and #69 get gh pr merge into their preview base (keeps author credit,
  mergeable CLEAN) AND cherry-pick onto dev; REQUEST-CHANGES PRs get comments only.
