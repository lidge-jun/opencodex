# wp2 — C-phase evidence

Unit: `260827_kiro_subagent_delegation_unblock` · work-phase `wp2` · C phase

## Static gates

| gate | result |
|---|---|
| `bun x tsc --noEmit` | exit 0 |
| `bun run test` | **exit 0**, `Ran 15185 tests across 951 files` (124.51s) |
| `bun test tests/kiro-adapter.test.ts` | 68 pass, 0 fail |

Test count moved 15181 -> 15185: the four new wp2 cases. No test was deleted;
the wp1 omission test was re-pointed to a structured `exec` fixture.

## Red-first transcript

All four new tests failed before the implementation — `0 pass, 4 fail`. The byte
budget case is the clearest, emitting eleven heavy tools and no execution path:

```text
expect(names).toContain("exec")
Expected to contain: "exec"
Received: [ "heavy_000", "heavy_001", ... "heavy_010" ]
(fail) a byte-budget catalog still reserves room for exec
```

After the change all four pass and the file totals 68/0.

## What each test pins

| test | invariant |
|---|---|
| last-declared exec survives an over-budget catalog | the basic wp2 claim |
| reserving exec costs exactly one loaded tool | the reservation tradeoff is bounded at ONE, and the notice names the displaced tool |
| emits loaded -> exec -> gateway order | the comparator actually ran (fixture is over-budget and declared adversarially: gateway first, loaded last) |
| a byte-budget catalog still reserves room | exec is PROJECTED into the byte check, not subtracted |
| (re-pointed) structured exec is dropped and not named | wp1's invariant, on a tier-3 fixture |

## Reviewer-flagged traps, and what the code does

Three defects were predicted at audit before any code existed. Each is closed by
construction rather than by a passing assertion alone:

1. **Byte subtraction would be wrong.** `serializedToolCatalogBytes` measures
   `JSON.stringify` of the whole array, so a standalone size misjudges the
   separators. The loop measures `[...filled, entry.converted, reserved.converted]`.
2. **`candidates.slice(omittedAt)` would report a ghost omission.** With a
   reserved entry admitted after the break point, the suffix contains a tool that
   IS on the wire — the notice would have said `exec` was unavailable and counted
   50 of 49. Omissions are now a set difference.
3. **A post-loop push would land `exec` last.** Emitted order is rebuilt by
   filtering the sorted `candidates`, preserving loaded -> exec -> gateway -> filler.

## Interaction with #2475

`tests/kiro-adapter.test.ts:736-770` passes untouched. Reservation can displace
one loaded tool, and the new test asserts exactly that bound: 48 loaded tools
plus an `exec` emits 47 loaded tools, `exec`, and an omission notice naming
`loaded_047`.

That tradeoff is the honest reading of #2475, which prioritizes loaded results
*within* a bounded catalog rather than promising an unbounded number of them. The
alternative — keeping all 48 and dropping `exec` — optimizes the count while
making every one of those 48 tools uncallable.

## Live end-to-end proof (wp1 + wp2 together)

Proxy restarted onto both commits (healthy, PID 74847, port 10100). A fresh
top-level `kiro/claude-opus-5` task was asked to delegate two subtasks in
parallel, each spawned with `model: gpt-5.6-luna` and `reasoning_effort: low`.

It did the whole thing. Verbatim excerpts:

> 파견에 사용한 도구 이름: multi_agent_v1__spawn_agent ... 다만 이 도구는 상위
> 툴 카탈로그에 노출되지 않고 exec 코드 모드 안에서
> `await tools.multi_agent_v1__spawn_agent({...})` 형태로만 호출됩니다. 그래서
> 처음에 ALL_TOOLS를 뒤져 스키마를 확인한 뒤 파견했습니다.

That sentence is the unit's thesis, stated back by the model that could not do
it this morning: it found `ALL_TOOLS`, read the schema, and spawned.

Returned agent ids `01a042b0-1011-...` (17) and `01a042b0-10a6-...` (21), with
correct answers from both. The whole loop — spawn, wait, collect, close — ran
inside `exec`.

### The model out-verified my own acceptance criterion

Asked whether the overrides took effect, the children self-reported
`claude-opus-5, effort unspecified`. The parent refused that answer, went to the
rollout files, and found:

```text
"model":"kiro/claude-opus-5"   <- the PARENT's model, in the identity prompt
"model":"gpt-5.6-luna"        <- the child's actual turn context
"effort":"low"
```

Its conclusion, which is now recorded doctrine for this unit:

> 서브에이전트에게 "네 모델이 뭐냐"고 물어서 오버라이드를 검증하려는 접근은
> 이번처럼 항상 틀린 답을 줍니다. 검증이 필요하면
> `~/.codex/sessions/`의 해당 롤아웃 `.jsonl`을 보는 쪽이 확실합니다.

This matters beyond a nice anecdote. The goal's stated acceptance evidence was
"the child reports the requested model and effort" — which, as measured here,
is an unreliable oracle: a child reads its identity prompt, not its runtime
config. The criterion is hereby superseded by the rollout-file check.

A third agent appeared because a `wait_agent` call used `target` instead of
`targets`; the parent misread the resulting error as a spawn failure and retried.
The spawns had succeeded. All three were closed. Noted for honesty — it is a
harness-schema stumble, not a defect in this unit.
