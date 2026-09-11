---
title: Cycle summary
unit: 260910_cursor_acp_bridge
date: 2026-09-10
status: closed
---

# 060 -- Done

Written for someone who was not in the loop.

## The question and the answer

**Can the Cursor ACP integration built in `cli-jaw` be attached to OpenCodex?**

Mechanically yes; as a provider, no. `ProviderAdapter.runTurn`
(`src/adapters/base.ts:24-79`) is a supported non-HTTP seam,
`src/adapters/coding-agent/` is a working precedent for spawning a vendor CLI,
and the ACP spec is Apache-2.0 with an official TypeScript SDK. Wiring it up
would be a small job.

It should not be a provider, because `ProviderAdapter` is a **model** port and
ACP delivers an **agent**. Cursor-the-model is already integrated over HTTP;
Cursor-the-agent is a different product. Detail and options in
[040](./040_feasibility_verdict.md).

## What is worth knowing even if you skip the rest

**The repository has a stale ACP finding.**
`devlog/_plan/800_agent-fabric/110_protocol_boundaries.md` defers ACP to FAB-08
on the grounds that "ACP merged into A2A". That is IBM/BeeAI's *Agent
Communication Protocol*. Cursor, Zed and JetBrains speak Zed's *Agent Client
Protocol* -- a different, still-independent spec. The FAB-08 deferral cannot be
cited as a prior rejection of Cursor ACP. Annotating that file is this unit's one
concrete recommendation; the edit belongs to that unit and was deliberately not
made here.

**The existing Cursor HTTP adapter is 13,918 lines across 43 files**, against 916
for all of `coding-agent`. Most of that bulk is OpenCodex forcing an agent back
into model shape: a 2,214-line `native-exec` family, twelve `reject*` functions,
877 lines of tool-vocabulary translation, and an `exec-policy.ts` that defaults
the whole capability off because "opencodex has no trustworthy per-request
attestation" of the caller's sandbox. Cursor is an agent on **both** transports.
ACP is cheaper mainly because less is compelled to pass through the proxy.

## What did not survive (LOOP-PESSIMIST-01)

This is the important part of this record.

**The hypothesis that died: "ACP gives a client no way to constrain the agent."**
That was the spine of the first draft. It is false. Cursor documents
`plan` and `ask` as read-only modes, and ACP v1 defines `session/set_mode`. The
A-phase reviewer found it; main verified it by fetching Cursor's docs directly
rather than trusting the report.

**A second claim died with it:** that `session/update` only reports edits after
the fact. ACP defines a proper pending -> permission -> `in_progress` lifecycle,
and agents may route writes through client `fs/write_text_file`. The "ACP's leak
is silent, therefore worse" framing was withdrawn.

**What replaced them,** and what a skeptic should attack next: a mode is a
behavioral assertion where `--tools ""` is a structural one; cursor-agent ignores
Codex's tool list either way; and Cursor's blocking `cursor/ask_question` /
`cursor/create_plan` sit outside ACP, so an adapter must carry vendor-proprietary
methods and answer them promptly or stall the turn.

**The conclusion survived while its premise was destroyed.** That deserves
suspicion and is flagged in 040 and 050 rather than smoothed over.

**What evidence would show this direction is wrong:** a live trace of
`cursor-agent acp` pinned to `ask` mode showing it is a hard read-only guarantee,
not merely intended behavior. That was not obtainable here -- the macOS login
keychain is locked, so no live handshake ran at all. If `ask` proves enforced,
ACP-D2 becomes genuinely arguable and this verdict should reopen.

## How the audit went

Three rounds with one independent reviewer on `gpt-5.6-sol`, chosen off the grok
family that produced all the evidence lanes and the design consult.

| Round | Verdict | Findings |
|---|---|---|
| 1 | FAIL | 8 blockers, including the falsified premise and a verifier that read nothing |
| 2 | FAIL | 3 unresolved, 3 new -- the round-1 folds had added retractions without deleting the retracted sentences |
| 3 | GO-WITH-FIXES | 3 residual contradictions, fixed before the transition |

Sixteen findings, zero rebutted. Two are worth carrying forward as reusable
lessons:

- **A retraction that leaves the original text standing is worse than the
  original error**, because the document then contradicts itself and a reader can
  quote either half. Round 2 existed entirely because of this.
- **`bun run privacy:scan` reads `git ls-files`** (`scripts/privacy-scan.ts:60`).
  It passed green over this unit while reading none of it, because the files were
  untracked. A devlog unit must be staged before its gates mean anything. This is
  exactly the PLAN-VERIFIER-REAL-01 trap and it caught a plan that had explicitly
  set out to avoid it.

A same-family reviewer had read this material three times without noticing that
Cursor documents a read-only mode. Decorrelation was not ceremony here.

## Verification

Over the tracked six-file unit:

- `bun run privacy:scan` -> exit 0, "Privacy scan passed"
- `bun test tests/ci-workflows/repo-hygiene.test.ts` -> 14 pass / 0 fail
- `git ls-files -- devlog/_plan/260910_cursor_acp_bridge` -> 6 files

No `src/`, `gui/` or `docs-site/` file was touched, so no typecheck or product
suite applies. **No machine gate checks whether any claim in these documents is
true**; that is stated in 000 rather than implied.

## Process deviations, recorded

1. **Documents 010-050 were authored across P and A rather than in B.** The
   investigation and the two audit rewrites are where the content actually came
   from. The B->C edge caught this correctly via SOURCE-DELTA-01 on the first
   attempt, and only 060 was authored inside B. For a docs-first unit whose
   deliverable *is* the analysis, the phase boundary is genuinely awkward -- but
   the record should say what happened rather than imply a clean P/B split.
2. **Architect consultation is formally unmet, under an explicit waiver.** No
   `agent_type: "architect"` exists in this session's dispatch schema. A design
   consult ran with unverified routing. 000 records the waiver and scopes it to
   docs-only work; a GO on any ACP option may not inherit it.
3. **No fourth reviewer pass** ran over the three final contradiction fixes.

## State

Unit closes with a verdict and an open recommendation. Nothing is pending inside
it. Follow-ups, in dependency order:

1. Annotate `800_agent-fabric/110_protocol_boundaries.md` (small, unblocked).
2. If Cursor-the-agent is ever wanted, that is ACP-D4 -- an optional subsystem,
   never a provider -- and it needs demand evidence first.
3. ~~Reopen only on a live `ask`-mode trace.~~ **Done** -- see
   [070](./070_live_trace.md). Residuals 1-3 are closed; `ask` held, and `agent`
   mode mutated a file with no permission request. The remaining untested path is
   `plan` mode and `cursor/create_plan`.

---

## Addendum -- final state of this unit

Two further passes happened after the summary above was written. Both changed
conclusions, so the summary alone is no longer sufficient; this addendum is the
current entry point.

**A live trace was run** ([070](./070_live_trace.md)) once the keychain was
unlocked. `ask` mode held against an explicit write instruction. `agent` mode
edited the file after issuing zero permission requests and zero client-mediated
writes. That closed residuals 1-3 and reversed a retraction: the reviewer had been
right about the ACP specification and wrong about Cursor's implementation of it.

**Then the trace itself turned out to be measured wrong.** Reading t3code, which
ships a working ACP provider layer, surfaced a client capability
(`_meta.parameterizedModelPicker`) that both t3code and cli-jaw send and this
unit's probe did not. With it, Cursor returns clean base model ids, branded
display names, and **per-model config options carrying the legal effort and
context values, including 1m context**. Three model-surface claims were withdrawn.

That second correction matters more than its size suggests. Neither the ACP spec
nor Cursor's documentation mentions the flag. No amount of reading would have
found it; only an existing implementation had it. When a protocol has a
vendor-specific negotiation flag, the reference implementations are primary
sources, not secondary ones.

### Where the verdict landed

Unchanged in conclusion, replaced twice in reasoning: **not an inference provider.**

The strongest reason is no longer about tool ownership. It is that **OpenCodex has
no workspace to give the agent** -- `OcxParsedRequest` has no working-directory
field and `coding-agent/turn.ts` passes no `cwd`, so a spawned `cursor-agent` acts
in the proxy's directory rather than the caller's project. 070 covers this and why
prompt-sniffing and headers both fail. A required `workspaceRoot` is the only
honest workaround and it pins the provider to one repository.

### What came out of it that is worth keeping

`ACP-D5` in [040](./040_feasibility_verdict.md): run `cursor-agent acp` as a
**metadata discovery probe** rather than an inference path. It sidesteps every
blocker because no turn crosses the ACP boundary, and it replaces hand-maintained
`modelReasoningEfforts`/`modelContextWindows` tables -- and the default-off
`cursorEffortRows` regex workaround -- with values the vendor itself advertises.
Coverage is partial: 30 of 38 ACP ids match the HTTP catalogue exactly, 36 with a
short alias table (six Claude name reorderings such as `claude-opus-4-6` versus
`claude-4.6-opus`, plus `default` versus `auto`), against 53 configured HTTP
models. So ACP is an authoritative source for roughly two thirds of the catalogue,
not a replacement for it.

### Status

Closed as an investigation. No implementation was undertaken and none is proposed
in this unit. `ACP-D5` is recorded as the one follow-up with a favourable
cost/benefit; `ACP-D4` remains deferred pending demand; `ACP-D2`/`D3` stay
rejected. The `800_agent-fabric/110_protocol_boundaries.md` annotation remains an
open recommendation owned by that unit.
