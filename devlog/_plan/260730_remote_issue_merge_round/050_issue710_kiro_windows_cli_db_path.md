# 050 — Issue #710: Kiro login import misses the Windows Kiro CLI token DB path

Work-phase: WP1 of the two-issue loop entry (2026-07-30).
Class: C2 (single-module credential-discovery fix with a testable pure boundary).
Issue: https://github.com/lidge-jun/opencodex/issues/710
Reporter evidence quality: high — exact path, DB schema keys, and a working env-var workaround.

## Problem

On Windows, `ocx login kiro` does not import an existing Kiro CLI session. It reports that no
kiro-cli token was found and falls back to manual access-token paste, even though `kiro-cli whoami`
confirms an active login.

Root cause is credential discovery, not token parsing. `nativeKiroCliSessionEntries()` in
`src/oauth/kiro-credentials.ts:125` enumerates only two candidates:

- macOS: `~/Library/Application Support/kiro-cli/data.sqlite3`
- Linux: `~/.local/share/kiro-cli/data.sqlite3`

The Windows Kiro CLI stores its auth database at `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3`, which no
candidate covers. The reporter confirmed that DB has the expected shape (an `auth_kv` row keyed
`kirocli:social:token` and a `state` row keyed `api.codewhisperer.profile`), and that setting
`KIROCLI_DB_PATH` persistently makes the import succeed with no manual paste. That workaround proves
the reader and the token selector already work — only the default path list is short.

`sqliteEntries()` (line 135) consumes `nativeKiroCliSessionEntries()` and appends the Amazon Q and
SSO-cache import fallbacks. The `KIROCLI_DB_PATH` / `KIRO_CLI_DB_FILE` override short-circuits the
whole list, which is why the reporter's workaround bypasses the gap entirely.

## Revision history

- r1 (initial P).
- **r2 (post-audit, round 1)** — amended for reviewer blockers 1, 3, 4. See
  `070_audit_synthesis_round1.md` for the full synthesis. Changes: the existing Kiro test fixtures
  become platform-aware and isolate `LOCALAPPDATA` (blocker 1); the Windows branch resolves its base
  from `LOCALAPPDATA` -> `USERPROFILE` -> injected `homedir()` instead of `HOME`-first `userHome()`
  (blocker 3); the Windows-reachable repair message and the full `bun run test` OAuth gate come into
  scope (blocker 4).

## Design constraint discovered in P (do not skip)

`src/claude/desktop-3p-paths.ts` documents the governing constraint for this repo:

> Resolution is a pure function of (env, platform, home) so tests can exercise the win32 branch on
> any host: stubbing `process.platform` does NOT propagate to `os.platform()` under Bun, so a
> platform-sniffing implementation would be untestable in this repo.

A pure resolver taking `(env, platform, home)` is therefore the **preferred** design: it exercises
the win32 branch on any host with no platform stubbing at all. (Audit correction: `process.platform`
*is* stubbable in this repo — `tests/server-auth.test.ts:1838-1841` does it — so "impossible to
test" would be too strong. The pure resolver is still better: host-independent, and it also makes the
`LOCALAPPDATA`-absent fallback directly assertable.)

Follow the existing precedent: extract the pure resolver and keep a thin impure wrapper reading real
process state.

This also satisfies C-ACTIVATION-GROUNDING-01: the Windows branch is a conditional path absent from
the default happy path on our test hosts, so C must actually drive it and observe the produced
candidate, not merely report a green suite.

## Scope boundary

IN

- `src/oauth/kiro-credentials.ts` — add a pure, platform-parameterized native-session resolver and
  the Windows `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3` candidate; extend the `location` union with one
  new member for diagnostics.
- `tests/kiro-windows-cli-db-path.test.ts` (NEW) — drive the win32 branch through the pure resolver.
- `tests/kiro-oauth.test.ts`, `tests/kiro-review-regressions.test.ts`, `tests/kiro-adapter.test.ts`,
  `tests/oauth-refresh.test.ts` — make the kiro-cli fixture path platform-aware and isolate
  `LOCALAPPDATA` / `USERPROFILE` (blocker 1). Without this, these suites break on the Linux and
  Windows CI legs.
- `src/oauth/kiro.ts` — the snapshot-failure repair message (line ~286) must name the Windows store
  now that Windows can reach that error (blocker 4).

OUT

- The token/registration reader, `selectTokenRow`, snapshot/rollback logic, and the SSO cache path.
  The reporter's workaround proves these already work once the path is found.
- The `KIROCLI_DB_PATH` / `KIRO_CLI_DB_FILE` override semantics — unchanged, still short-circuits.
- Amazon Q and `~/.kiro/sso/cache.db` fallbacks — they stay `userHome()`-relative; this issue is
  strictly about the kiro-cli native store.
- `ocx login kiro` CLI copy and the manual-paste fallback UX.
- Kiro **installer** copy (`src/oauth/kiro.ts:340-351`) and the translated provider guides
  (`docs-site/.../providers.md:154-164`) still show the Unix installer. Deliberately deferred: that
  gap predates this change and is not created by it. Recorded as follow-up in D rather than dropped.

## File change map

### MODIFY `src/oauth/kiro-credentials.ts`

1. Extend the diagnostic location union (line ~42) with `"kiro-cli-windows-data"`:

```ts
  location: "kiro-creds-file" | "kiro-cli-db-env" | "kiro-cli-data" | "kiro-cli-linux-data"
    | "kiro-cli-windows-data" | "amazon-q-data" | "kiro-sso-cache";
```

2. Replace the hardcoded body of `nativeKiroCliSessionEntries()` with a pure resolver plus a thin
   process-reading wrapper. Windows uses `win32.join` so the produced path is a real Windows path
   even when the resolver runs on a POSIX host under test:

```ts
export type KiroCliNativeLocation = "kiro-cli-data" | "kiro-cli-linux-data" | "kiro-cli-windows-data";

export interface KiroCliNativeInputs {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
}

/**
 * Native kiro-cli session stores, as a pure function of (env, platform, home).
 *
 * Pure + parameterized following `src/claude/desktop-3p-paths.ts`: `process.platform` is stubbable
 * in this repo, but `os.platform()` does NOT follow it under Bun, so a pure resolver is the reliable
 * way to exercise the win32 branch (and its env fallbacks) on a macOS/Linux host.
 *
 * Windows: the official installer stores the auth DB at `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3`
 * (issue #710). When LOCALAPPDATA is unset/blank, fall back to `%USERPROFILE%\AppData\Local`, then
 * to the injected platform-native home. Deliberately NOT `userHome()`: that is `HOME || homedir()`
 * (line 68) and Windows shells (Git Bash / MSYS / CI) routinely export a POSIX-style `HOME`, which
 * would point this at a non-native path.
 */
export function resolveKiroCliNativeSessionEntries(
  inputs: KiroCliNativeInputs,
): Array<{ location: KiroCliNativeLocation; path: string }> {
  const { env, platform, home } = inputs;
  if (platform === "win32") {
    const base = env.LOCALAPPDATA?.trim()
      || (env.USERPROFILE?.trim() ? win32.join(env.USERPROFILE.trim(), "AppData", "Local") : "")
      || win32.join(home, "AppData", "Local");
    return [{ location: "kiro-cli-windows-data", path: win32.join(base, "Kiro-Cli", "data.sqlite3") }];
  }
  if (platform === "darwin") {
    return [{ location: "kiro-cli-data", path: join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3") }];
  }
  return [{ location: "kiro-cli-linux-data", path: join(home, ".local", "share", "kiro-cli", "data.sqlite3") }];
}
```

   The block above is the single authoritative resolver for the builder — it already carries the
   blocker-3 `LOCALAPPDATA` -> `USERPROFILE` -> injected-`home` chain. Do not implement any earlier
   draft of this function.

   The chain was executed on this host across six env shapes (set / empty string / whitespace /
   USERPROFILE-only / both unset / both empty). All six produced
   `C:\Users\u\AppData\Local\Kiro-Cli\data.sqlite3` — `?.trim()` plus `||` treats empty and blank
   values as absent, so there is no hole. Criterion 10 locks the middle rung.

   The impure wrapper keeps existing call sites unchanged and preserves the comment about which
   stores `kiro-cli logout` / `login` mutate (snapshot/rollback correctness). POSIX branches keep
   `userHome()` semantics so existing `HOME`-based fixtures keep working:

```ts
function nativeKiroCliSessionEntries(): Array<{ location: KiroCliNativeLocation; path: string }> {
  // Only the stores that `kiro-cli logout` / `kiro-cli login` themselves mutate. Import fallbacks
  // (Amazon Q / SSO cache) and KIROCLI_DB_PATH selectors must not be snapshotted for rollback.
  return resolveKiroCliNativeSessionEntries({
    env: process.env,
    platform: process.platform,
    // POSIX keeps HOME-first userHome() for fixture compatibility; win32 prefers
    // LOCALAPPDATA/USERPROFILE and only falls back to this platform-native home.
    home: process.platform === "win32" ? homedir() : userHome(),
  });
}
```

### MODIFY existing Kiro test fixtures (blocker 1 — required, not optional)

**Main-agent finding beyond the round-1 audit:** the reviewer named three suites; a full sweep
(`rg -n "Application Support.*kiro-cli" tests`) found **nine** hardcoded macOS fixture sites across
**four** files — including `tests/oauth-refresh.test.ts:53`, which the audit did not mention:

| File | Lines |
|---|---|
| `tests/kiro-oauth.test.ts` | 76, 92, 106, 287, 606, 637 |
| `tests/kiro-review-regressions.test.ts` | 45 |
| `tests/kiro-adapter.test.ts` | 55 |
| `tests/oauth-refresh.test.ts` | 53 |

They pass today on Linux only because the current resolver returns the macOS candidate everywhere.
After narrowing, every site must seed the **host** layout and isolate `LOCALAPPDATA` / `USERPROFILE`.
Because the sites are duplicated inline, extract one shared helper per suite rather than patching
nine literals independently:

```ts
function kiroCliDbDir(): string {
  if (process.platform === "win32") return join(tmp, "AppData", "Local", "Kiro-Cli");
  if (process.platform === "darwin") return join(tmp, "Library", "Application Support", "kiro-cli");
  return join(tmp, ".local", "share", "kiro-cli");
}
```

`beforeEach` sets `process.env.LOCALAPPDATA = join(tmp, "AppData", "Local")` and `USERPROFILE = tmp`;
`afterEach` restores both to their original values (same save/restore shape the suites already use
for `HOME` at `tests/kiro-oauth.test.ts:33-49`). Without the isolation a Windows runner would read
the real user profile — a genuine test-pollution risk, not a hypothetical.

`tests/kiro-adapter.test.ts:54` documents its intent as "isolate: empty HOME so no kiro-cli SQLite is
read". On Windows an empty `HOME` no longer achieves that once the resolver prefers
`LOCALAPPDATA`/`USERPROFILE`, so that suite needs the same env isolation to preserve its existing
guarantee. Verify the assertion still means what it claims after the change rather than only that it
still passes.

### MODIFY `src/oauth/kiro.ts` (blocker 4)

The snapshot-failure repair message at line ~286 lists only the macOS and Linux stores. A Windows
user can now reach that error, so add the Windows path to the enumeration. Copy only; no logic
change.

3. Add `win32` to the existing `node:path` import.

### Decision recorded in P: per-platform, not additive

The previous list returned BOTH the macOS and Linux candidates on every platform. Returning one
candidate per platform is the correct shape here because `nativeKiroCliSessionEntries()` also feeds
snapshot/rollback (its own comment says so): snapshotting a foreign platform's store would be wrong,
and a non-existent path only wastes a stat today. Existing behavior is preserved where it matters —
each host still resolves its own real store — and no test asserts cross-platform candidates.

Alternative considered and rejected: append the Windows entry to the existing two-element array.
Simpler diff, but it keeps platform-foreign paths in the snapshot candidate set and leaves the
win32 branch untestable, failing C-ACTIVATION-GROUNDING-01.

### NEW `tests/kiro-windows-cli-db-path.test.ts`

Drives the pure resolver — no `process.platform` stubbing, so it runs on every CI leg.

## Accept criteria

| # | Scenario | Activation | Observable proof |
|---|----------|-----------|------------------|
| 1 | win32 + LOCALAPPDATA set | `resolveKiroCliNativeSessionEntries({platform:"win32", env:{LOCALAPPDATA:"C:\\Users\\u\\AppData\\Local"}, home})` | Exactly one entry, `location: "kiro-cli-windows-data"`, path `C:\Users\u\AppData\Local\Kiro-Cli\data.sqlite3` (the reporter's exact path) |
| 2 | win32 + LOCALAPPDATA unset | same with `env: {}` | Falls back to `<home>\AppData\Local\Kiro-Cli\data.sqlite3`; no crash, no empty-prefix path |
| 3 | darwin unchanged | `platform:"darwin"` | `~/Library/Application Support/kiro-cli/data.sqlite3`, `location: "kiro-cli-data"` |
| 4 | linux unchanged | `platform:"linux"` | `~/.local/share/kiro-cli/data.sqlite3`, `location: "kiro-cli-linux-data"` |
| 5 | env override still wins | `inspectKiroCliSqliteSources()` with `KIROCLI_DB_PATH` set to a seeded DB, plus a default-layout DB also seeded | Diagnostics report the single `kiro-cli-db-env` location and the default-layout DB does NOT win — asserted through public behavior, NOT by exporting private `sqliteEntries()`. Pattern: `tests/kiro-oauth.test.ts:142-152` |
| 6 | Typecheck + existing Kiro suites | `bun x tsc --noEmit`; `bun test tests/kiro-oauth.test.ts tests/kiro-review-regressions.test.ts tests/kiro-adapter.test.ts` | Clean tsc; existing suites still pass on this host after the fixture change (union widening breaks no exhaustive switch) |
| 7 | Windows repair copy reachable and correct | Read the amended message in `src/oauth/kiro.ts` | The snapshot-failure text names the Windows store alongside macOS/Linux |
| 8 | Full OAuth gate (`src/AGENTS.md`) | `bun run test` | Whole suite green — the fixture change touches shared Kiro helpers, so targeted runs are not sufficient |
| 9 | No hardcoded macOS kiro-cli fixture path remains | `rg -n "Application Support.*kiro-cli" tests` | Zero hits outside an explicitly darwin-branched helper |
| 10 | win32 `USERPROFILE` rung activates (C-ACTIVATION-GROUNDING-01) | `resolveKiroCliNativeSessionEntries({platform:"win32", env:{LOCALAPPDATA:"   ", USERPROFILE:"C:\\Users\\u"}, home:"D:\\injected"})` | `C:\Users\u\AppData\Local\Kiro-Cli\data.sqlite3` — proves the middle rung fires and that blank `LOCALAPPDATA` falls through rather than producing a `\AppData\Local` path |

Every Windows base rung now has its own criterion: `LOCALAPPDATA` (1), `USERPROFILE` (10), injected
home (2). No rung ships without activation proof.

## Verification commands (C phase)

```
bun x tsc --noEmit
bun test tests/kiro-windows-cli-db-path.test.ts
bun test tests/kiro-oauth.test.ts tests/kiro-review-regressions.test.ts tests/kiro-adapter.test.ts tests/oauth-refresh.test.ts
bun run test
bun run privacy:scan
```

`bun run test` is mandatory here, not optional: `src/AGENTS.md` requires the full suite for
OAuth-surface changes, and this change edits shared Kiro fixture helpers.

## SoT sync target (SOT-SYNC-01)

No `structure/` invariant documents Kiro credential-store paths (checked in P: `structure/` has no
kiro path table). The code comment on the resolver carries the provenance. No SoT patch required;
noted in D.

## Risk notes

- Widening the `location` union is source-compatible for producers; a consumer doing an exhaustive
  switch over locations would break. Criterion 6 covers this with tsc.
- No credential values, tokens, or account identifiers enter logs or tests. Test paths are synthetic
  (`C:\Users\u\...`). `privacy:scan` gates this.
