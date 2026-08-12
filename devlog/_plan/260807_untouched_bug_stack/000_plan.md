# 260807 — untouched-bug stack: research and roadmap

Base: `codex/260807-stack-base` at `origin/dev@6d04574d0`.
Cycle: docs-first. This unit writes the plan; no production code changes land here.

## Why this unit exists

A sweep over the 60 open issues and 24 open PRs found two distinct backlogs that
the merged bug campaign did not reach.

The first is a **CI admission backlog**. Eight bug-fix PRs were reported as
"never ran CI", which reads like contributor neglect but is not: 524 workflow
runs sat in `action_required`, waiting on maintainer approval. Thirty-nine of
them belonged to branches with an open PR. The readiness gate cannot verify the
`ci` check on a run that was never allowed to start, so those PRs could not
leave draft no matter what their authors did. Approving the open-PR subset is
the precondition for every disposition below; approving all 524 is not, because
most belong to branches already merged or abandoned.

The second is a set of **defects with no PR at all** — issues where a reporter
filed evidence and nothing was ever opened against it.

## Disposition summary

Every verdict below was reached by reading the diff and the current tree, not
the PR description.

| Target | Verdict | Reason |
|---|---|---|
| #557 npm cache preflight | rewrite | dev is 1,220 commits past the merge base; diff mixes the useful preflight with obsolete recovery machinery |
| #1095 DeepSeek progressive streaming | rewrite | 2,184-line diff carries an unsafe terminal-repair state machine and a raw-fragment race |
| #1155 web-search buffered policy | adopt with changes | correct intent; `parseResponse` misuse and a lease leak must be fixed |
| #1159 Cursor Grok wire prefix | adopt as-is | request-only helper, correctly isolated from discovery |
| #1171 A6API unlimited quota | adopt as-is | unlimited branch ordered before finite validation, focused coverage |
| #1163 combo catalog fallback | rewrite | resolver cannot distinguish missing rows from deliberately filtered ones |
| #1152 account picker selectors | adopt with changes | foundations are sound but the entry point has no production caller |
| #1169 codex-shim readiness warning | adopt with changes | advisory design is right; the probe can throw and fail a good install |
| #1131 in-place restart identity | rewrite | 35 files with unresolved lifecycle defects; CI red was a GitHub outage, not the code |
| #1056 desktop picker (#241) | rewrite | 54-file branch with backup poisoning and lost-alias defects |
| #1170 unspaced SSE frames | new fix | strict `"data: "` prefix in six parsers |
| #1100 routed reasoning effort | new fix | routed rows advertise ladders, then lose summary support |
| #1156 Windows ACL budget | new fix | a complete ACL sequence gets only five seconds |

## Two corrections to the initial triage

Recording these because both changed the plan.

**#1156 was described imprecisely.** The first pass said PR #1135's retry shares
the 5-second budget. It does not — owner-level recovery at
`src/codex/native-main-owner.ts:205-210` calls `hardenSecret` again and receives
a fresh deadline. The real defect is narrower and still real: one complete ACL
sequence (grant, inheritance, verify, with `/findsid` fallbacks) must finish
inside a single 5-second envelope. The fix is the envelope size, not the retry
structure.

**#1170 has six call sites, not one.** The reporter named the OpenAI Chat
adapter. The same strict prefix also sits in `src/chat/outbound.ts`,
`src/web-search/parse.ts`, `src/server/claude-messages.ts`, and — twice —
`src/claude/outbound.ts`, which contains two independent parsers (`:591-605`
and `:864-865`). The second one was missed on our first pass and found in audit.
Fixing only the reported site would leave five live paths broken.

## Roadmap

Implementation phases, one decade doc each, one PABCD cycle each:

- `010` — #1170 unspaced SSE field parsing (6 call sites, 2 shared primitives)
- `020` — #1100 routed reasoning-effort propagation
- `030` — #1156 Windows ACL harden envelope
- `040` — #557 replacement: npm cache preflight + log sanitization
- `050` — adopt-as-is PR replacements (#1159, #1171)
- `060` — adopt-with-changes PR replacements (#1155, #1152, #1169)

Rewrite-class targets (#1095, #1163, #1131, #1056) are deliberately not in this
roadmap. Each is a full unit of work with its own defect list, and folding four
rewrites into this stack would produce a chain no reviewer can follow. They are
recorded here so the next unit can pick them up with the audit already done.

## Stack shape

Sequential stacked PRs. Each targets `dev` or the previous PR's head branch, per
the stacked-child workflow that `enforce-target` already supports.

`010` and `020` and `030` touch disjoint production files, so their order is a
review convenience rather than a dependency. `040` is independent of all three.
`050` and `060` follow because they replace existing PRs and their originals
must be closed with a pointer to the replacement.

One real overlap: `040` and `060` both edit lifecycle locale files. Whichever
lands first, the other rebases.

## Review gates beyond CI

`MAINTAINERS.md` requires explicit security review for credential/permission
handling and for the dependency-install path. Two phases are in that class and
cannot go ready on green CI alone:

- `030` — Windows ACL permission handling
- `040` — npm install path plus log sanitization

Both run `bun run privacy:scan` and request security review before leaving
draft.

## Out of scope

No promotion to `main` or `preview`, no npm publish, no release tag, and no
merge. Merging is a separate authorization; this unit stops at open PRs with
green CI.

## Audit record

This plan failed its first independent audit with six blockers, all corrected
in place:

1. `010` missed a second parser in `src/claude/outbound.ts` and did not address
   CRLF framing or multiline `data` joining.
2. `020` did not specify Record merge semantics; a whole-Record fill-if-undefined
   would let one user override suppress every registry default.
3. `030` claimed a ~60s worst case; the real load-time bound is ~90s because
   `loadConfig()` hardens three paths sequentially (`src/config.ts:1759-1764`).
4. `040` cited `src/update/job.ts:269-280` as the launcher invocation; that
   builds the command, and the invocation is at `:1469`.
5. `060` proposed wiring into a picker-enable transaction that does not exist.
6. Security-review gates for `030` and `040` were missing.

Recording this because the corrections changed what gets built, not just how it
is described.
