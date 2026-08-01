# 030 — V2 gate + hardening pass (effortCapAppliesTo)

## Loop-spec

- Archetype: hardening/consistency pass over shipped commits `5799c3be` (caps + ladder
  resolution) and `cec073b8` (v2 gating + Dashboard exposure). Class C2.
- Goal: adversarial audit of the gate semantics against codex-rs reality, fold blockers,
  close named test gaps, sync docs (3 locales) to shipped semantics, record evidence.
- Non-goals: new cap features, provider adapters, upstream codex-rs changes, npm release.
- Verifier: `bun test` 0 fail; `bunx tsc --noEmit` exit 0; docs rows match code.

## Gate design (as shipped, post-hardening commit 84319e66)

`effortCapAppliesTo(surface, headers, config, compaction)` — the single admission
check in `handleResponses` before `applyEffortCap`:

1. `compaction === true` -> **false**. Compaction is maintenance, not an agent turn.
   Native `/v1/responses/compact` is forwarded directly and never enters
   `handleResponses`; routed compaction synthesizes an internal request that does.
   Without the bypass, routed child compaction got lowered while native compaction
   was untouched (provider-dependent semantics — audit blocker 3).
2. `multiAgentMode === "v1"` -> **false**. Kill-switch; mirrors the Dashboard hiding
   the panel. Server + management API share the mutable startup config object, so a
   runtime PUT takes effect without restart.
3. `surface === "v2"` -> **true**. Main turns qualify by their own tool list carrying
   the flat V2 collab surface (`collabSurface`).
4. `isThreadSpawnRequest(headers)` -> **true**, REGARDLESS of tool surface. Children
   below the spawn-depth limit retain collab tools while depth-limited leaves carry
   none (codex-rs `spec_plan.rs` leaf guard), so the earlier `surface === null &&`
   conjunction capped siblings inconsistently by depth (audit blocker 1).
5. Otherwise **false**: plain main turns and V1-surface main turns stay untouched.

`isThreadSpawnRequest` matches spawned-child markers EXACTLY: header
`x-openai-subagent: collab_spawn` or `"subagent_kind": "thread_spawn"` inside the
`x-codex-turn-metadata` JSON. Upstream emits `x-openai-subagent` for review, compact,
memory-consolidation, and arbitrary "other" turns too (`responses_metadata.rs`), so
the old any-nonempty-value check let maintenance turns trip `subagentEffortCap`
(audit blocker 2). WS parity holds: both headers sit in the FORWARD_HEADERS allowlist
and the WS bridge copies them into the rebuilt internal request.

## Audit evidence (WP1)

- Reviewer: sol (gpt-5.6-sol) adversarial audit. Verdict: **GO-WITH-FIXES (blockers=3)**,
  all Med — (1) surface-dependent child admission, (2) over-broad `isSubagentRequest`,
  (3) compaction cap asymmetry. All three folded in commit `84319e66` plus the
  audit-named test gaps (non-spawn subagent kinds, v1-surface+child-header, forced-v2
  edges, malformed metadata, compaction bypass) in `tests/effort-policy.test.ts`.
- Residual notes confirmed (no action): GUI `maMode !== "v1"` gate matches server
  semantics; ~5s polling staleness acceptable; default mode admits v2-pinned surfaces.
- Verification: `bun test` full suite **2079 pass / 0 fail** (8686 expects, 201 files);
  `bunx tsc --noEmit` clean.
- Failure attribution: `install-scripts > Node can import the package main without
  executing the CLI` failed identically at baseline `755fac5f` (worktree run: 6 pass /
  1 fail) -> pre-existing, environment-dependent (passes with node on PATH), not
  introduced by the cap commits.

## Docs sync (WP2)

`docs-site/src/content/docs/{,ko/,zh-cn/}reference/configuration.md` — the
`effortCap`/`subagentEffortCap` rows previously said the cap applies to "every
proxied turn"; rewritten to the shipped V2-only semantics above (exact markers,
surface-agnostic child admission, compaction bypass, v1 kill-switch + hidden panel).
Snap-down/strip/ultra-conversion tail text unchanged.

## GUI render grounding (WP3)

Fresh sandboxed server from this worktree (OPENCODEX_HOME + CODEX_HOME pointed at
temp dirs so `start` cannot inject routing into the real `~/.codex`) on port 10199
with `effortCap: "high"`, `subagentEffortCap: "medium"`; driven via the in-app
browser against the built `gui/dist`. Screenshots in `assets/`:

- `1_v2_panel_visible.png` — base mode: "V2 ultra effort limit" panel renders with
  both selects hydrated from `GET /api/effort-caps` (`high` / `medium`).
- `2_v2_panel_help_popup.png` — help popup (aria-haspopup dialog) open; copy explains
  the ultra->max cap, spawned-child-only sub-agent limit, only-lowers, and snap-down.
- `3_v1_panel_hidden.png` — after clicking the `v1` mode radio, the panel is gone
  (label locator count 0) and the server confirms `multiAgentMode: "v1"` via
  `GET /api/v2` — GUI gate and server kill-switch agree.

Caveat noted during capture: `bun run src/cli/index.ts start` WITHOUT a sandboxed
CODEX_HOME rewrites the real `~/.codex/config.toml` `openai_base_url` to the dev
port and can leave it stale if the process dies before cleanup (restored to 10100
by hand this session). Always sandbox both env vars for render checks.
