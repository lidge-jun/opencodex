# PR #89 / #90 integration — per-claim verdicts (260711)

Loop: cxc-loop HOTL, goalplan `resolve-opencodex-prs-89-and-90-end-to-end-on-de`.
Both PRs targeted `main` (37f97e34); integration branch is `dev`. Strategy for both:
retarget base to `dev` + squash-merge (author credit preserved, no `main` release
history pulled into `dev`, no duplicate cherry-pick commits).

## PR #90 — strip hosted image_generation conflicting with declared image_gen tool (kargnas)

Reviewer (fork-context subagent McClintock), 6/6 PASS, 0 blockers:

1. Root cause PASS — `normalizeRoutedCatalogEntry` (src/codex/catalog.ts:488) deletes
   `tool_mode` on routed entries while native sol slugs run `code_mode_only`, so the
   dot-named `image_gen.imagegen` function reaches the wire on keyed routed requests
   and collides with hosted `image_generation` on platform /v1/responses.
2. Drift PASS — applies conflict-free onto dev (verified by actual cherry-pick, then
   dropped in favor of the squash merge).
3. Placement PASS — keyed else-branch after stripPreviousResponseId; stringify-time
   filters (stripUnsupportedHostedTools etc.) independent; no ordering hazard.
4. Interactions PASS — /v1/images relay never reads body tools[]; vision sidecar is
   input-side. Nothing depends on the hosted entry surviving for keyed providers.
5. Edges PASS — multiple hosted entries all dropped; non-object entries kept;
   no-conflict returns original reference. Benign untested quirk: custom-typed tool
   named `image_gen.*` also triggers the strip (matches platform semantics).
6. Test hygiene PASS — ran on dev: 14 pass 0 fail.

Integration: squash-merged as `8910e548`. Gates: bun test ./tests/ 2062 pass 0 fail,
tsc clean. PR comment: issuecomment-4940154321.

## PR #89 — /v1/alpha/search relay (SJY051)

Reviewer (fork-context subagent Goodall), 8/9 PASS, 1 should-fix FAIL, 0 hard blockers:

1. Drift PASS — real merge onto dev conflict-free; route lands between /v1/images and
   /v1/responses; 404-guard comment hunk applies.
2. Timeout FAIL (fixed here) — search.ts used `config.connectTimeoutMs ?? 200_000` as
   the TOTAL deadline. connectTimeoutMs is documented as the DNS/TCP/TLS/header-arrival
   budget (docs configuration.md:32); alpha/search is non-streaming, so headers arrive
   only at completion and a 10s connect budget kills every long search. Fix: dedicated
   `config.search.timeoutMs` (default 200s) mirroring `OcxImagesConfig.timeoutMs`;
   504 test moved to the new knob; added regression test proving a short
   connectTimeoutMs no longer cuts a slow search.
3. Provider selection PASS — first-enabled-forward scan matches the images relay
   pattern; startServer auto-upserts the chatgpt forward entry. (Possible future
   refactor: shared helper; out of scope.)
4. Auth parity PASS — route block mirrors the images block gate-for-gate.
5. Auth-context reuse PASS — helper signatures match dev; admission-secret strip
   identical to images.ts.
6. Buffering PASS — arrayBuffer-then-cap is the images precedent (16MB conservative).
7. Sidecar tracker PASS — label is a free-form crash-guard breadcrumb.
8. Header forwarding PASS — headersForCodexAuthContext builds from the FORWARD_HEADERS
   allowlist only; no host/cookie/content-length leakage.
9. Tests PASS — 54 pass 0 fail on the merged tree (server-search + server-auth).

Integration: squash-merged as `a971442f` + follow-up timeout-semantics fix commit
(this change). Docs note: `images.timeoutMs` is also undocumented in configuration.md,
so the new `search.timeoutMs` stays code-documented (types.ts JSDoc) for consistency.

## Related in the same loop

WP1 landed the pending v2 effort-cap gating as `cec073b8`, including an audit-found
fix: the surface-only gate skipped child turns (which carry no collab tools), so
`subagentEffortCap` never fired on its targets; `effortCapAppliesTo` now admits
header-marked child turns and multiAgentMode "v1" disables caps entirely.
