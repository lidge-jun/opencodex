# 010 — Phase 1 (cursor-nativeexec-failclosed)

## MODIFY: src/adapters/cursor/exec-policy.ts

`resolveCursorNativeExecMode`, line 13:
```
-  return provider.unsafeAllowNativeLocalExec === true ? "on" : "codex-sandbox";
+  return provider.unsafeAllowNativeLocalExec === true ? "on" : "off";
```
Also update the function's `/** Config-owner-selected policy... */` comment to state
the unset default is fail-closed ("off"), matching the src/types.ts contract.

## MODIFY: src/providers/registry.ts (cursor note, ~205)

Revert the note fragment from
`native ... execution defaults to codex-sandbox mode (auto-enabled when the request
declares Codex danger-full-access sandbox); override with ...`
back to
`native ... execution stays disabled unless you set "nativeLocalExec": "on" (always)
or "codex-sandbox" (...) ...`
(the exact pre-651f298e wording). Keep the rest of the note verbatim.

## NO CHANGE: src/types.ts

The nativeLocalExec doc already says `"off" (default) rejects all server-driven local
exec` — flipping the code back makes it accurate again. Leave as-is.

## TESTS: tests/cursor-native-exec-policy.test.ts

- Line 66: `["no setting", baseProvider, "codex-sandbox"]` -> `["no setting", baseProvider, "off"]`.
- Add a regression assertion (new test) that the UNSET default is fail-closed even when
  the request declares full-access:
  `expect(effectiveCursorNativeExecAllow(baseProvider, true)).toBe(false)`
  and `expect(effectiveCursorNativeExecAllow(baseProvider, false)).toBe(false)`.
- Leave the explicit-mode effective-allow rows (72-81), the detector rows, and the
  codex-sandbox activation test (they pass an explicit nativeLocalExec) unchanged.

## Verification (C)

- `bun test tests/cursor-native-exec-policy.test.ts` -> pass (0 fail).
- `bun test tests/cursor-*.test.ts` -> 0 fail.
- `bun x tsc --noEmit` -> no errors in exec-policy.ts / registry.ts / test.
- `git diff --stat` -> only those 3 files + plan unit.
