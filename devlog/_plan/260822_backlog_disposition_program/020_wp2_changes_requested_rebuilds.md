# 020 — WP2: changes-requested rebuilds

PRs whose intent is accepted but which carry unresolved reviewer blockers. Each is
either fixed forward on a `codex/` branch or closed with a recorded reason. None is
merged on the strength of author self-attestation alone.

## Inventory and recorded blockers

### #2310 — `fix(responses): repair apply_patch envelopes`
Head `1acf7343`, 940+/59-, 12 files. Review state CHANGES_REQUESTED.

Blocker history (from the review threads):
- CodeRabbit, `src/responses/custom-tool-compat.ts:222`, Major: `custom_tool_call.input`
  bypassed repair in JSON/SSE. **Author fixed in `134ec8b13`** — a separate exact
  wire-name authorization set for native passthrough custom tools; CodeRabbit
  acknowledged the fix resolves the reported bypass.
- CodeRabbit, `tests/responses-custom-tool-repair.test.ts:163`, Minor: missing regression
  where `repairNames` contains `apply_patch` but a `custom_tool_call` has no `name`;
  that payload must stay byte-identical.

Disposition: **REBUILD-LITE** — add the one missing regression, re-verify, merge. The
Major blocker is already closed; the residual is a single test.

### #2311 — `fix(grok): translate native edit tools for Codex`
Head `9fbfa19b`, **3348+/59-, 37 files**. Review state CHANGES_REQUESTED.

Open blockers:
- `src/adapters/grok-structured-edit.ts:206` Minor — `grokShellNeedsGitEscalation` misses
  `git -C <dir> add`: the flag group `(?:\s+-[^\s]+)*` consumes `-C` but then requires a
  subcommand where `/repo` sits, so escalation never fires and Codex fails to write
  `.git/index.lock`. Costs one wasted turn (the tool description tells the model to
  retry escalated) rather than breaking the operation.
- `src/adapters/grok-structured-edit.ts:260` Major — three near-duplicate helper pairs
  redefine the same activation predicate (`isCodexCodeModeExecTool`,
  `isBareShellBridgeTool`, `CODEX_SHELL_BRIDGE_TOOL_NAMES` duplicating
  `src/adapters/tool-catalog-nudge.ts:44-66`; `grokEditCodexSink` and
  `grokCodeModeExecSink` sharing nine of eleven lines). This predicate is the activation
  gate for the whole bridge — drift silently changes which turns convert.
- `src/adapters/grok-structured-edit.ts:1020` Major — greedy `('.+')` in the Windows grep
  reconstruction backtracks to the LAST quote in the emitted script, capturing the
  trailing `'{0}:{1}:{2}'` formatter and corrupting the restored `pattern`.

Disposition: at 3.3k lines across 37 files with three open correctness blockers on the
default Grok path, this does not merge in this unit on author attestation. Either the
blockers are closed and independently re-verified, or the PR is left open with the
blockers restated. **It is not closed** — the intent is sound and the work is
substantial.

### #2350 — `feat(adapters): annotate present-but-empty tool outputs (DeepSeek default)`
Head `b1b5b071`, 287+/4-, 8 files. `review-ready` label; unresolved CodeRabbit checkboxes.
CI: all five checks SUCCESS on re-query (the aggregate rollup reported a stale `label`
failure — see 002).

### #2351 — `feat(config): audit persisted config mutations`
Head `916fc9f2`, 845+/75-, 22 files.

Recorded blocker: at line 3272 a new save replaces the only pending marker even when
lines 2771-2773 replayed an older marker in the current uncommitted transaction. Crash
sequence: `config.json` at `C1` with marker `P1`; next save inserts the `P1` audit row,
overwrites `P1` with `P2`, then writes `C2`. If the `C2` write fails, the transaction
rolls back the `C1` audit row and the surviving `P2` hash does not match `C1`, so later
reconciliation drops it. This is a durability defect in an audit feature — the exact
class of defect the feature exists to prevent. Must be closed before merge.

### #2355 — `feat(status): warn when config.json diverges from the running proxy`
Head `29e8d7b2`, 427+/4-, 20 files. CI green on re-query.

## Accept criteria

Every PR in this phase ends in one of: merged with its blockers verifiably closed;
left open with the blockers restated in a review comment; or closed with a reason. No
PR in this phase merges while a Major correctness blocker is open.



---

# AMENDMENT (A-phase round 1, blocker B3) — the full changes-requested roster

The round-1 audit found this document dispositioned only #2310 and #2311 out of the 19
PRs in the changes-requested class (#2301 is handled in `070`). The remaining 16 existed
only as inventory rows in `000`, which is not a disposition. They are entered here.

## Dispositioned roster

| PR | State | Head | Size | Author | Disposition | Title |
|----|-------|------|------|--------|-------------|-------|
| #2299 | draft | `48326fc5` | 860+/3- (9f) | abhisheksharma2411 | REBUILD-CANDIDATE | feat(catalog): operator display labels for live-disc |
| #2298 | draft | `38888e3d` | 74+/0- (3f) | ppvia | REBUILD-CANDIDATE | fix(claude): warm empty Desktop-3P alias registry on |
| #2257 | draft | `510f1044` | 1289+/29- (20f) | yansigit | REBUILD-CANDIDATE | feat(agent): named subagent role catalog |
| #2244 | draft | `67acb331` | 913+/0- (9f) | ZSN12 | REBUILD-CANDIDATE | feat(workbuddy): add experimental desktop OAuth prov |
| #2215 | draft | `d85cf057` | 126+/41- (8f) | parkjs101 | REBUILD-CANDIDATE | docs(sub-agents): describe v2 fork override rule as  |
| #2123 | draft | `701b51f9` | 495+/32- (3f) | chilung-cgu | REBUILD-CANDIDATE | feat(quota): add per-account Gem/Cla quota probing f |
| #2122 | draft | `fd6e53de` | 607+/41- (15f) | chilung-cgu | REBUILD-CANDIDATE | feat(catalog): config-level retainModels allowlist f |
| #2113 | ready | `3e17fe58` | 2184+/112- (63f) | cb8010d6 | TRIAGE-RESTATE | feat(providers): allow trusted encrypted V2 task pas |
| #2071 | draft | `e365907b` | 2789+/124- (25f) | yansigit | TRIAGE-RESTATE | feat(antigravity): CCA host failover and non-retryab |
| #2070 | draft | `f276d325` | 1608+/76- (14f) | yansigit | TRIAGE-RESTATE | feat(antigravity): Claude CCA wire fidelity |
| #2068 | ready | `9dceb40f` | 954+/31- (7f) | yansigit | REBUILD-CANDIDATE | feat(antigravity): live quota RPC and geoblock class |
| #2050 | draft | `52324cef` | 528+/72- (46f) | x3M3x | REBUILD-CANDIDATE | feat(combos): add random, least-used, and reset-wind |
| #1905 | ready | `0be75f29` | 781+/80- (27f) | luvs01 | REBUILD-CANDIDATE | feat(codex): add per-model ChatGPT compaction budget |
| #1829 | ready | `bf5e67f9` | 2878+/2- (4f) | luvs01 | TRIAGE-RESTATE | feat(codex): add durable reset-credit operation ledg |
| #1769 | draft | `f87c4acb` | 963+/36- (19f) | dbc-hbin | REBUILD-CANDIDATE | feat(gui): add manual paste fallback for OAuth add-a |
| #1756 | ready | `e9a04d1e` | 850+/116- (17f) | takltc | REBUILD-CANDIDATE | feat(grok): inject per-model reasoning effort into G |

## Disposition rules for this roster

**REBUILD-CANDIDATE** (diff under ~1500 added lines): the blockers are read in full, and
the PR is either fixed forward and merged after verification, or left open with the
blockers restated in a review comment. Merging requires this unit's own verification —
never author self-attestation.

**TRIAGE-RESTATE** (#2113 2184+/63f, #2071 2789+/25f, #2070 1608+/14f): a diff of this
size with open reviewer blockers is not landable inside a backlog-clearing pass without
becoming its own review unit. Terminal disposition for this program: **left open with
blockers restated and the review burden named**. Recording that honestly is the
disposition; silently merging or silently closing would both be wrong.

## Why nothing here is closed for staleness

Every PR in this roster represents accepted intent with a reviewer objection attached.
Closing them would discard contributor work over process state rather than over evidence.
The terminal outcomes available are merge-after-verification, restate-and-leave-open, or
close-with-a-named-superseding-change — never close-because-old.

## Reconciliation

```
19 changes-requested  =  2 (#2310, #2311, body above)
                      +  1 (#2301, work-phase 7)
                      + 16 (this roster)
```

Combined with WP1 (8), WP7 (4, of which #2301 is counted above), and WP8 (15 conflicting
+ drafts + wrong-base), every one of the 45 open PRs now carries a named disposition
lane. WP8's C step performs the mechanical 45-item reconciliation before the goal closes.

