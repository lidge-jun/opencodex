# 00 - Interactive Update Notify Prompt Design

Goal: when a newer published version of opencodex exists, surface a one-screen
update prompt on interactive `ocx start` so users stop silently running stale
versions. Server/daemon users must never see it. Reference implementation is
codex-rs (the native Codex CLI), adapted to opencodex's npm/bun distribution
and existing `src/update.ts` helpers.

This document is design only. No code is written in this phase.

## Part 1 - Easy explanation

Today a user can run an old opencodex for weeks without noticing a release.
codex-rs solves this with a small startup prompt offering three choices:

1. Update now - run the global install, then exit and ask the user to
   re-run `ocx start`.
2. Skip - continue this run, ask again next start.
3. Skip until next version - remember this exact version and stay quiet until
   a strictly newer one appears.

The hard rule from the user: this only ever appears in an interactive TTY.
People who run opencodex as a background service or under a process supervisor
must never be interrupted.

## Reference: codex-rs logic (what we are copying)

Files under `~/Developer/codex/121_openai-codex/codex-rs/tui/src/`:

- `update_prompt.rs` - the 3-option modal, key handling (`1/2/3`, arrows,
  Enter, Esc/Ctrl-C = Skip), and the `UpdatePromptOutcome::{Continue,RunUpdate}`
  return that defers the actual install until after the TUI exits.
- `updates.rs` - caches `version.json` as
  `{ latest_version, last_checked_at, dismissed_version }` in `codex_home`.
  Refreshes in the background only when the cache is older than 20 hours, never
  blocking startup; this run reads the cached value and the next run shows the
  banner. `get_upgrade_version_for_popup` suppresses the popup when
  `dismissed_version == latest`. `dismiss_version` records the current latest.
- `update_versions.rs` - `is_newer` parses only `maj.min.pat`; any prerelease
  suffix yields `None` (treated as "not newer"). `is_source_build_version`
  gates out `0.0.0` source builds.
- `update_action.rs` - maps the detected install method (npm/bun/brew/
  standalone) to the exact upgrade command shown and run.

## Current opencodex shape (what we already have)

- `src/update.ts`
  - `detectInstall()` -> `"bun" | "npm" | "source"` by inspecting the module
    path (`node_modules`, `.bun`).
  - `currentVersion()` reads the bundled `package.json` version.
  - `updateTag(current)` -> `"preview"` when current contains `-preview.`,
    else `"latest"` (also honors an explicit `--tag`).
  - `latestVersion(tag)` -> `npm view <pkg>@<tag> version` via blocking
    `spawnSync` (12s timeout), `null` on failure.
  - `runUpdate()` performs the global install (`stdio:"inherit"`, 180s timeout)
    and afterwards repairs the codex shim / advises service refresh.
- `src/star-prompt.ts` - the precedent for an interactive-only prompt:
  - Triple guard `process.env.OCX_SERVICE || !process.stdin.isTTY ||
    !process.stdout.isTTY` (star-prompt.ts:32).
  - Marker file under `getConfigDir()` (star-prompt.ts:33).
  - `createInterface` + try/finally `rl.close()`, whole body wrapped so it
    never disrupts startup (star-prompt.ts:42).
- `src/cli.ts`
  - `handleStart()` builds the listen port (`chooseListenPort`), then
    `startServer(port)` (cli.ts:138), then `writePid` / `writeRuntimePort`
    (cli.ts:142-147), and only later calls `maybeShowStarPrompt()` (cli.ts:193)
    before blocking forever.
  - `handleEnsure()` spawns a child `start` with `OCX_SERVICE:"1"`
    (cli.ts:216), so the child start is correctly treated as a service.
  - `gui` spawns `start` with the parent env (no `OCX_SERVICE`) but
    `stdio:"ignore"` (cli.ts:416), i.e. not a TTY.
- `src/config.ts`
  - `getConfigDir()` resolves `~/.opencodex` (or `OPENCODEX_HOME`), hardened to
    `0700`; already holds pid, runtime-port, accounts, usage, service state.
  - `atomicWriteFile` (config.ts:13) for temp+rename writes.
- `src/service.ts` - service-spawned `start` also sets `OCX_SERVICE=1`.

## Subagent design review - decisions

A design-review subagent (explorer) walked the code; conclusions adopted:

### Insertion point: `ocx start` only, before `startServer`

The prompt belongs in `handleStart`, but it must move earlier than the current
star-prompt call. Because "Update now" runs a global install and then exits,
the prompt has to fire before `startServer(port)` / `writePid`
(cli.ts:138-147). Otherwise we would overwrite our own running global binary
while a daemon holds the port and PID. Order becomes: parse args -> reconcile
-> (interactive update prompt) -> choose port -> start server. "Update now"
runs `runUpdate()` then `process.exit`, advising re-run of `ocx start`.

`ocx ensure` does NOT show the prompt. The child it spawns already carries
`OCX_SERVICE:"1"` and is filtered out, but `ensure` itself is also the
codex-shim autostart hot path, not a sit-and-watch session. Notifications are
restricted to foreground `ocx start`, matching codex-rs's "once at TUI start".

### Order vs the star prompt

Keep update after star in spirit, but since the update prompt moves before
`startServer` and the star prompt currently sits after it, they no longer share
one call site. The star prompt is lifetime-once; the update prompt repeats per
version. To avoid stacking two prompts on a user's very first run, skip the
update prompt when the star marker is absent (first run), and begin evaluating
updates from the next start. (Open question O1 below.)

### Version comparison: split by release channel

codex-rs treats any prerelease as "not newer", which would mean preview users
never get notified (`2.7.0-preview.3` vs `2.7.0-preview.5` both fail to parse).
Fix by comparing within the channel `updateTag` already selects:

- latest channel: codex-rs rule unchanged - compare `maj.min.pat`, ignore
  prereleases (never push a preview onto a stable user).
- preview channel: a separate comparator that parses the trailing
  `-preview.N` into a 4th component and compares tuples; if base semver differs,
  compare base, else compare the preview number.

Do not try to make one comparator serve both. `dismissed_version` stays a plain
string equality against the channel-specific `latest`, so channels cannot
cross-contaminate.

### Cache file: `~/.opencodex/version.json`

Stored under `getConfigDir()`, written with `atomicWriteFile` (concurrent
starts are possible). Format mirrors codex-rs plus a channel tag:

```json
{ "latest_version": "2.7.0", "last_checked_at": "<RFC3339>",
  "dismissed_version": "2.6.9", "tag": "latest" }
```

On read, if `tag` differs from the current `updateTag`, ignore the cache and
re-fetch (handles stable<->preview switches). No gitignore concern: this lives
in the home dir, not the repo. `uninstall` already `rmSync`s the whole config
dir, so no extra cleanup is needed.

### 20-hour refresh: detached helper process

`handleStart` blocks forever as a daemon, so an in-process async fetch risks
leaked handles/timers. Prefer a hidden subcommand (e.g. `__refresh-version`)
spawned `detached`, `stdio:"ignore"`, `.unref()` - it runs one `npm view`
(or a `fetch` to the npm registry JSON API
`https://registry.npmjs.org/@bitkyc08%2Fopencodex`), writes `version.json` via
`atomicWriteFile`, and exits. This run only reads the cache to decide whether
to prompt; the refreshed value shows up on a later start (same model as
codex-rs). Crucially, only update `last_checked_at` on success so a failed
fetch retries next start.

### "Update now" install: reuse `runUpdate`, then exit

Reuse `runUpdate()` but only because the prompt now fires before the server is
up. Flow: prompt -> if "Update now", call `runUpdate()` -> `process.exit(0)`
with "Restart: ocx start". This matches codex-rs deferring the install until
after the UI closes, and sidesteps overwriting a live global binary or a held
PID/port entirely.

### Edge cases to honor

- `detectInstall() === "source"`: skip entirely (no global install to upgrade;
  also avoids a modal every `bun run src/cli.ts` in dev). This is the #1 gate,
  equivalent to codex-rs `is_source_build_version`.
- npm missing / network failure: best-effort, never dirty the cache; do not
  advance `last_checked_at` on failure.
- Non-TTY entry points: use the full star-prompt triple guard, not just
  `OCX_SERVICE`. The `gui`-spawned start lacks `OCX_SERVICE` but is
  `stdio:"ignore"`, so the `!isTTY` checks catch it.
- readline hygiene: `createInterface` + try/finally `rl.close()`, whole body in
  try/catch so nothing blocks startup (mirror star-prompt).

## Proposed module shape

- New `src/update-notify.ts`:
  - `maybeShowUpdatePrompt(): Promise<void>` - the guarded entry called from
    `handleStart` before `startServer`. Reads cache, decides, renders the
    3-option prompt, handles selection, may call `runUpdate()` + exit.
  - cache read/write helpers (`readVersionCache`, `writeVersionCache`) over
    `getConfigDir()/version.json` with `atomicWriteFile`.
  - channel-aware `isNewer(latest, current, tag)` and a `dismiss(version)`.
  - `triggerBackgroundRefreshIfStale()` - spawns the detached refresh.
- `src/cli.ts`:
  - call `maybeShowUpdatePrompt()` in `handleStart` before `chooseListenPort` /
    `startServer`.
  - add hidden `__refresh-version` subcommand that writes the cache and exits.
- `src/update.ts`: factor out the channel parsing so the prompt and `runUpdate`
  share one source of truth for tag and command string.

## Resolved decisions (was open questions)

- O1 -> RESOLVED: skip the update prompt on the very first run (when the star
  marker is absent) and begin evaluating updates from the next start. Avoids
  stacking two prompts on a fresh install, which is also nearly always already
  on the latest version.
- O2 -> RESOLVED: reuse the existing `npm view` path (`latestVersion` in
  `update.ts`) for the background refresh. Lowest verification cost, consistent
  with the existing code, and the detached helper makes its blocking nature a
  non-issue. If npm-less environments become a real concern later, switching to
  a registry `fetch` is a contained follow-up.
- O3 -> RESOLVED: when on the preview channel, a stable release with a strictly
  higher base `maj.min.pat` than the current preview's base counts as newer and
  is surfaced, so preview users naturally rejoin stable. A stable release whose
  base equals the current preview's base (e.g. `2.7.0` vs `2.7.0-preview.5`) is
  NOT treated as newer, to avoid a downgrade-flavored nag. Within the same base,
  preview-vs-preview compares the trailing `-preview.N`.

## Verification plan (for the implementation phase)

- `bun x tsc --noEmit`.
- New `tests/update-notify.test.ts`: channel-aware `isNewer` (stable vs
  preview), dismiss suppression, source-build skip, non-TTY/`OCX_SERVICE`
  guard, stale-cache trigger, cache tag mismatch invalidation.
- Manual: confirm no prompt under `OCX_SERVICE=1`, piped stdout, `ocx ensure`,
  and `gui`-spawned start; confirm prompt under a real interactive `ocx start`
  with a stubbed cache.

## Non-goals

- No auto-update without consent.
- No prompt outside foreground `ocx start` (explicitly not in `ensure`,
  `gui`, service, or any non-TTY run).
- No change to the actual upgrade mechanics in `runUpdate()` beyond sharing
  channel/command helpers.
