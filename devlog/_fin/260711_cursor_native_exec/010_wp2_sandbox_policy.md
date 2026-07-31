# 010 — WP2 diff-level plan: config-selected native-exec policy mode

## Design (post-audit round 1)

Authorization model: the CONFIG OWNER selects the policy; request text alone
never authorizes. New cursor-only provider option:

`nativeLocalExec?: "off" | "codex-sandbox" | "on"`

- `off` (default): today's behavior — all native local exec rejected.
- `on`: always allow (exact semantics of legacy `unsafeAllowNativeLocalExec:true`).
- `codex-sandbox`: allow ONLY for requests whose instructions/system or
  developer-role input text declares the Codex full-access sandbox
  (`sandbox_mode` ... `danger-full-access`). Strictly narrower than `on`.
- Precedence: explicit `nativeLocalExec` wins; else legacy
  `unsafeAllowNativeLocalExec:true` maps to `"on"`; else `"off"`.

## File change map

1. `src/types.ts` (~:570, additive): add `nativeLocalExec` option + doc; mark
   legacy flag as alias for `"on"`. (File is clean post-commit 103310a8.)
2. `src/adapters/cursor/exec-policy.ts`: add pure helpers
   `resolveCursorNativeExecMode(provider)`,
   `cursorRequestDeclaresFullAccess(system, developerTexts)` (regex
   `/sandbox_mode[^\n]{0,80}danger-full-access/i`; user-role text deliberately
   NOT a carrier), and
   `effectiveCursorNativeExecAllow(provider, declared)` =
   `mode==="on" || (mode==="codex-sandbox" && declared)`.
3. `src/adapters/cursor.ts` `runTurn` (~:64-74): after `createCursorRequest`,
   compute `declared` from `CursorRunRequest.system` + developer-role
   `messages` (reviewer finding 6: both survive translation), pass
   `requestDeclaresFullAccess` through `CursorTransportFactoryInput`.
4. `src/adapters/cursor/live-transport.ts` (:325-365 constructor + prepareMcp,
   transport is per-request per finding 6): replace
   `cursorUnsafeNativeLocalExecEnabled(provider)` with
   `effectiveCursorNativeExecAllow(provider, input.requestDeclaresFullAccess)`
   when building `execContext.unsafeAllowNativeLocalExec`.
   `handleCursorNativeExec` and `rejectNativeFileMutations` stay UNCHANGED.
5. `src/adapters/cursor/transport.ts`: add optional
   `requestDeclaresFullAccess?: boolean` to `CursorTransportFactoryInput`.
6. `src/providers/registry.ts` (:202 note): one-line mention of
   `nativeLocalExec: "codex-sandbox"`.

## Tests (activation grounding)

New `tests/cursor-native-exec-policy.test.ts`:

- Detector positives: system carrier; developer-message carrier.
- Detector negatives: user-role-only carrier; workspace-write; read-only;
  absent text.
- Mode precedence table incl. legacy alias mapping.
- ACTIVATION (C-ACTIVATION-GROUNDING-01): inject a real `readArgs`
  ExecServerMessage into `handleCursorNativeExec` with a context built via the
  new resolution for (codex-sandbox + declared) and observe file content in
  the result bytes; the (codex-sandbox + undeclared) twin must yield the
  NATIVE_LOCAL_EXEC_DISABLED rejection.
- PLUMBING (A-gate round 2 blocker 2): adapter-level test — build
  `createCursorAdapter(provider, { createTransport })` with an injected
  factory that CAPTURES `CursorTransportFactoryInput.requestDeclaresFullAccess`
  and run `runTurn` twice (request with developer-role sandbox declaration vs
  without) asserting the captured values true/false; plus a transport/context
  test proving that field (not the provider flag) controls the effective
  `execContext.unsafeAllowNativeLocalExec` under `nativeLocalExec:"codex-sandbox"`.
- Existing cursor suites must stay green; `bunx tsc --noEmit` clean.

## Out of scope

GUI editor UI, docs-site pages, release; the dirty files of the other live
session (`gui/src/i18n/*`, `src/server/management-api.ts`) are untouched.
