# 000 — cursor-nativeexec-failclosed: Plan

## Objective

Tighten the Cursor adapter's native-local-exec permission fallback: make the
UNSET default fail-closed ("off") instead of the permissive "codex-sandbox".
User directive: "cursor 하드닝, 과한 폴백 금지" -> "native-exec 권한 폴백 조이기".

## Evidence base

- `src/adapters/cursor/exec-policy.ts:13` `resolveCursorNativeExecMode`: unset ->
  `"codex-sandbox"` (permissive). Introduced yesterday by commit `651f298e`
  ("harden(cursor): default nativeLocalExec to codex-sandbox") which flipped the
  default off -> codex-sandbox for out-of-box native exec convenience.
- `src/types.ts` doc still documents the SECURE contract: nativeLocalExec
  `"off" (default) rejects all server-driven local exec`; unsafeAllowNativeLocalExec
  `Defaults to false so remote Cursor messages cannot bypass Codex approval/sandbox`.
  The doc warns codex-sandbox trusts CALLER-CONTROLLED prose the proxy cannot
  verify and that the auth-free loopback bind admits any local process. So the
  permissive default contradicts the documented secure-by-default posture.
- User's live cursor provider sets NEITHER field -> currently runs on the
  permissive default. After the fix, native exec is OFF until an explicit opt-in.
- 651f298e touched exactly 3 files (exec-policy.ts, providers/registry.ts note,
  the test); flipping back must also revert the registry note to the fail-closed
  wording so it does not go stale. types.ts doc already says "off (default)".

## Loop-spec

- Loop archetype: verifier-defined (unit tests + typecheck).
- Write scope: `src/adapters/cursor/exec-policy.ts`, `src/providers/registry.ts`,
  `tests/cursor-native-exec-policy.test.ts`, this plan unit.
- Out-of-scope: cursorRequestDeclaresFullAccess regex/carrier; explicit on/codex-sandbox
  semantics; desktop/MCP executor opt-ins; other adapters; the user's config.json;
  version bump/release.
- Budget/bounds: single PABCD cycle; local test + typecheck.
- Behavior change (must report): user's native exec turns OFF until they set
  `"nativeLocalExec": "codex-sandbox"` (or `"on"`) on providers.cursor.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 010_phase1.md | Fail-closed default + registry note + tests | — |

## Accept criteria (mirrored into goalplan criteria[])

- c1: resolveCursorNativeExecMode(unset) === "off".
- c2: effectiveCursorNativeExecAllow(unset, true) === false.
- c3: explicit modes + legacy true->on unchanged; registry note reverted; type doc accurate.
- c4: cursor sweep green + typecheck clean on touched files.
