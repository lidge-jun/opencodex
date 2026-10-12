# 070 — Fix E: ultra mode toggle + 1M context autodetect (codex/cursor-gap-5)

Research: 025 ledger (luna: k3=Moonshot Kimi K3, native 1M; Cursor default
~200k; max mode = wire flag RequestedModel.max_mode AND
ModelDetails.max_mode — two impl leads; 1M exposed as synthetic -1m
picker variant, wire keeps original id) + sol Schrödinger (current code:
maxMode discarded at discovery, wire always false — cursor-blob.test:582;
ultra effort collapses to max, effort-map.ts:132; context SoT chain
discovery.ts:27/:221 -> registry.ts:1029 -> provider-fetch.ts:1216 ->
effort.ts:114) + in-repo 210_maxmode (server ACCEPTS maxMode flag;
entitlement varies per account/tier; 28 -fast ids show maxMode=true).

## Diff plan

1. EDIT live-models.ts:45 — extend result to
   { models, maxModeModels } preserving ModelDetails.maxMode=true ids.
2. EDIT discovery.ts — synthesize cursor/<base>-1m rows for
   maxMode-capable bases (auto-detect), contextWindow=1_000_000;
   kimi-k3 included when capability observed. Codex-style toggle = the
   picker variant (like effort toggles), exactly the "ultra 모드 토글".
3. EDIT types.ts + request-builder.ts normalizeCursorModelId — strip the
   synthetic -1m marker BEFORE effort resolution; set
   CursorRunRequest.maxMode=true; wire id stays original (kimi-k3-max).
   Guard against collision with real wire ids ending in -1m (restrict
   synthesis to live-derived rows).
4. EDIT protobuf-request.ts:950 — ModelDetails.maxMode = request.maxMode;
   RequestedModel.maxMode = request.maxMode (create RequestedModel even
   without parameters when maxMode).

## Accept criteria

- decode preserves maxModeModels (cursor-hardening test).
- 1M synthetic row only for capable models, context_window=1M
  (cursor-discovery + cursor-static-catalog tests).
- kimi-k3-1m + max/ultra -> wire kimi-k3-max + maxMode=true both protobuf
  fields; no synthetic suffix leaks to wire (cursor-effort-suffix +
  cursor-blob tests; update cursor-blob.test.ts:582 expectation).
- Entitlement rejection upstream stays a runtime error (plan-gated
  accounts) — documented, not faked.
