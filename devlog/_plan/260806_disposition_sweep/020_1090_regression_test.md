# 020 — wp2: #1090 external-provider config preservation test (plan revised at P)

## Finding (revised with new evidence)

The "absorbed" hypothesis is NOT proven. The external-provider guard
(`externalCodexModelProvider`, `src/codex/inject.ts:74`; early return at
`inject.ts:636-658`) landed in `b3d1bc67f`, which IS an ancestor of
`v2.10.0` — the exact version the reporter ran. Yet the reporter observed
`model_provider = "deepseek"` being rewritten to `"openai"` by `ocx sync`
on Windows. So either (a) a path reachable from `ocx sync`
(`syncModelsToCodex` → `injectCodexConfig`, `src/codex/sync.ts:58,110`)
bypasses the guard under some input shape, or (b) the reporter's real
config differed from the redacted one (e.g. a `profile` key overriding the
root provider — `resolveEffectiveProjectModelProvider` prefers the profile
section), or (c) a Windows-specific parse issue (CRLF handled at
`dominantEol`, but the guard runs on `rawContent` BEFORE EOL
normalization — `parseTomlDocument` splits on `"\n"`, leaving `\r` at
value ends; the kv regex `[^\s#]+` excludes `\r` via `\s`, needs proof).

Existing coverage: `tests/codex-inject-integration.test.ts:366` proves the
generic external-provider case byte-for-byte (LF, `custom` provider). It
does NOT cover: CRLF Windows files, the reporter's exact shape (deepseek +
`[model_providers.opencodex]` table coexisting), or a root provider with
quoted values and a `windows` table.

Attempt 3 (`model_provider = "opencodex"`) re-runs injection by design
(`inject.ts:701-747`) — routed mode; not a defect, but the report's claim
"model and model_provider lines removed" during that path is expected
behavior that deserves explanation, not denial.

## Work

1. Add a reporter-shape regression test in
   `tests/codex-inject-integration.test.ts`: CRLF Windows-style config with
   `model_provider = "deepseek"`, `model = "deepseek-v4-flash"`,
   `[model_providers.opencodex]` table, and `[windows]` section — must
   survive `injectCodexConfig()` byte-for-byte (same assertion style as the
   existing :366 test).
2. If the test PASSES: the guard holds for the reported shape on current
   dev; disposition = status comment on #1090 (attempt 1 guarded since
   v2.7.36 and covered by the new test; attempt 3 by-design with
   explanation; ask reporter for their real config/profile lines if still
   reproducible on ≥ current release) — keep OPEN pending reporter
   confirmation, per audit rule (close only if fully proven).
3. If the test FAILS: real defect on dev; record RCA, fix in this sweep
   branch is out of scope creep — file the failing test + status comment,
   defer the fix decision to the user.
4. `bun run typecheck` + focused test file green (or red with RCA).

## Ledger

| Step | Evidence |
|------|----------|
| Regression test added | `tests/codex-inject-integration.test.ts` "#1090: CRLF Windows config..." — commit `b63e86a8b` |
| Test PASSES on dev | 23 pass / 0 fail (full file); guard holds for reporter shape |
| Red ablation | guard neutered locally → 1 fail; restored → pass (proves non-vacuous) |
| typecheck | `bun x tsc --noEmit` clean |
| Disposition | #1090 kept OPEN — status comment 5199554901: attempt-1 guarded + tested, profile-masking question to reporter, attempt-3 by-design, symptom tracked in #1091 |
| terra audit | PASS (reviewer 019fd4cd): CRLF cannot defeat guard; no sync bypass; profile masking plausible explanation |
