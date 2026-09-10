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
3. Reopen only on a live `ask`-mode trace.
