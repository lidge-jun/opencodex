# 010 — Phase 2: bounded translated-SSE inspection (#1112, PR #1114)

Credit: **ingwannu** (`Ingwannu <email from PR head>`), PR #1114.
Adoption: near-verbatim cherry-pick.

## Defect

`trackSseForRequestLog` retains an unterminated translated-path frame
indefinitely and reparses each complete payload through three separate string
helpers (`src/server/relay.ts:373`). `relaySseWithHeartbeat` repeats the same
unbounded partial-frame state (`src/server/relay.ts:539`). 64 MiB of
delimiterless upstream bytes therefore pin memory and triple parse cost.

`createSseInspector` already implements the correct behavior: cap one candidate
frame, discard only the oversized frame from *inspection*, resynchronize at the
next SSE delimiter, and leave downstream bytes byte-for-byte untouched.

## Change

Source commit `73706d3b2` (single commit, clean tree):

| Path | Op | Content |
|------|----|---------|
| `src/server/relay.ts` | MODIFY | Replace both string-retaining scanners with `createSseInspector`; parse each complete payload once and share the parsed object across the request-log, first-output, and terminal observers (−44/+16) |
| `tests/sse-inspector-bounds.test.ts` | MODIFY | +65 lines: over-cap delimiterless input, recovery at the next valid frame, parse-count assertion, byte-for-byte output preservation |
| `structure/04_transports-and-sidecars.md` | MODIFY | +5 lines recording the bounded-inspection invariant |

No behavior change for well-formed streams: the relay's output bytes are
asserted identical.

## Execution

```
git checkout -b codex/260806-stack01-bounded-sse origin/dev
git cherry-pick 73706d3b2
```

The cherry-pick preserves `Ingwannu` as commit author. Amend the message to add
the source citation and `Closes #1112`; authorship stays with the contributor,
so no `Co-authored-by:` trailer is needed for a verbatim pick.

## Verification

- `bun test tests/sse-inspector-bounds.test.ts tests/relay-eager.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`

## PR

Stack 01, base `dev`. Body cites #1112, credits ingwannu, and states that #1114
remains open for them to see the landing.
