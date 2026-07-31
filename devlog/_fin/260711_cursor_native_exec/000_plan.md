# 260711 — Cursor native local exec: unblock + sandbox-aware gating

## Symptom (user report)

Codex session runs with `danger-full-access`, routed through opencodex to the
`cursor` provider (api2.cursor.sh), yet "file read/write are all blocked".

## Root cause (evidence)

- `src/adapters/cursor/native-exec.ts` (`handleCursorNativeExec`): unless
  `cursorUnsafeNativeLocalExecEnabled(provider)` is true, EVERY server-driven
  local exec case is rejected: readArgs, writeArgs, deleteArgs, lsArgs,
  grepArgs, shellArgs, shellStreamArgs, backgroundShellSpawnArgs,
  writeShellStdinArgs, fetchArgs.
- Denial text: `NATIVE_LOCAL_EXEC_DISABLED` in
  `src/adapters/cursor/native-exec-fs.ts` — "…Set
  provider.unsafeAllowNativeLocalExec=true only for trusted local experiments…".
- The knob is per-provider config (`src/types.ts:570`,
  `OcxProviderConfig.unsafeAllowNativeLocalExec`), wired at
  `src/adapters/cursor/live-transport.ts:334,359`.
- User config `~/.opencodex/config.json` `providers.cursor` does NOT set the
  flag → all Cursor-routed models get policy denials for file ops. The Codex
  session's sandbox mode is never consulted (no `sandbox_mode` /
  `danger-full-access` parsing anywhere in src — rg verified).
- Live traffic confirms the path: `~/.opencodex/usage.jsonl` shows
  cursor-provider turns (gpt-5.6-luna, grok-4.5) at 18:40-18:41 today; turns
  complete 200 but the model reports blocked file access (plus a few 400/502
  transport rows).

## Work-phase map (goalplan slug: unblock-and-gate-file-read-write-for-opencodex-c)

### WP1 — enable + live A/B verification (config-level unblock)

- Flip `providers.cursor.unsafeAllowNativeLocalExec=true` on the RUNNING proxy
  via `POST /api/providers` (management-api.ts:283 mutates the in-memory
  `config` object shared with the server closure, then `save(config)`), so no
  proxy restart is needed. Restart is explicitly avoided: it would kill live
  streams, including the session driving this work.
- Payload = full provider object read from config.json + the flag
  (`stripCodexRuntimeProviderFields` only strips `_codexAccountOverride/_required`;
  cursor OAuth token is not stored on the provider object — `apiKey` absent —
  so no secret is dropped by overwrite; `apiKeyPool` carry-over is handled by
  the endpoint).
- A/B evidence: direct `POST /v1/responses` with a cursor-routed model asked to
  read `/tmp/ocx-native-exec-test.txt` — BEFORE: denial text; AFTER: exact
  content. Then a write request must create a real file on disk (no
  apply_patch advertised in the bare curl, so `writeExec` runs).

### WP2 — repo patch [SUPERSEDED after A-gate round 1]

This section's original request-text-OR-flag design is SUPERSEDED. The
authoritative WP2 design is `010_wp2_sandbox_policy.md`: config-selected
`nativeLocalExec: "off"|"codex-sandbox"|"on"` (request text never authorizes
by itself; legacy flag = alias for "on"; `rejectNativeFileMutations`
untouched). Tests per 010, including adapter-level plumbing coverage.

## Scope boundary [amended after A-gate rounds 1-2]

- IN: src/adapters/cursor/** (incl. transport.ts), src/types.ts (now CLEAN —
  claude-inbound work landed as 103310a8/bb9da3ae; single additive hunk),
  src/providers/registry.ts note line, tests/**, this devlog unit,
  ~/.opencodex/config.json (user-authorized).
- OUT (another session's LIVE work as of round-2 audit — never touch/revert):
  gui/src/i18n/{de,en,ko,zh}.ts, gui/src/App.tsx, gui/src/icons.tsx,
  gui/src/pages/ClaudeCode.tsx, docs-site/src/content/docs/guides/claude-code.md,
  tests/claude-management-api.test.ts, src/server/management-api.ts.
  Also OUT: GUI redesign, releases, proxy restart.
- MANDATORY: refresh `git status --short` immediately before B and again
  before commit; the OUT list above is a snapshot, not a promise about the
  future tree. Commit ONLY paths this unit owns (explicit pathspec).

## Loop-spec (HOTL)

- Archetype: spec-satisfaction repair. Verifier: live A/B curls (WP1), bun
  test + tsc (WP2). Stop: criteria cr1-cr4 met. Memory: this unit +
  goalplan ledger. Bounds: ~2.5h wall-clock, session token budget; tool scope:
  local fs/shell + loopback HTTP + spawn_agent(sol); write scope per Scope IN.
- Terminal outcomes per goal objective (DONE/BLOCKED/NEEDS_HUMAN/...).

## A-gate round 1 — synthesis (reviewer: sol/Hubble, VERDICT: FAIL, 4 blockers)

| # | Blocker | Disposition |
|---|---------|-------------|
| 1 | Request-text authorization is spoofable (any HTTP caller can assert the sandbox phrase; parser.ts:238,319 accepts body text verbatim) | ACCEPTED — redesigned. Request text NEVER authorizes by itself. New config-selected mode `nativeLocalExec: "off"\|"codex-sandbox"\|"on"` on the provider; only the config owner can enable `codex-sandbox`, which then honors the client-declared sandbox per request. Default stays `off`; legacy `unsafeAllowNativeLocalExec:true` ≡ `on`. `codex-sandbox` is strictly narrower than `on`, so opting in never widens beyond what the legacy flag already allowed. Details: 010 doc. |
| 2 | A/B round-trip alone cannot prove readArgs/writeArgs fired (upstream may answer without exec) | ACCEPTED — WP1 evidence now includes provider debug `frame` diagnostic events: `ocx debug provider on` → every server frame flows through `debugProviderDiagnostic("cursor","frame",...)` (live-transport.ts:698) and exec frames carry the inner case (live-transport.ts:793) into the debug ring buffer (`/api/debug/logs`). Captured `exec: readArgs` / `exec: writeArgs` events + content/file round-trip = deterministic activation evidence. |
| 3 | 010 diff-level WP2 doc missing (DIFFLEVEL-ROADMAP-01) | ACCEPTED — added `010_wp2_sandbox_policy.md`. |
| 4 | Scope contradiction (src/types.ts IN vs OUT) + stale dirty baseline | ACCEPTED — fresh baseline recorded below. The claude-inbound work was committed meanwhile (103310a8, bb9da3ae), so those files are no longer dirty. Current dirty set (ANOTHER session's live work, DO NOT touch/revert): `gui/src/i18n/{de,en,ko,zh}.ts`, `src/server/management-api.ts`. `src/types.ts` is now clean and IN scope for WP2 (single additive hunk: `nativeLocalExec` option next to the existing flag at ~:570). |

Non-blocking residuals folded: full before/after provider-object diff captured at
flip time (finding 5); WP2 plumbing point named exactly in 010 (finding 6).
