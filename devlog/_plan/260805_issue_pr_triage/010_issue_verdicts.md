# 010 — WP2: bug-class issue verdicts

> **Status: EXECUTED.** Written in WP1 as the phase spec; the `# Verdicts
> (executed)` section at the bottom is WP2's output. Sections above it are the
> spec as it stood when WP2 ran, kept for auditability. A later cycle re-reading
> this document should treat the spec as historical and the verdict table as the
> current state.

## What this phase must produce

One row per bug-class issue, in one table, with a disposition from the fixed
vocabulary in `000_plan.md`, an evidence anchor, and a prior-art pointer.

## Lane split (from `001`)

Lanes are defined by what evidence the item still needs, which is the only thing
that changes the work.

### Lane A — no prior investigation (8 items)

These have never been looked at in devlog. Each needs a real structural read of
the code path at `8949c4940`.

| Issue | Question the lane must answer |
|---:|---|
| #1061 | Does the macOS native-profile process-exit phase test actually hang, and is the failure in the test's own teardown or in the runtime? |
| #1059 | What is the shape of the ~207 Windows failures — one root cause or many? Is the leg genuinely dispatch-only today? |
| #1057 | What ladder does the DeepSeek adapter send now, and where is the mapping table? |
| #1046 | Does service restart rewrite the Codex catalog without draining stale app-servers? Name the write path. |
| #1045 | Is the drain-timer assertion comparing a duration against an absolute deadline? Quote the assertion. |
| #1043 | Where does the image-part filter live, and why do text-only zen models still receive `image_url`? |
| #1024 | Which probe surfaces regressed post-#956, and are the controls really deterministic? |
| #1017 | What exactly does the Cursor adapter emit instead of a valid `apply_patch` payload? |

Expected evidence per row: `path:line` for the responsible code, plus either a
reproduction command or an explicit statement that reproduction needs a
credential/platform this session lacks.

### Lane B — drift candidates (2 items)

| Issue | Claim to test | Command |
|---:|---|---|
| #904 | `eeef7a32a` is on `dev` and fixes surrogate boundaries | `git merge-base --is-ancestor eeef7a32a origin/dev` + read the test |
| #796 | `d3abf4345` + regression test are on `dev` | same, plus `tests/volcengine-ark-assistant-content.test.ts` existence |

If ancestry holds and the issue stays open only for reporter evidence, the
disposition is `needs-reporter-info`, and the row states precisely which capture
would close it.

### Lane C — exhausted tail (carry-forward), 7 items

#418, #417, #241, #92, #994, #919, #540. Each row carries the existing verdict
forward with its anchor and adds one line: what new evidence would change it. No
re-derivation.

#1048 and #1049 are **not** in this lane and not in this unit's scope. They are
maintainer-filed work items of `devlog/_fin/260804_codex_write_substrate/`, not
defect reports; `002` accounts for them separately.

## Exact item ledger (17 rows, no more, no fewer)

```
Lane A (8): 1061 1059 1057 1046 1045 1043 1024 1017
Lane B (2): 904 796
Lane C (7): 994 919 540 418 417 241 92
```

`#1048` and `#1049` are deliberately absent: they are work items of
`devlog/_fin/260804_codex_write_substrate/`, not defects (see `002`).

## Self-modification map

| File | Action | Content |
|------|--------|---------|
| `010_issue_verdicts.md` | MODIFY (done) | appended `# Verdicts (executed)` with the 17-row table |
| any other file | — | none; this phase writes only to this document |

## Executable commands

Lane B ancestry, run verbatim:

```bash
cd /Users/jun/Developer/new/700_projects/opencodex
for sha in eeef7a32a d3abf4345; do
  git merge-base --is-ancestor $sha origin/dev && echo "$sha ANCESTOR" || echo "$sha NOT_ANCESTOR"
done
ls tests/volcengine-ark-assistant-content.test.ts
```

Lane A dispatch: two read-only explorer packets, slices
`{1043,1017,1057,1024}` and `{1061,1059,1046,1045}`, each returning the
`verdict/code/why/test/repro` block defined below. Write access: none.

Lane C: no new investigation. Each row copies its anchor from `001` and adds the
one line naming what evidence would move it.

## Return block shape (per Lane A item)

```
### #<n>
verdict: real-open-defect | already-fixed-on-dev | needs-reporter-info | cannot-determine
code: <path:line> (1-3 anchors)
why: <2-4 sentences>
test: <path:line or "none found">
repro: <command, or "needs <credential/platform>">
```

## Table format (mandatory columns)

```
| issue | disposition | evidence anchor | prior art | what would change it |
```

## Accept criteria

- Exactly 17 rows matching the ledger above, no duplicates, no omissions.
- Every `already-fixed-on-dev` row carries `git merge-base --is-ancestor` output.
- Every Lane A row carries a `path:line` anchor or an explicit `UNVERIFIED` reason.
- No row asserts a fix without ancestry.

---

# Verdicts (executed)

Two read-only `gpt-5.6-sol` explorer lanes covered Lane A; Lane B ancestry was
run in the main session; Lane C carries forward from `001`.

| issue | disposition | evidence anchor | prior art | what would change it |
|---:|---|---|---|---|
| #1061 | real-open-defect | `tests/native-profile-crash-boundaries.test.ts:182-197`; child at `tests/helpers/native-profile-startup-child.ts:71-84` | none | a macOS release-train run with the teardown bounded |
| #1059 | real-open-defect | `.github/workflows/ci.yml:371-400` (dispatch-only at 387-392); failures span `tests/api-keys-routes.test.ts:147-164`, `tests/codex-write-lock.test.ts:413-429`, `tests/codex-catalog-sync-hardening.test.ts:102-115`, `tests/codex-catalog-writer.test.ts:110-130`, `tests/codex-transition-state.test.ts:317-329` | none | a Windows runner; the "~207" figure is not recoverable from the aborted run |
| #1057 | real-open-defect | `src/providers/registry.ts:349,353,1185` | none | none needed — the constants contradict the official ladder today |
| #1046 | real-open-defect | `src/codex/catalog/sync.ts:861-868`; `src/codex/desired-state.ts:148-160`; `src/cli/index.ts:200-204,319-320` | none | none needed — startup never calls `afterCatalogWriteHandleAppServers()` |
| #1045 | already-fixed-on-dev | `4177345021` is an ancestor of `origin/dev` (exit 0); `tests/system-restart.test.ts:330-343` injects a fixed `now` | none | nothing; `bun test tests/system-restart.test.ts` → 24 pass, 0 fail |
| #1043 | real-open-defect | `src/providers/registry.ts:1652`; `src/vision/index.ts:202`; `src/server/responses/core.ts:1689` | none | none needed — reproduced credential-free at `8949c4940` |
| #1024 | real-open-defect (partially fixed) | NVIDIA member fixed by `f557f9173` (ancestor, exit 0); `opencode-zen` still unclassified at `src/providers/registry.ts:1652` | none | reporter's `TR` provider config; `TR` is not a built-in registry provider |
| #1017 | needs-reporter-info (**UNVERIFIED**) | `src/responses/parser.ts:166-174`; `src/adapters/cursor/tool-definitions.ts:167-169,473-486`; `src/bridge.ts:203-207` | none | a captured malformed wire payload, or a regression test showing adapter-side corruption |
| #904 | needs-reporter-info | `eeef7a32a` ANCESTOR of `origin/dev` — "fix: never split surrogate pairs at the compaction and kiro boundaries" (2026-08-03) | `260805_bug_stack_campaign/130_dispositions.md:19` | the reporter's original failing capture |
| #796 | needs-reporter-info | `d3abf4345` ANCESTOR — "fix(providers): give Volcengine Ark non-empty assistant text on tool turns (#796)" (2026-07-31); `tests/volcengine-ark-assistant-content.test.ts` exists | `260805_bug_stack_campaign/130_dispositions.md:20` | a live Volcengine Ark credential |
| #994 | needs-reporter-info | `src/providers/registry.ts:918-958,1637-1655` | `260805_bug_stack_campaign/130_dispositions.md:18` | reporter's provider/model + wire capture |
| #919 | out-of-scope (consumed elsewhere) | — | `260804_router_intelligence/000_master_plan.md:87` — "Now embodied by #922/#966; we consume, not implement." | a decision to implement it here rather than consume |
| #540 | out-of-scope (feature) | — | `260805_bug_stack_campaign/001_issue_triage.md:39` | a maintainer decision to schedule the provider |
| #418 | needs-reporter-info | `src/server/responses/collaboration.ts:243-304` | `260805_bug_stack_campaign/130_dispositions.md:21` | reporter's current trace on a current build |
| #417 | out-of-scope (upstream) | — | `260805_bug_stack_campaign/001_issue_triage.md:39` | an upstream fix; tracking only |
| #241 | out-of-scope (upstream) | — | `260805_bug_stack_campaign/001_issue_triage.md:39` | the Desktop client's allowlist; no proxy-side change reaches it |
| #92 | out-of-scope (upstream) | — | `260805_bug_stack_campaign/001_issue_triage.md:39` | an upstream V2 protocol fix |

## What the lanes actually found

**Of the eight new issues: six are real defects, one is already fixed, one is
reporter-blocked.** #1045 was fixed by `4177345021`, which made the drain-timer
assertion deterministic by injecting a fixed `now`; the suite passes 24/24 today
and the issue can be closed. #1017 was over-called by its lane and is downgraded
below. The six that survive scrutiny are #1061, #1059, #1057, #1046, #1043, and
#1024.

**#1024 is half-fixed, and the half that remains is not the half the title
names.** The NVIDIA member (`nemotron-3-ultra-550b-a55b`) is in the sidecar list
via `f557f9173`. What is still open is `opencode-zen`, which has no vision
classification for either free zen model — the same root cause as #1043. Those two
issues are one defect wearing two titles, which `030` has to resolve.

**#1017 was over-called and is corrected here.** The lane returned
`real-open-defect`, and the audit gate was right to reject it. The anchors prove
the adapter *advertises* `apply_patch` as a structured `{input:string}` tool with
explicit patch-envelope instructions and unwraps that input verbatim
(`src/bridge.ts:203-207`) — which establishes that the boundary exists, not that
the adapter corrupts a valid payload. The issue's own claim is that
Cursor-trained models cannot *emit* the freeform grammar; proving that needs the
reporter's malformed capture or a regression test that drives the path. Six of
the eight Lane A items survived scrutiny; this one did not, and recording the
downgrade is worth more than a table that reads uniformly confident.

**#1059's headline number does not survive contact with the log.** The reported
"~207 failures" cannot be recovered from the cited run: the lane counted 113
explicit failures (30 + 41 + 35 + 7) before shard 4 hit a Bun internal panic that
aborted the count. The failures are also not one root cause — they fall into five
distinct families (server teardown, cross-process locking, catalog mutation,
atomic-write behavior, a CPU-heavy Unicode scan). Treating this as a single fix is
the mistake the issue invites.

**#1061's hang is in the harness, not the runtime.** The child can stall at
`server.stop(true)`, but the 30-minute CI hang comes from the test awaiting
`restart.exited` with no deadline and no kill fallback
(`tests/native-profile-crash-boundaries.test.ts:194-197`). There is a second,
separate defect in the same test: `waitFor()` proves only file existence before
line 183 parses it, so a partially-written JSON yields `Unexpected EOF`.

**Both drift candidates resolve cleanly.** `eeef7a32a` (#904) and `d3abf4345`
(#796) are genuine ancestors of `origin/dev`. Neither devlog note was wrong: both
issues stay open for reporter evidence, not for missing code.
