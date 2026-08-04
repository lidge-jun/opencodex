# 020 — WP2: server-surface hardening of the merge resolutions

Scope: the server-side code this session's two merges actually touched, reviewed
against the current tree rather than against the merge diff.

## Finding 1 (REAL DEFECT) — `ocx stop` swallows the ownership refusal

**Where.** `src/cli/index.ts:436-439` and `:452-455`.

**What the merge produced.** The conflict resolution in
`src/lib/process-control.ts:106-124` kept both sides: `stopProxy()` now `throw`s
a descriptive error when the proxy answers 409, because forcing past a refusal
would strip shared config out from under a service owned by a different
`CODEX_HOME`/`OPENCODEX_HOME`.

```ts
// src/lib/process-control.ts:110-118
if (graceful === "refused") {
  throw new Error(
    "The running proxy refused to stop: a service installed under a different "
    + "CODEX_HOME/OPENCODEX_HOME owns it. Run the stop from that home.",
  );
}
```

**The defect.** Both `handleStop` call sites catch that error bare and discard it:

```ts
// src/cli/index.ts:436-439 (before)
} catch {
  stopFailed = true;
  console.error(`❌ Failed to stop proxy (PID ${pid}).`);
}
```

`rg "refused to stop"` finds exactly one hit in the whole repository — the
`throw` itself. The remediation text ("Run the stop from that home") reaches no
user. The operator sees a generic failure and the obvious next move is to retry
or reach for a manual `kill`, which is precisely the destructive action the
guard exists to prevent.

This is an inconsistency the merge introduced, not a pre-existing style choice:
the sibling path in the SAME function already treats ownership as a distinct,
explained outcome.

```ts
// src/cli/index.ts:417-421 — the service-manager path, for contrast
if (isServiceOwnershipError(err)) {
  ownershipBlocked = true;
  stopFailed = true;
  console.error(`❌ ${err.message}`);
  console.error("   Skipping shared teardown ...");
}
```

**Fix (MODIFY `src/cli/index.ts`).** Surface the thrown message on both proxy
stop call sites, keeping the generic line for genuinely unknown failures:

```ts
} catch (err) {
  stopFailed = true;
  console.error(`❌ Failed to stop proxy (PID ${pid}).`);
  const detail = err instanceof Error ? err.message : String(err);
  if (detail) console.error(`   ${detail}`);
}
```

Deliberately NOT changed: `stopFailed` stays `true` and the shared-teardown
gating is untouched. A refusal already fails the stop; this finding is strictly
about telling the user why.

## Finding 2 (NOOP) — `stopProxy` drain ordering

`readRuntimePort(pid)` is captured before the graceful attempt, so the port
record is still readable after the proxy exits, and `waitForStoppedPort` runs on
both the graceful and the kill path. The refusal returns before either. Order
verified at `src/lib/process-control.ts:106-124`; `tests/grok-lifecycle.test.ts:137-143`
already pins "refused" ahead of `killProxy`. No change.

## Finding 3 (NOOP) — Claude Desktop routes after the module move

The four routes moved into `src/server/management/agent-settings-routes.ts`
(GET/PUT `/api/claude-desktop`, POST `/api/claude-desktop/apply`, GET
`/api/claude-desktop/status`) and `buildClaudeDesktopState` into
`src/server/management/shared.ts`, still re-exported from `management-api.ts`
for `src/cli/claude-desktop.ts:14`. Relative imports were re-based one level
(`../claude/...` to `../../claude/...`). Behavior is covered by the five passing
cases in `tests/claude-management-api.test.ts`, including a live apply that
reads the written config back off disk. No change.

## TESTS

`tests/grok-lifecycle.test.ts` — add a case asserting that both `handleStop`
proxy-stop catch blocks bind the error and echo its message, so a future edit
cannot silently re-swallow the ownership remediation. This file already
source-asserts `handleStop`, so the new case sits with its siblings.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/grok-lifecycle.test.ts tests/process-control-graceful.test.ts` | pass |
| `bun run typecheck` | exit 0 |
