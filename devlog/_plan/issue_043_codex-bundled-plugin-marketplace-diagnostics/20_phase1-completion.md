# Issue #43 - Phase 1 completion: read-only bundled-plugin diagnostic

Implements Phase 1 of `10_plan.md` under cli-jaw dev/goal/pabcd conventions
(C2-C3, STANDARD verification tier). Plan audited by a gpt-5.5 subagent
(verdict GO-WITH-CHANGES); corrections were applied before Build.

## Audit corrections applied (from the gpt-5.5 plan audit)

- Marketplace manifest filenames pinned to the exact codex-rs set:
  `.agents/plugins/marketplace.json` and `.claude-plugin/marketplace.json`
  (codex-rs core-plugins/src/marketplace.rs:19).
- App-package path detection DEFERRED. Phase 1 does not guess the current Codex
  app dir; it reads the registered `[marketplaces.openai-bundled]` `source` and
  checks whether that path resolves to a manifest. "current vs registered path"
  is left for a later phase that needs a reliable Windows app locator.
- Path/username masking added as a SHARED helper in `src/redact.ts`
  (`redactUserPath`), not a private copy.
- `codexPlugins` added as an optional top-level `CliStatusJson` field next to
  `codexShim`; one human status line prints only when applicable (Windows).
- Spawned status test sets `CODEX_HOME` to a temp dir (load-time const), per the
  codex-journal test pattern.

## Changes

- `src/codex-plugins-doctor.ts` (NEW): `diagnoseCodexBundledPlugins({platform?,
  configPath?})`. Read-only. On non-Windows returns `applicable:false`
  (`not_windows`); unreadable config returns `applicable:false`
  (`config_unreadable`). Otherwise parses `[marketplaces.openai-bundled]`,
  resolves whether a `local` `source` holds a supported manifest, and reports
  `stale`, `present`, `resolvesToManifest`, bundled-plugin presence, and a
  suggested (never executed) repair command. Source path is username-masked.
- `src/redact.ts` (MODIFY): `redactUserPath()` masks `C:\Users\<name>` and
  `/Users|/home/<name>`, then runs `redactSecretString`.
- `src/cli-status.ts` (MODIFY): `CodexPluginsDiagnostic` added to `CliStatusJson`
  as `codexPlugins`; computed in `collectStatus()` via
  `diagnoseCodexBundledPlugins()`.
- `src/cli.ts` (MODIFY): `handleStatus()` prints one diagnostic line + suggested
  repair only when `applicable` (Windows), so macOS/Linux output is unchanged.
- `tests/codex-plugins-doctor.test.ts` (NEW): 8 tests (platform-injected unit
  cases + a spawned `ocx status --json` read-only case).

## Non-mutation guarantee

The diagnostic only reads files (`readFileSync`) and resolves paths
(`existsSync`). No write, no `atomicWriteFile`, no `spawn`/`exec`, no
`marketplace add`. It is reachable ONLY from `collectStatus()` (status), never
from `handleEnsure()`.

## Verification

- `bun x tsc --noEmit`: clean (exit 0).
- `bun test tests/codex-plugins-doctor.test.ts`: 8 pass / 0 fail.
- `bun test tests/cli-status-json.test.ts`: 6 pass / 0 fail (existing
  secret-safety + read-only assertions still hold with the new block).
- Full suite: 1466 pass / 71 fail / 13 errors. The 71 fail + 13 errors are the
  pre-existing baseline (cursor-agent / ACP logger / cursor-bridge), unrelated
  to this change; this work added 8 passing tests (1458 -> 1466 pass).

## Deferred (future phases)

- Windows Codex app-package locator + "current bundled path differs from
  registered path" signal (needs a reliable app-dir resolver).
- Phase 2 opt-in `ocx repair codex-plugins` (explicit, mutating) — separate PR.

## Independent verification (gpt-5.5 subagent) + bug fix

A gpt-5.5 verifier ran the Check phase and initially returned FAIL on one real
bug:

- P2 (fixed): the `[marketplaces.openai-bundled]` header regex required the line
  to end after `]`, so a valid TOML header with a trailing inline comment
  (`[marketplaces.openai-bundled] # comment`) was missed and the table reported
  `present:false`. Fixed by allowing an optional trailing `# ...` on the header
  line in `src/codex-plugins-doctor.ts` (`readMarketplaceTable`), with a new
  regression test ("parses a table header with a trailing inline comment").

All other checks passed: read-only/non-mutation invariant (only `readFileSync` +
`existsSync`; reachable only from `collectStatus()`, never `handleEnsure()`),
manifest filenames match codex-rs, secret-safety holds (source username-masked),
and no new full-suite failures vs the baseline. Re-verified after the fix:
`bun x tsc --noEmit` clean, `bun test tests/codex-plugins-doctor.test.ts`
9 pass / 0 fail.

### Second verification round: CRLF bug (gpt-5.5)

A re-run of the same gpt-5.5 verifier found a second, higher-impact bug via
adversarial input:

- P2 (fixed): CRLF line endings + inline comments. `readMarketplaceTable` split
  on `"\n"`, leaving a trailing `\r` that defeated the `$`-anchored
  `(?:#.*)?$` regexes (`.` does not match `\r`). On Windows (CRLF is native,
  exactly this diagnostic's target platform) a config like
  `source_type = "local"  # t\r\n` parsed `sourceType`/`source` as null, so
  `isLocal` collapsed to false and a STALE marketplace was reported as
  "ok ... resolves" — a false healthy. Fixed by splitting on `/\r?\n/` in
  `readMarketplaceTable`. Added two CRLF regression tests (header-comment and
  key/value-comment variants).

Other adversarial probes passed: tab whitespace, tab-separated `key = value`,
`#` inside a quoted path value (`C:\Apps\C#\bundled` preserved), double-quoted
header name, and a preceding `[marketplaces.other]` not bleeding into the read.

Re-verified after the fix: `bun x tsc --noEmit` clean,
`bun test tests/codex-plugins-doctor.test.ts` 11 pass / 0 fail.

### Third verification round: secret-leak + malformed-entry (gpt-5.5)

A thorough requirement-by-requirement verification (gpt-5.5 subagent) returned
NOT-COMPLETE with two valid gaps, both now fixed (commit 84f6db7):

- Secret-safety (was CONTRADICTED): a configured `source` path segment such as
  `\token\` survived `redactUserPath` (which only masked the username segment)
  and surfaced a test-forbidden substring in `status --json`. `redactUserPath`
  now also masks path segments whose name looks sensitive
  (token/secret/password/api-key/credential/email) before `redactSecretString`.
- Stale logic (was WEAK): a present-but-not-local
  `[marketplaces.openai-bundled]` entry (wrong `source_type` or empty `source`)
  was summarized as "ok ... resolves" despite `resolvesToManifest:false`. Added
  a `malformed` branch so it now reports "present but not a usable local
  source" instead of a false healthy.

Regression tests added: sensitive-path-segment masking and present-but-not-local
summary. Re-verified: `bun x tsc --noEmit` clean; full `bun test`
1471 pass / 71 fail / 13 errors (baseline unchanged, no new failures).

### Fourth round: live locator + current-vs-registered path mismatch (commit 0254b66)

Phase 1 originally reported only whether the *registered*
`[marketplaces.openai-bundled]` entry still resolved to a manifest. The issue's
core symptom, though, is that a Windows app update moves the bundled marketplace
to a *new* versioned path while the config still points at the old one. To catch
that directly we added `locateCurrentBundledMarketplace({env, listDir,
isManifestRoot, mtimeOf})`: it scans the usual Windows bases (`LOCALAPPDATA`,
`PROGRAMFILES`, etc.), finds the newest app directory that actually contains a
bundled marketplace manifest, and returns that path. The fs surface is injected
so the scan stays read-only and is fully testable without a real Windows tree.

`diagnoseCodexBundledPlugins` now accepts an optional `locateCurrent` hook and
reports two new fields: `currentBundledPath` (the live location the locator
found) and `pathMismatch` (true when the registered `source` and the live path
disagree). When they diverge, `suggestedRepair` names the current path so the
user can re-add it manually, keeping the diagnostic read-only by design.

Re-verified after this round: `bun x tsc --noEmit` clean;
`bun test tests/codex-plugins-doctor.test.ts` 17 pass / 0 fail; full `bun test`
1475 pass / 71 fail / 13 errors (the 71 fail / 13 errors are the pre-existing
baseline in unrelated cursor-agent/ACP suites, unchanged by this work).
