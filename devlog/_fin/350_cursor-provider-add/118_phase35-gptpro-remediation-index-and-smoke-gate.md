# 350.118 — GPT Pro Remediation Index + Non-Destructive Test Map + Live-Smoke Gate (work-phase 35)

Date: 2026-06-27
Branch: dev
Work phase: the umbrella/index for the `111`–`117` remediation band that answers the GPT Pro plain
review (260627). Sequencing, the consolidated non-destructive test map, and the audited live-smoke gate.

> Status: **PLAN / INDEX**. Read this first; it points at the per-issue plans. No source change here.

---

## 1. Why this band exists

Two independent GPT Pro plain-review passes on push `e0d6312`/`dev` returned **NEEDS FIX**. Both agreed
the shipped routing fix (`698bbba`) and the split-frame/end-stream fixes (`96`/`99`) are credible, the
reasoning-suffix work (`107`/`108`) is on the right track, and the blob-ID handshake (`106`) is correct
in direction — but the integration is **not production-ready** because the live Cursor path can run
destructive native exec with no policy, can forward a foreign bearer to Cursor, scopes blobs globally,
completes on the wrong signal, and lacks robustness/defensive tests.

This band turns each finding into a self-contained, code-ready plan. **Nothing here is applied to
source yet** — these are PLAN docs (composer-2.5-fast did research only). Implementation is a later
PABCD Build, gated by user approval, with the Criticals (`111`,`112`) behind an explicit experimental flag.

## 2. Finding → plan map

| Review finding (severity) | Plan doc | Core fix |
|---|---|---|
| #1 Remote native exec, no policy (**Critical**) | `111` | deny-by-default `CursorExecPolicy` + typed rejections + workspace fence |
| #2 Forwarded `Authorization` to Cursor (**Critical**) | `112` | opt-in `forwardAuthToCursor`, default off; precedence reorder |
| #2/#5 turnEnded contract + async race (**High**) | `113` | complete on `turnEnded`, drain in-flight handlers, idempotent finish |
| #4 Global blob leak (**High**) + #8 first-turn state (**Medium**) | `114` | per-conversation blob/state store, checkpoint reuse, build `turns` |
| #6 Routing not future-proof (**Medium-high**) | `115` | reserved native bare-id rule + error-when-no-native-provider |
| #9 Framing corrupted-stream defenses (**Medium**) + #7 framing half | `116` | reserved/compressed flag reject, pending cap, `:status`, incomplete-at-end |
| #3 False safety claim (**High**) | `117` | conditional error text from a per-turn native-exec audit |
| #7 Suffix not per-model (**Medium-high**, mostly done `108`) | `117` | consolidate effort metadata, export normalizer, already-suffixed guard |
| #10 Test evidence mismatch (**Medium**) | `117` | ensure named test files exist + self-contained review package |

## 3. Recommended build sequence (each its own P→A→B→C→D pass)

1. **`111` native-exec policy** — biggest blast radius; everything else is safer once exec is deny-by-default.
2. **`112` auth forwarding** — small, independent, removes a credential-leak default.
3. **`113` lifecycle** — fixes hang/early-finish; also provides the in-flight-drain that `117`'s audit rides on.
4. **`116` framing robustness** — depends on `113`'s finish path for the incomplete-at-end check.
5. **`114` blob/state scoping** — larger; isol­ation + multi-turn; independent of `115`/`116`.
6. **`115` router reservation** — isolated, low risk.
7. **`117` error truth + suffix consolidation + tests** — last; the audit input depends on `111`/`113`.

`111` + `112` are **C4** (security/destructive) → ask the user before enabling any non-`deny` mode or
shipping forwarding. The rest are C2/C3.

## 4. Consolidated non-destructive test map

All tests are unit/mock only — **no live Cursor stream, no real shell/file/delete/fetch**.

- **Routing/catalog** (`115`): bare `gpt-5.5`/`o*-`/`codex-*`/synthetic `o5-*` → native or fail-closed;
  explicit `cursor/gpt-5.5` → Cursor; reserved id + no native provider → throws; `/v1/models` keeps bare
  native + `cursor/*` rows without a bare Cursor duplicate.
- **Connect framing/transport** (`116`,`113`): split header/payload; multiple frames per chunk;
  end-stream split; `{}`/`{metadata}` success; `{error}` fail; malformed fail; non-empty pending at end
  → fail; compressed → fail-closed; reserved flags → fail; pending cap → fail; `:status != 200` → fail;
  async exec reply flushed before generator completes.
- **Blob handshake** (`114`): id == 32-byte sha256(bytes); `rootPromptMessagesJson` are ids not inline;
  `getBlob` known/unknown; per-conversation isolation (A not visible in B); TTL/max-entries eviction;
  `turns` populated for multi-turn, last user excluded; checkpoint state reused next request.
- **Reasoning suffix** (`117`): bare+high→top tier; absent/none→default; already-suffixed passthrough;
  non-reasoning bare; `xhigh` preserved where supported; `discovery` vs `effort-map` drift guard.
- **Native exec policy** (`111`): default denies write/delete/shell/shell-stream/background/fetch/mcp/
  computer-use/screen with typed rejections (fs/network untouched); read-only allows in-workspace
  read/ls/grep only; path traversal rejected; recursive delete denied unless enabled; fetch blocks
  localhost/private/metadata + oversized.
- **Credentials** (`112`): provider key used; incoming `Authorization` NOT forwarded by default; opt-in
  forwards; redaction covers Bearer/headers/JSON/query.
- **Error truth** (`117`): empty audit → "no native command executed"; non-empty audit → names cases +
  counts, redacted.

Gate: `bun test tests/cursor-*.test.ts tests/router.test.ts` green + `bun x tsc --noEmit` exit 0 +
`bun run build:gui` success, per band.

## 5. Live-smoke gate (audited, separate, last)

A live `/v1/responses` smoke is justified **only as a final audited compatibility check**, never as a
substitute for the unit tests above. Both review passes converged on the same preconditions:

**Preflight (all required before any POST):**
1. Disposable empty scratch workspace — never the repo or a real user dir.
2. `CursorExecPolicy.mode = "deny"` (`111`) — abort the run on any `execServerMessage` other than benign
   blob/request-context protocol messages.
3. No MCP / screen / computer-use executors configured.
4. Dedicated Cursor token — NOT a forwarded OpenAI/ChatGPT bearer (`112`).
5. Local routing confirmed: bare `gpt-5.5` → OpenAI; `cursor/<model>` → Cursor.
6. Verbose transport logging with token/prompt-blob redaction; short client timeout.
7. `/v1/models` 7-row exposure is a user setting, not a bug (do not "fix" it).

**Safest minimal prompt** (transport-only; use a non-reasoning model `cursor/composer-2.5`):
```
Reply with exactly: OCX_CURSOR_SMOKE_OK. Do not inspect files, run commands, use tools, browse, fetch URLs, record the screen, use computer control, or modify anything.
```
Optional second smoke for suffixing: `cursor/claude-4.6-opus` + `reasoning:high` → wire id becomes
`claude-4.6-opus-max` (per `108` tiers), same deny-all policy.

**Pass criteria:** response text is exactly the sentinel; explicit `cursor/*` routing used; zero native
exec executed; blob/request-context handled safely; stream terminates on `turnEnded` without hanging
(`113`); no files changed in the scratch dir; no lingering shell/session.

**Immediate abort = failure:** bare `gpt-*` routes to Cursor; Cursor returns `not_found` for a normalized
id; stream shows done but doesn't close; any write/delete/shell/fetch/mcp/screen/computer-use request
appears; any file outside the scratch dir is touched.

## 6. Notes on review vs current code (drift since `e0d6312`)

- `#7` (per-model suffix): the review's "implementation too broad" is **already addressed** by `108`'s
  table-driven `effort-map.ts` (commits `e0d6312`→`c637f4d`→`15c90dc`). `117` only closes residual drift
  (two sources of truth, exported normalizer, already-suffixed guard).
- `exec-policy.ts` exists today but only serves the **legacy mock transport**; it does NOT gate the live
  path — so `111` adds a *separate* real policy rather than reusing it. Verified by grep: live transport
  imports `native-exec`, never `exec-policy`.
- The async-drain (`113` §3) and buffer/flag hardening (`116`) go **beyond** jawcode's Run path (which is
  itself fire-and-forget / uncapped); they mirror jawcode's *discovery* guards and the Connect spec.

## 7. Cross-references
- Per-issue plans: `111`–`117`.
- Prior shipped fixes this band builds on: `96` (routing+frame RCA), `99` (end-stream), `106` (blob
  handshake), `107`/`108` (reasoning-effort suffix/tiers).
- References: jawcode `packages/ai/src/providers/cursor.ts`, `utils/discovery/cursor.ts`; GJC
  `Yeachan-Heo/gajae-code packages/ai/src/providers/cursor.ts`; Connect Protocol Reference.
- Source: GPT Pro plain review session `01KW2MT62EN9K2VJT2G938HDG4` (260627), two passes.
