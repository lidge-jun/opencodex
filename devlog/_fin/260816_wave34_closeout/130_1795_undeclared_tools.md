# 130 — #1795: undeclared tool calls from a routed provider

## Verified state (at `812e7c40b`)

The guard is real and deliberate. Both bridge paths refuse an undeclared tool name:
streaming at `src/bridge.ts:1006` and non-streaming at `:1715`, each emitting a 502
`upstream_error`. Pinned by `tests/bridge.test.ts:345` and
`tests/responses-stream-tool-events.test.ts:30`.

So the reported behavior is not a defect in the sense of "code doing something nobody
intended". It is the designed fail-closed contract, and the reporter is asking for that
contract to be relaxed.

## Why this is NEEDS_HUMAN rather than a fix

The request — "tolerate undeclared tool calls, drop them with a warning" — changes a
safety boundary, and the failure modes on the other side are not obviously smaller than
the one being reported.

An `exec` call the client never declared is, by construction, a request the client has no
handler for. Dropping it silently means the model believes it ran a command and receives
either nothing or a fabricated absence, and the turn continues on that false premise. For
`exec` specifically the current 502 is the honest outcome: the turn genuinely cannot be
completed as the model intended.

There is also a real question of WHERE the tolerance belongs. Three candidate answers,
with materially different blast radii:

1. **Global tolerance.** Every routed provider may emit any tool name and have it dropped.
   Largest blast radius; removes the guard for cases it was written for.
2. **Per-provider opt-in.** A provider config flag marks a known-noisy upstream. Contained,
   but requires the operator to know which providers need it.
3. **Subagent-scope only.** The reporter's actual case is a shadow/subagent call whose
   system prompt describes capabilities the request's tool set does not include. Narrowest,
   and arguably addresses the root cause on the PROMPT side rather than the response side.

Option 3 suggests the defect may not be in the bridge at all: if a subagent request ships
a system prompt advertising `exec` while declaring a tool set without it, the request is
internally inconsistent before the provider ever answers. That is worth checking before
loosening a validator.

## Missing evidence

No live SenseNova/Kimi reproduction was available in this loop. Without one, two things
cannot be established:

- whether the hallucination is provider-specific or a general small-model behavior under
  a capability-describing system prompt;
- whether the subagent request actually advertises `exec` in its prompt while omitting it
  from `tools` — which would make this a request-construction defect with a different fix.

## Disposition

**NEEDS_HUMAN.** The change is a deliberate loosening of a safety contract whose scope is
a product decision, and the evidence needed to choose the scope correctly is not available
without a live reproduction. Recorded here rather than guessed at; #1795 stays OPEN.

