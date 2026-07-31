# 011 — WP2 evidence: sandbox-aware policy patch

## Delta (uncommitted at review time)

- src/types.ts: `nativeLocalExec?: "off" | "codex-sandbox" | "on"` added next to
  legacy flag.
- src/adapters/cursor/exec-policy.ts: `CursorNativeExecMode`,
  `CURSOR_SANDBOX_FULL_ACCESS_RE`, `resolveCursorNativeExecMode`,
  `cursorRequestDeclaresFullAccess` (system[] + developer-role only),
  `effectiveCursorNativeExecAllow`.
- src/adapters/cursor/transport.ts: `CursorTransportFactoryInput.requestDeclaresFullAccess?`.
- src/adapters/cursor.ts: runTurn computes the declaration from the built
  `CursorRunRequest` and passes it in the factory input.
- src/adapters/cursor/live-transport.ts: constructor + prepareMcp now build
  `execContext.unsafeAllowNativeLocalExec` via `effectiveCursorNativeExecAllow`.
- src/providers/registry.ts: catalog note documents the new mode.
- tests/cursor-native-exec-policy.test.ts (sol worker Hilbert + BigInt-safe
  stringify fix): 18 tests — detector carriers/negatives, precedence, allow
  truth table, ACTIVATION twin (real fs read allowed vs
  NATIVE_LOCAL_EXEC_DISABLED), runTurn->factory plumbing capture.

## Gates

- `bun test tests/cursor-native-exec-policy.test.ts`: 18 pass / 0 fail.
- Adjacent suites (native-exec, native-exec-shell, adapter, live-transport,
  transport-retry, desktop-exec): 51 pass / 0 fail.
- `bunx tsc --noEmit`: exit 0.
- C-gate: fresh sol reviewer (Aquinas) on the diff — verdict recorded below.

## C-gate verdict

Round 1 (fresh sol reviewer Aquinas): FAIL, 1 blocker — codex-sandbox trusts
caller-controlled system/developer prose; on the auth-exempt loopback bind any
local process could assert the phrase.

### Synthesis (REVIEW-SYNTHESIS-01)

- ACCEPTED half: the trust model must be explicit. Fix: types.ts doc +
  registry note now state that `codex-sandbox` TRUSTS the caller's declared
  sandbox (the proxy cannot verify it) and must only be enabled where every
  client that can reach the data plane is trusted.
- PARTIALLY REBUTTED half ("require auth even on loopback"): keeping loopback
  auth-free is retained deliberately (breaking the zero-config Codex setup is
  not justified for a mode that defaults to off), BUT round 2 corrected the
  rebuttal's premise: loopback admits ANY process on the host — including
  other local users on multi-user machines — not just same-OS-user processes,
  and isAllowedRequestOrigin blocks non-loopback browser origins by default
  while permitting loopback-origin/origin-less callers. Docs (types.ts,
  registry note) now state exactly that; the single-user-workstation risk
  acceptance is the config owner's, made with accurate information.
- Findings 2-6: all non-blocking confirmations (defaults intact, call sites
  consistent, mutation-rejection intact, coverage adequate, scope clean).

Round 2: FAIL — rebuttal premise wrong (loopback != same OS user). Corrected
in types.ts / registry note / synthesis above; no executable change.

Round 3: PASS — "No blockers remain… wording factually accurate… claims match
auth-cors.ts:51… executable hunks unchanged from round 1. VERDICT: PASS"
(sol reviewer Aquinas, 019f50aa).
