---
title: Feasibility verdict
unit: 260910_cursor_acp_bridge
phase: 4 of 4
date: 2026-09-10
---

# 040 -- Feasibility verdict

## Executive verdict

**Transport: YES. Product: NO for the Codex request path -- with lower confidence
than this document originally claimed.**

Spawning `cursor-agent acp` from OpenCodex and streaming its output is
mechanically straightforward. `ProviderAdapter.runTurn` is a supported non-HTTP
seam, `src/adapters/coding-agent/` is a working precedent for spawning a vendor
CLI, and the ACP spec is Apache-2.0 with an official TypeScript SDK. If the
question were only "can it be wired up", the answer is yes and the work is small.

It should still not be added as a provider, but the A-phase audit removed this
document's strongest argument. The original claim -- that ACP gives a client no
way to constrain the agent -- was **wrong**; Cursor exposes read-only `plan` and
`ask` modes. What remains is a contract-semantics objection plus a concrete
integration hazard in Cursor's proprietary blocking extension methods. Those are
sufficient for "not a provider". They are **not** sufficient to call the option
impossible, and a live test could still move this verdict.

## Retraction: there IS a constraining lever

An earlier draft of this document asserted that "ACP offers no such lever [...]
There is no client-supplied tool list and no tool-less mode." **That was false
and is retracted.** The A-phase reviewer caught it and the primary source
confirms the reviewer.

[cursor.com/docs/cli/acp](https://cursor.com/docs/cli/acp), opened 2026-09-10,
under "Sessions, modes, and permissions":

> **Modes**
> ACP sessions support the same core modes as CLI:
> - `agent` (full tool access)
> - `plan` (planning, read-only behavior)
> - `ask` (Q&A/read-only behavior)

ACP v1 additionally defines `session/set_mode` and session config options with a
`mode` selector, so mode is client-selectable, not merely a CLI flag.

That materially weakens the safety case this document originally rested on. A
client can put Cursor in a read-only mode. The "two writers in one workspace"
objection largely dissolves under `ask`.

## What actually remains

The verdict survives the retraction, but on narrower and different grounds. Three
things remain true.

**1. The contract is still not a model contract.** `ProviderAdapter` is a model
port: Codex sends its tool list and expects to own the tool loop. The
`coding-agent` precedent fits because `--tools ""` structurally empties the
vendor's tool set (`src/adapters/codebuddy/adapter.ts:44`), producing the
invariant at `turn.ts:86`, **"Codex retains tool ownership: the CLI runs with its
own tools disabled."** Cursor's `ask` mode is not that. It is *read-only
behavior*, not *no tools*: cursor-agent still gathers its own context with its
own read tools and still ignores the tool list Codex supplied. The result fits
the port only in the sense that prose comes out -- a research assistant wearing a
model's interface.

Note the difference in kind. `--tools ""` is structural and verifiable from the
argv. A mode is behavioral and asserted by the vendor. For a boundary that
matters, those are not interchangeable.

**2. Cursor's ACP has proprietary blocking extension methods.** Its docs define
`cursor/ask_question` and `cursor/create_plan` as **blocking**: "The agent waits
for a response before continuing. Your client must reply with a JSON-RPC
response." `cursor/create_plan` is associated with plan-style work, though this
unit did not establish that every `plan`-mode turn raises it.

So an OpenCodex ACP adapter would have to implement vendor-proprietary methods
outside the ACP spec purely to avoid deadlock. It does **not** have to fabricate
content: the documented contracts allow `{ outcome: "skipped" }` or
`{ outcome: "cancelled" }` for `cursor/ask_question`, and `rejected` or
`cancelled` for `cursor/create_plan`. An earlier draft asserting that answers
"must be fabricated" overstated this and is corrected.

The residual cost is narrower and still real: the adapter must carry
vendor-specific methods outside the spec it claims to implement, must answer them
promptly or stall the turn -- Cursor warns "If your client does not answer
permission requests, tool execution can block" -- and by declining them
systematically it degrades the mode into something weaker than intended.

This objection does not depend on any unproven claim about filesystem behavior,
which is why it carries weight the retracted argument did not.

**3. Event mapping is still lossy.** ACP does define a proper tool-call lifecycle
-- an agent reports a pending `tool_call`, may request permission, then reports
`in_progress` -- so the earlier claim that `session/update` only ever reports
completed edits was also overstated and is withdrawn. But the mapping into
`AdapterEvent` remains lossy in the direction that matters: Codex's
`tool_call_start` means "you run this", while ACP's `tool_call` means "I am
running this". Same shape, inverted ownership.

## Correction: it is not "HTTP clean, ACP dirty"

An earlier draft of this verdict said OpenCodex "already solved agentic Cursor on
the path it owns". That was too generous and is withdrawn. It did not solve it.
It **contained** it, at a measured cost of ~13.9k lines, and defaulted the
dangerous half to off (030).

Cursor is an agent on **both** transports. Its Private Inference backend also
drives client-side execution -- read, write, delete, ls, grep, shell, fetch --
which is why `src/adapters/cursor/` carries a 2,214-line `native-exec` family, a
twelve-function refusal surface, and 877 lines of tool-vocabulary translation.
And `exec-policy.ts` states plainly that the `codex-sandbox` mode is fail-closed
because "opencodex has no trustworthy per-request attestation" of the caller's
sandbox state.

So the invariant OpenCodex actually maintains is broader than "Codex retains tool
ownership". It is **"OpenCodex does not execute what it cannot attest."**

## The real axis: where agent-ness escapes, and whether it is representable

Both transports leak agent-ness. They differ in *where*, and that difference is
the whole argument.

| | HTTP (Private Inference) | ACP |
|---|---|---|
| Where execution happens | OpenCodex, on the vendor's request | inside `cursor-agent` |
| How it appears at the boundary | a typed protobuf `execCase` (`writeArgs`, `deleteArgs`, `grepArgs`, ...) | a `tool_call` update, and *optionally* a `session/request_permission` |
| Can OpenCodex refuse? | yes, per case, unconditionally | only when the agent chooses a client-mediated path -- a `session/request_permission`, or a write routed through `fs/write_text_file`; both are optional for the agent |
| Cost to integrate | ~13.9k lines | ~1/10 of that |

ACP defines a refusal point, but it is discretionary on the agent's side where the
HTTP one is not -- and [070](./070_live_trace.md) shows Cursor declining to use it.
In `agent` mode it mutated a file with no permission request and no client-mediated
write, against a client instrumented to deny everything. `cli-jaw` likewise runs
with `fs:false, terminal:false` (`session.ts:161`) and Cursor functions regardless.
That is a two-run result on one version and one model, so it establishes the
unsupervised path is reachable by default, not that no configuration mediates.

The HTTP mediation point is **typed and non-optional**. Cursor's agent-ness
arrives expressed in a protobuf schema OpenCodex parses, which is why a per-case
`reject*` function can exist for each one, and Cursor cannot proceed without
OpenCodex answering.

ACP's mediation points are real but **discretionary**. The agent reports
`tool_call`, MAY request permission before acting, and MAY route file writes
through `fs/write_text_file` where the client offers it.

**This has now been measured -- see [070](./070_live_trace.md).** In `agent`
mode, `cursor-agent` `2026.09.08` edited a scratch file having issued **zero**
`session/request_permission` calls and **zero** `fs/write_text_file` calls,
against a client instrumented to deny everything. The deny policy never fired
because nothing was offered to deny. In `ask` mode the same prompt produced no
write at all.

So the comparison is about *guarantee*, and the evidence supports the stronger
form: HTTP's refusal point is structural and per-operation; ACP's, as Cursor
implements it, does not exist below the level of the mode setting. Containment is
all-or-nothing -- an agent that cannot act, or an agent that acts unsupervised.

The cost difference follows the same line -- **you largely pay for what must come
through you.**

For completeness, the gate that ACP cannot reproduce: when the incoming Codex
request advertises `apply_patch`, `live-transport.ts:662` sets
`rejectNativeFileMutations`, and `native-exec.ts:649-650` rejects Cursor's write
and delete exec and redirects them to Codex's `apply_patch`:

```ts
if (execCase === "writeArgs") return [deps.rejectNativeFileMutations ? rejectWriteExecForApplyPatch(...) : writeExec(execMsg)];
if (execCase === "deleteArgs") return [deps.rejectNativeFileMutations ? rejectDeleteExecForApplyPatch(...) : deleteExec(execMsg)];
```

This is narrower than `--tools ""`: it redirects write and delete exec toward
Codex's `apply_patch` when `apply_patch` is advertised, rather than disabling
every vendor tool, and gated native fallback remains. The redirect rationale
lives at `native-exec-fs.ts:42-46`; `native-exec.ts:649-650` only selects the
helper. An ACP adapter has no equivalent *structural* hook, because ACP leaves to
the agent whether a given mutation is surfaced to the client at all.

## What adopting ACP would actually trade

Stated plainly: adopting ACP saves the ~13.9k lines of containment, and in
exchange OpenCodex stops being a proxy and becomes a **launcher**.

Whether that is a bad trade depends entirely on which product it is. Against
OpenCodex's identity as a provider proxy it is a bad trade. For an explicit
agent-delegation surface it is an honest one -- you do not contain a contractor
you deliberately hired.

That is the scoping this argument requires, and it is sharper than "ACP does not
fit the layer". The containment objection is **decisive against ACP-D2 and
ACP-D3**, which put a launcher on the Codex request path while telling the caller
it is a model. It is **not decisive against ACP-D4**, where silent local edits are
the user's stated intent rather than a leak. D4 therefore survives this argument
on its merits and is blocked only by unmeasured demand.

## The direction that ACP would lose on anyway

Even setting the tool-ownership problem aside, ACP appears to be the narrower
Cursor surface for a model router -- though "strictly smaller", as an earlier
draft put it, is not established and is withdrawn.

What is dated and attributable: on 2026-04-24 Cursor staff said ACP model
selection "is not exposing the full set of model parameters and variants [...]
including fast mode / Max Mode / 1M-context variants"; on 2026-07-28 staff said
ACP "exposes only one variant per model" and that Auto's *Optimize For -> Cost*
is not exposed over ACP. The same threads record later improvements, including a
fast Composer 2.5 variant, while the 1M-context limitation persisted. Cursor's
changelog names model and mode selection over ACP in Mar 2026.

A live roster has since been collected -- see [070](./070_live_trace.md). On
2026-09-08 ACP advertised 38 models with exactly one row per model, parameters
baked into each id (context `200k`/`272k`/`300k`, effort
`medium`/`high`/`xhigh`), no 1M-context variant and no Max Mode. So the vendor's
"one variant per model" statement holds, the surface is more parameterised than
an early draft implied, and on the specific axes of 1M context and Max Mode the
HTTP adapter does expose more.

## Options considered

Decision IDs from the design consult, with main's disposition.

| ID | Option | Disposition |
|---|---|---|
| ACP-D1 | Do not integrate; keep the HTTP Cursor adapter | **Accepted** |
| ACP-D2 | Clone `coding-agent` onto `runTurn` for ACP | **Rejected.** The original rejection assumed the agent could not be constrained at all; `ask` mode refutes that, so the reasoning changed. It is rejected because the only observed lever is session-wide: [070](./070_live_trace.md) found no per-operation refusal point in `agent` mode, so the adapter must choose between an agent that cannot act and one that acts unsupervised. Compounding that, cursor-agent ignores Codex's tool list either way, and Cursor's proprietary blocking `cursor/*` methods must be carried and answered. Reopen if Cursor gains a tool-less mode, per-operation permissions by default, or if a broader trace contradicts 070 |
| ACP-D3 | Widen `ProviderAdapter` with an `ownsExecution` flag so the core ends the turn without running Codex tools | **Rejected for the request path.** It is the honest way to model a delegating agent, but it teaches `src/server/responses/core.ts` a second product and nests an agent inside a Codex turn. Recorded as the only technically coherent adapter-shaped option, should the product goal ever change |
| ACP-D4 | An optional ACP host subsystem, registered like Lab, never imported by `router.ts` / `lifecycle.ts` / `responses/core.ts` | **Deferred, not rejected.** This is where Cursor-the-agent would belong if it is ever wanted. It is a peer product, not a provider, and it needs demand evidence first |
| ACP-D5 | Use `cursor-agent acp` purely as a **metadata discovery probe** for the existing HTTP Cursor provider -- read per-model `configOptions` (effort, context, thinking, fast) and populate `modelReasoningEfforts`/`modelContextWindows` from them, routing no inference through ACP | **Recommended for follow-up.** Discovered late, in [070](./070_live_trace.md). It avoids every blocker above because no turn crosses the ACP boundary: no tool-ownership inversion, no missing usage, no unsupervised writes. It replaces hand-maintained tables and the default-off `cursorEffortRows` workaround with values the vendor itself advertises. Cost is one short-lived child process at discovery time |

The distinction that organizes all four: **Cursor-the-model is already integrated
over HTTP. ACP delivers Cursor-the-agent.** Those are different products, and
only the first one is what a provider proxy is for.

## On reusing cli-jaw

Not recommended, and mostly moot given the verdict. For the record: of the native
ACP package's 2,276 lines, 605 are portable and 1,671 are bound to `cli-jaw`'s
runtime (020). The portable part is essentially `wire.ts` + `connection.ts`, a
JSON-RPC decoder and an NDJSON stdio transport -- and the official Apache-2.0
`@agentclientprotocol/sdk` supplies both without a cross-repository copy. There
is no case for vendoring.

There is also a reason the code is cheap over there that does not travel. Being a
launcher is `cli-jaw`'s **identity** -- it is an agent harness, and spawning
Cursor, Grok and Copilot as runtimes is the product, not a compromise. Its ACP
client is small because it never had to contain anything. Porting those 605 lines
into OpenCodex imports the code but not the identity that made it cheap, and
OpenCodex would then be holding a launcher inside a proxy. The two repositories
can both be right about ACP while reaching opposite conclusions.

## Recommended follow-up

One documentation correction, which is the concrete deliverable this unit
produces:

> Annotate `devlog/_plan/800_agent-fabric/110_protocol_boundaries.md` to record
> that its ACP row refers to IBM/BeeAI's Agent Communication Protocol (merged
> into A2A), and that Zed's Agent Client Protocol -- the one Cursor, Zed and
> JetBrains speak -- is a different, still-independent specification not covered
> by the FAB-08 deferral.

That edit belongs to the agent-fabric unit, not this one, so it is recorded as a
recommendation rather than performed here.

## Residuals -- not proven on this host

1. **CLOSED by [070](./070_live_trace.md).** `ask` mode is enforced on
   `2026.09.08`: an explicit "do it now" write instruction produced no
   modification. Cursor's read-only modes are real, which is why this document's
   original categorical premise was correctly retracted.
2. **CLOSED by [070](./070_live_trace.md).** The handshake ran. `cursor_login` is
   the advertised auth method, `protocolVersion` is 1, `loadSession` is true and
   there is no `session/resume`.
3. **CLOSED by [070](./070_live_trace.md), and it reverses a retraction.** In
   `agent` mode Cursor mutated the file with no permission request and no
   client-mediated write. The withdrawn claim was empirically right about Cursor
   even though the reviewer was right about the spec.
4. **Still open: `plan` mode and `cursor/create_plan` were never exercised.** No
   `cursor/*` extension method fired in either traced run, so the blocking-method
   cost argued above is documented but not yet observed.
5. **Demand is unmeasured.** Whether anyone wants Cursor-the-agent inside
   OpenCodex, as opposed to Cursor-the-model, is unknown. ACP-D4 should not move
   without it.
6. **Vendor trajectory is unknown.** If Cursor adds a tool-less or
   client-tools mode to ACP, the blocking constraint dissolves and this verdict
   should be re-opened. The traced behavior is one version only.
7. **Distribution not assessed.** Shipping a spawn of the proprietary
   `cursor-agent` binary may carry product or licensing constraints that were
   not examined.
