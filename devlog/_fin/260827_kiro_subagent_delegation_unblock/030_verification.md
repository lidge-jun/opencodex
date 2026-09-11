# wp3 — live verification that a Kiro parent delegates in parallel

Unit: `260827_kiro_subagent_delegation_unblock` · work-phase `wp3`

A green unit test proves the adapter emits the right bytes. It does not prove a
Kiro model *acts* on them. This unit's whole failure mode was a capability that
existed and went unused, so the exit gate is behavioral.

## What does not count as proof

- `bun test tests/kiro-adapter.test.ts` green — necessary, not sufficient.
- The model reciting `ALL_TOOLS` contents when told to look there. That is the
  forced probe that already passed *before* any fix; it proves registration,
  not discovery.
- `ocx v2 status` showing a raised depth — proves config, not behavior.
- A spawn attempt that errors. A refused spawn is not a completed delegation.

## Probe ladder

Each rung must pass before the next is meaningful.

### 1. Unprompted discovery (proves wp1)

Fresh top-level `kiro/claude-opus-5` task. Ask what tools are available for
delegating work. **Do not mention `ALL_TOOLS` or `exec`.**

Pass: it names `multi_agent_v1__spawn_agent` on its own.
Baseline to beat: *"No spawn/subagent tool exists in my current tool catalog."*

### 2. Single spawn with explicit overrides

Ask it to spawn one child with an explicit `model` and `reasoning_effort`.

Pass: `spawn_agent` returns an `agent_id`, and the child reports the requested
model and effort — not the inherited parent values. This is the rung that
closes the original report ("모델 지정, 에포트, 속도 지정을 못하는거 같아").

### 3. Parallel width

Ask for three independent children in one round, then `wait_agent` on all three.

Pass: three distinct `agent_id`s, overlapping lifetimes, all reaching a final
status. Sequential completion means width is still serialized somewhere and the
parallel claim is unproven.

### 4. Depth (proves wp2)

Instruct a spawned child to spawn a grandchild.

Pass: the grandchild completes and returns through the chain. Baseline: at
depth 1 the child has no spawn tool at all — the exact `Nash` result from
triage.

## Evidence to capture per rung

Record verbatim, not paraphrased:

- the `agent_id` values returned,
- each child's self-reported model and effort,
- `ocx observe logs` rows showing the Kiro upstream calls,
- for rung 3, the wall-clock overlap.

## Rollback trigger

*(Rewritten after audit round 1, blocker 3: wp1 is now nudge activation, not
preserve-tail truncation.)*

Revert wp1 if enabling the code-mode nudge for Kiro produces a Kiro
`ValidationException`, a 400, or a measurable behavior regression on any Kiro
model family. The change only swaps one sentence of injected system text for a
longer one, so the plausible failure is size or wording interaction, not schema
rejection — but the cap history says treat Kiro payload changes as guilty until
proven green.

Do NOT respond to such a failure by raising
`MAX_KIRO_TOOL_DESCRIPTION_UNVERIFIED` or by moving tool docs into the prompt.
Both are owner-confirmed out of bounds; a failure here means the unit returns to
P, not that the constraints bend.

Revert wp2 if unbounded depth produces a tree that does not terminate or
exhausts Kiro quota without a clean refusal.

## Unit closure

All four rungs pass, evidence recorded here, then move the unit directory to
`devlog/_fin/`. Per `AGENTS.md`, a `_fin` unit records work already visible in
public git history, so closure follows the shipped fix rather than preceding it.
