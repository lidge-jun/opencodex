# 141.50 — Phase 5: live smoke (PASSED, self-served)

> Branch `feat/kiro-on-dev`. End-to-end verification of the kiro adapter against the REAL
> CodeWhisperer backend, without Codex/proxy — driving the adapter directly
> (loginKiro import → createKiroAdapter().buildRequest → fetch → parseStream).

## Result — PASS (2026-06-28)
Imported the installed kiro-cli token (access 233ch, refresh present, profileArn
`arn:aws:codewhisperer:us-east-…`, region us-east-1), single-turn prompt
"Reply with exactly: hello-ocx-kiro":
```
[req] url=https://runtime.us-east-1.kiro.dev/  bodyBytes=305
[res] status=200 OK
[events] text_delta,text_delta,done
[assembled-text] "hello-ocx-kiro"
```
→ auth (oauth import) + conversationState wire + AWS eventstream decode + stop/input/name
parse + AdapterEvent emission all verified against the live backend. Exact expected text returned.

## What this proves end-to-end
- `loginKiro` reads the real kiro-cli SQLite token and `resolveKiroProfileArn`/`resolveKiroRegion`
  return real values.
- `buildRequest` produces a CodeWhisperer-accepted body (200, not the historical
  REQUEST_BODY_INVALID — the input=object + adjacency fixes hold on the wire).
- `decodeEventStream` + `parseKiroEvent` correctly stream a real eventstream response to text.

## Not covered live (sufficiency note)
- A tool-call round-trip was not exercised live (would need a multi-turn result feedback). The tool
  wire (input=object), stream tool-event discrimination (name-repeat → start-once/delta), and
  toolResult adjacency are covered by unit tests (kiro-adapter.test.ts) and were the exact jawcode
  live-confirmed fixes. Text round-trip proves the shared auth/wire/stream path.

## Goal status
All 5 work-phases complete on feat/kiro-on-dev, each employee-verified; live smoke self-served.
Completion is proven; awaiting explicit user finalize (`goal done`). No push; ToS note present in
the registry entry (third-party harness, import-first).
