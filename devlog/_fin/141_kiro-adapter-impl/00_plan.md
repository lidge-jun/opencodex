# 141.00 — kiro adapter on dev (implementation MOC)

> Branch: `feat/kiro-on-dev` (off `dev`, cursor-free). Implements the kiro provider for
> opencodex independent of the cursor stack. Grounded in jawcode + the 260628 live-confirmed
> CodeWhisperer contract (codex `015_reverse-engineering/45_ki_codewhisperer_wire_stream_oauth.md`).
> Supersedes-by-execution: `140_remaining-provider-ports/40_phase4_kiro.md` (the original port plan).

## Why a dev-based branch
- `dev` is cursor-free (adapters: anthropic/azure/base/google/image/openai-chat/openai-responses).
- kiro has **zero** dependency on the cursor stack (22k-line protobuf/mcp/native-exec). Its only
  hard dep is the AWS eventstream decoder — which does **not** exist on any branch yet, so we port it.
- Therefore kiro stacks cleanly on dev; cursor stays separate.

## Work-phase map (one full PABCD per phase)
- **P1 — eventstream decoder** (`src/lib/eventstream-decoder.ts` + test). Foundational. ← THIS
- **P2 — kiro OAuth** (`src/oauth/kiro.ts`): import-first kiro-cli SQLite read (mac/linux) +
  desktop refresh + manual-paste fallback; register in OAUTH_PROVIDERS.
- **P3 — kiro adapter** (`src/adapters/kiro.ts`): `buildRequest` (conversationState; toolUses.input
  = JSON **object**; toolResult adjacency; fingerprint/KiroIDE UA; stable conversationId) +
  `parseStream` (eventstream → AdapterEvent; **discriminate by stop/input, not name**).
- **P4 — wiring**: registry entry (`adapter:"kiro"`, runtime.{region}.kiro.dev) + `resolveAdapter`
  case + 8 static models.
- **P5 — verify**: `tsc`/`bun test`; `ocx login kiro` import + single-turn live smoke; ToS note.

## Correctness carried from the jawcode live debugging (must-have from day one)
1. `toolUses[].input` = JSON object (NOT JSON.stringify string) — else REQUEST_BODY_INVALID.
2. toolResults ride on the userInputMessage following their assistant turn (history adjacency).
3. Stream tool events repeat `name`+`toolUseId` on every chunk → discriminate `stop`→`input`→`name`.

## Risks
- anti-detection headers required (fingerprint + KiroIDE UA) or upstream rejects.
- ToS: third-party harness impersonation — explicit transparency note before ship.
- SQLite read on non-mac → linux path + manual-paste fallback.
