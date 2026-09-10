# wp1 — C-phase evidence

Unit: `260827_kiro_subagent_delegation_unblock` · work-phase `wp1` · C phase

## Static gates

| gate | result |
|---|---|
| `bun x tsc --noEmit` | exit 0 |
| `bun run test` | **15169 pass, 0 fail** across 951 files (119.30s), exit 0 |
| `bun test tests/kiro-adapter.test.ts` | 64 pass, 0 fail |
| `bun test tests/tool-catalog-nudge.test.ts` | 17 pass, 0 fail |

The full suite is the gate here, not the focused run: `src/AGENTS.md:26` requires
it for adapter behavior.

## Red-first transcript

The 6 new tests were run BEFORE the implementation. Two failed and four passed,
which is the correct split — the four that passed are the must-NOT-fire controls,
and a test that only ever passes proves nothing.

```text
(fail) names ALL_TOOLS when a freeform exec is advertised without a bare shell bridge
(pass) keeps the generic fallback for a STRUCTURED tool that merely shares the name exec
(pass) does not claim code mode when a bare shell bridge sits beside exec
(fail) decides on the EMITTED catalog: a budget-omitted shell bridge no longer suppresses code mode
(pass) does not name a code-mode exec that the catalog budget dropped
(pass) advertises no code mode for a tool_choice:none turn
 4 pass, 2 fail
```

The second failure is the reviewer's blocker-1 case reproduced as a test. Its
red output shows 48 of 49 tools emitted with `exec_command` omitted, `exec`
present, and the nudge still carrying the generic fallback:

```text
Expected to contain: "ALL_TOOLS"
Received: "[opencodex] Kiro's outbound catalog budget allows 48 of 49 client tools
this turn. Omitted and unavailable this turn: exec_command. ... If a listed tool
exposes nested helpers such as a tools.* API, ..."
```

After the fix all 6 pass.

## Activation grounding (C-ACTIVATION-GROUNDING-01)

The new branch is conditional, so "suite green" is not evidence on its own. Each
path was driven and observed:

| path | driven by | observed |
|---|---|---|
| fires | freeform `exec`, no bridge | nudge contains `ALL_TOOLS` + `Codex code mode`, generic fallback absent |
| must not fire — semantics | structured `exec` (no `freeform`) | generic fallback retained |
| must not fire — flat bridge | `exec` + `exec_command` both emitted | no `ALL_TOOLS` |
| fires despite omission | 49 tools, bridge dropped by budget | `ALL_TOOLS` present |
| must not fire — omitted exec | 48 fillers ahead of `exec` | `exec` absent from catalog, no `ALL_TOOLS` |
| must not fire — no catalog | `tool_choice: "none"` | no `ALL_TOOLS` |

## Live proof (the criterion that closes the unit)

Proxy restarted onto this branch (`ocx restart`, healthy PID 56020 port 10100,
kiro logged in). A fresh top-level `kiro/claude-opus-5` task was asked, in
Korean, whether it had any tool for delegating work to subagents. **The prompt
never mentioned `ALL_TOOLS`, `exec`, `spawn_agent`, or code mode.**

Reply (verbatim excerpt):

> 있습니다. 서브에이전트 파견용 도구는 multi_agent_v1__spawn_agent이고, 모델과
> 추론 강도 모두 지정할 수 있습니다. 참고로 이 도구들은 최상위 도구 목록에는 안
> 보이고, exec(코드 모드) 안에서 await tools.multi_agent_v1__spawn_agent({...})
> 형태로 호출하는 중첩 헬퍼로 노출돼 있습니다.

It then listed `model`, `reasoning_effort`, `service_tier`, and `fork_context`
with their inheritance semantics, plus the five advertised model overrides and
their effort ladders.

Baseline from the same model before the fix:

> No spawn/subagent tool exists in my current tool catalog.

That is the whole unit in two quotes. The reported symptom — "모델 지정, 에포트,
속도 지정을 못하는거 같아" — resolves not because those parameters changed, but
because the model can now find the tool that carries them.

## Residual

The nudge is truncated from the TAIL under injection-budget pressure and the
code-mode sentence sits late in it. Measured headroom today is ~10 KB of 16384
(`012`), so the risk is dormant. If `MAX_KIRO_TOOL_COUNT` or the nudge grows
materially, this sentence is the first thing cut — and the failure would be
silent, exactly like the one this unit just fixed.
