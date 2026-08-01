# 140.40 — Phase 4: kiro (new adapter, import auth, HARD)

> One PABCD pass. NEW adapter. **Import-first auth** (read kiro-cli SQLite, not browser OAuth) +
> **reuses Phase 30's eventstream decoder**. Grounded in jawcode (cites are jawcode paths).

---

## Goal

Stream kiro (AWS CodeWhisperer agent) through opencodex via import-first auth + the shared AWS
eventstream decoder. Requires anti-detection fingerprint headers for upstream acceptance.

## What we port (jawcode)

- **Auth — import-first** (`kiro.ts:392-487`, `utils/oauth/kiro.ts:1-50`):
  - read kiro-cli SQLite: `~/Library/Application Support/kiro-cli/data.sqlite3` (mac) / `~/.kiro/sso/cache.db` (linux); token keys `kirocli:social:token`/`kirocli:odic:token`/`codewhisperer:odic:token` (`:313-317`).
  - token shape `{ access_token, refresh_token, expires_at, profile_arn?, region? }`.
  - refresh `POST https://prod.{region}.auth.desktop.kiro.dev/refreshToken` (`:371-389`); 60s skew; use-stale-on-refresh-fail (`:409-429`).
  - config `KIRO_ACCESS_TOKEN`, `KIRO_PROFILE_ARN`.
- **Wire** (`kiro.ts:49-104,145-305`): endpoint `https://runtime.{region}.kiro.dev/`; `Content-Type: application/x-amz-json-1.0`; `Accept: application/vnd.amazon.eventstream`; `x-amz-target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`. `buildPayload` (history + currentContent + tools, name max 64) ; `parseKiroPayload` heuristics for `{content}`/`{name,input,toolUseId}`/`{stop}`/`{usage}`.
- **Fingerprint headers** (`kiro.ts:72-104`): `sha256(hostname-username-…)` machine fingerprint + `aws-sdk-js/… KiroIDE-{version}-{fp}` User-Agent — **required** or upstream rejects. Stable conversation id = hash of first-3 + last message (`:751-765`).
- **Streaming** (`kiro.ts:31,591`): reuses `decodeEventStream` from `aws-eventstream.ts` → **the Phase 30 module**.
- **Models** (`special.ts:82-91`): 8 static (`kiro-auto`, `claude-sonnet-4.5`, `claude-haiku-4.5`, `deepseek-3.2`, `minimax-m2.5`, `glm-5`, `qwen3-coder-next`, …).

## opencodex fit

- **NEW** `src/oauth/kiro.ts` (SQLite read + refresh; import-only, no PKCE) → register in `OAUTH_PROVIDERS`.
- **NEW** `src/adapters/kiro.ts` (`buildRequest` payload+fingerprint headers+conversation-id; `parseStream` via the **shared `src/lib/eventstream-decoder.ts` from Phase 30**).
- **Dispatch:** add `case "kiro"` in `resolveAdapter` (`server.ts:186`). Models: 8 static.

## Sub-steps (this PABCD pass)

1. **A:** `src/oauth/kiro.ts` — SQLite token read (mac+linux paths) + manual-paste fallback + desktop refresh; register in `OAUTH_PROVIDERS`. Test both import paths.
2. **B:** `src/adapters/kiro.ts` — `buildPayload` port + fingerprint/User-Agent + conversation-id hash; `parseStream` over `decodeEventStream` (Phase 30) + `parseKiroPayload` heuristics; wire `resolveAdapter`; 8-model lookup.
3. **C:** `ocx login kiro` (import) → single-turn text on `kiro-auto`; assert stream + 401→refresh; `tsc`/`bun test`.

## Risks

| Risk | Mitigation |
|------|------------|
| anti-detection headers rejected | port fingerprint + User-Agent exactly; document beta/rate-limit |
| **ToS / IDE-impersonation** | ⚠️ **explicit user decision before shipping** (`02:242`); recommend a transparency note |
| token refresh fails silently → hang | 60s skew + one 401-retry then clear error (`:409-429`) |
| SQLite read on non-mac | linux path + manual-paste fallback; test both |
| eventstream decoder absent | **HARD DEP: Phase 30 must ship `src/lib/eventstream-decoder.ts` first** |

## Verify (minimal proof)

Import kiro-cli token; `kiro-auto` single-turn text (`02:219`).

## Depends-on / enables

- **Depends-on:** **Phase 30** (the shared eventstream decoder) — auth/payload work can proceed in parallel, but `parseStream` lands after 30.
- **Enables:** nothing downstream (kiro is a leaf).
