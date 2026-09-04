# 021 — wp3 evidence: upstream refuses gpt-6-astra on a ChatGPT account

Sub-document of 020. **This document was rewritten after audit round 2.** Its first version
concluded the failure was a self-inflicted `ocx service` restart. That conclusion was
wrong, the reviewer caught it, and the corrected finding is materially more useful.

## How the first conclusion failed, and what it cost

Round 1 of the audit (015/H4) warned that `close_reason = 'adapter_eof'` returning zero
rows made the instrument suspect. Round 2 pressed harder: the reviewer issued a live
request and showed that `routing-history.sqlite` gained **no new rows at all**, so the
"recording gap ends exactly at process start" claim was false — the gap included the
present moment, under a demonstrably live proxy. I reproduced that exactly: a successful
`xai/grok-4.6` completion returned `pong` and the table count stayed at 632,372.

The reviewer inferred a stalled history writer. That was also wrong, and the real cause is
the reason both of us went astray:

**`routing-history.sqlite` is a derived INDEX, not the log.** `ocx logs index-status`
reports 633,039 indexed rows against a 524,909,345-byte source — 667 more than the SQL
query returned, because the file on disk is a snapshot that lags the live writer. Querying
it directly, as both audit rounds did, reads a stale projection. The authoritative reader
is `ocx observe logs`.

The lesson is worth stating plainly: **two rounds of confident reasoning were built on a
tool that was not reading the live data.** Neither the restart theory nor the stalled-writer
theory survived contact with the correct instrument.

## The actual cause

`ocx observe logs` shows the failing turns immediately. Nine `gpt-6-astra` requests, all
status **502**, all carrying the same upstream message:

```
The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.
```

Five of them land in a ~5-second burst (`1788480646653` … `1788480649531`), on one
`conversationId`. That burst IS the user's "Reconnecting… 5/5": the client retried five
times, each retry was refused by upstream, and the turn ended without a terminal event —
which [bridge.ts](../../../src/bridge.ts) faithfully reports as
`incomplete_details.reason = "adapter_eof"`.

The route decision confirms it reached upstream rather than being filtered locally:
`routeKind: "native"`, one candidate, `eligible: true`, `reason: "native-family"`,
`terminalSource: "synthetic"`, `errorCode: "upstream_server_error"`.

A tenth, earlier row (`1788480208361`) failed differently — `503 "Codex credential refresh
did not complete; retry this request"` — which is the error observed live earlier in the
session and a separate transient.

## What this proves

1. **The user's `adapter_eof` is an Astra entitlement refusal, not a transport fault.**
   The proxy dispatched correctly; the ChatGPT backend refused the slug.
2. **The refusal message is verbatim the Daybreak Blue pattern.**
   [metadata.ts](../../../src/codex/catalog/metadata.ts) already records the identical
   sentence for `gpt-daybreak-blue-latest`: "not supported when using Codex with a ChatGPT
   account". Astra is in exactly that state for this account today.
3. **Shipping upstream is not the same as being reachable.** Upstream's `available_in_plans`
   lists 23 plans including `free`, and `models.json` ships the row — yet this Pro account's
   Codex surface rejects it. Catalog availability and account entitlement are different
   facts, and only the second one decides whether a request succeeds.
4. **The bridge behaved correctly** by refusing to call a refused turn "completed".

## Verdict for wp3: NOOP for the transport layer, with a finding that lands in wp2

No bridge/transport change. Do NOT add a retry (the client already retried five times), and
do NOT downgrade `adapter_eof` to `completed`.

But this is not a null result. It changes the gating question 010 answered:

- 010 argued Astra should stay OUT of `ACCOUNT_GATED_NATIVE_OPENAI_MODELS` because
  `available_in_plans` is broad. That reasoning is now contradicted by a live 502 from the
  account actually in use.
- The user's explicit instruction for this session was "전체 노출되도록 해놔 요청도 보내고
  오류가 나도록" — list it everywhere, let the request go out, let the error surface. The
  current behavior does exactly that, and the error it surfaces is the true one.
- So the row stays listed and ungated **by user instruction**, and the honest improvement is
  not to hide the model but to make the refusal legible instead of appearing as a generic
  `adapter_eof` after five silent retries.

That improvement is deliberately NOT folded into this unit. It is a user-visible error
surface change with its own blast radius, and 020's scope boundary excludes changing how
`adapter_eof` is reported. Recorded here as the next unit's candidate.

## Reproduction (corrected)

```
ocx observe logs --limit 2000 --jsonl \
  | jq -r 'select(.model=="gpt-6-astra") | [(.timestamp|tostring), (.status|tostring), (.upstreamError // "-")] | @tsv'
```

Do NOT query `routing-history.sqlite` directly for live traffic; it is an index snapshot
that lags the writer, which is what produced two wrong conclusions above. Verify liveness
with `ocx logs index-status` (compare `indexed rows` against a direct `select count(*)`)
before treating any absence in that table as evidence.
