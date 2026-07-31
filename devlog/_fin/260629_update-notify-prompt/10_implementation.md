# 10 - Implementation Plan: Interactive Update Notify Prompt

Implements `00_design.md` with O1/O2/O3 resolved (skip-on-first-run, reuse
`npm view`, preview users see strictly-higher-base stable). Design only here
too in the sense of a precise diff plan; code lands in the work phase.

## Outcome

On an interactive `ocx start`, if a newer published version exists for the
user's channel, show a 3-option prompt (Update now / Skip / Skip until next
version) before the server starts. Never shown to service/daemon/non-TTY runs
or source checkouts.

## Files

### NEW `src/update-notify.ts`

Self-contained module; never throws out to startup.

- Types
  - `type Channel = "latest" | "preview"`.
  - `interface VersionCache { latest_version: string; last_checked_at: string;
    dismissed_version?: string; tag: Channel }`.
- Cache I/O over `getConfigDir()/version.json`
  - `readVersionCache(): VersionCache | null` - parse, return null on any error
    or when `tag` !== current channel (stale-channel invalidation).
  - `writeVersionCache(c: VersionCache): void` - `atomicWriteFile`, best-effort.
- Comparison (channel-aware), exported for tests
  - `parseStable(v): [num,num,num] | null` - `maj.min.pat`, ignores any
    suffix-bearing string by returning null (codex-rs parity).
  - `parsePreview(v): [num,num,num,num] | null` - base plus trailing
    `-preview.N`; non-preview strings return null.
  - `isNewer(latest, current, channel): boolean`
    - latest channel: both via `parseStable`; `latest > current` tuple compare.
    - preview channel: if `latest` is stable (parseStable ok) and `current` is
      preview, compare `latestBase > currentBase` (strictly-higher base only;
      equal base is NOT newer - O3). If both preview, compare 4-tuples. Mixed
      unparseable -> false.
  - `isSourceBuild(v): boolean` - `v === "0.0.0"` (parity gate; redundant with
    detectInstall but cheap).
- Guard + decide
  - `shouldConsider(): { channel: Channel; current: string } | null` - returns
    null when: `detectInstall() === "source"`, source build version, the star
    marker is absent (O1 first-run skip), or the triple TTY/service guard fails
    (`process.env.OCX_SERVICE || !process.stdin.isTTY || !process.stdout.isTTY`).
  - `getUpgradeVersionForPopup(cache, current, channel): string | null` -
    returns cached `latest_version` only if `isNewer` and it is not the
    `dismissed_version`.
- Background refresh (O2)
  - `triggerBackgroundRefreshIfStale(channel): void` - if no cache or
    `last_checked_at` older than 20h, spawn `process.execPath` with
    `[process.argv[1], "__refresh-version", channel]`, `detached`,
    `stdio:"ignore"`, `.unref()`. Fire-and-forget.
  - `refreshVersionCache(channel): Promise<void>` - the body the hidden
    subcommand runs: `latestVersion(channel)` (reuse `update.ts`); on success
    write cache with fresh `last_checked_at` preserving `dismissed_version`; on
    failure do NOT advance `last_checked_at` (leave cache as-is) so the next
    start retries.
- Prompt
  - `maybeShowUpdatePrompt(): Promise<void>` - the single entry called from
    `handleStart`. Steps: `shouldConsider()` -> if null, still call
    `triggerBackgroundRefreshIfStale` when channel known, return. Else read
    cache, `triggerBackgroundRefreshIfStale`, compute popup version; if none,
    return. Render the 3 options via `readline` (mirror star-prompt: numbered
    `1/2/3`, default Enter = Update now to match codex-rs highlight, try/finally
    `rl.close()`, whole body try/catch).
    - `1`/Enter -> Update now: `await runUpdate()` then a "Restart: ocx start"
      line and `process.exit(0)`.
    - `2` -> Skip: return (no cache change).
    - `3` -> Skip until next version: set `dismissed_version = latest`, write
      cache, return.

### MODIFY `src/update.ts`

- Export the helpers the notify module reuses so there is one source of truth:
  `detectInstall`, `currentVersion`, `updateTag` (-> channel), `latestVersion`,
  and the install command string used in the "runs `...`" label. Keep
  `runUpdate` as-is; just reuse its building blocks.

### MODIFY `src/cli.ts`

- In `handleStart`, call `await maybeShowUpdatePrompt()` BEFORE
  `chooseListenPort` / `startServer` (cli.ts:138). This is the critical
  ordering from the review: the prompt must run before any port/PID is taken so
  "Update now" can install and exit cleanly.
- Leave the existing `maybeShowStarPrompt()` call (cli.ts:193) where it is; the
  update prompt's first-run skip (O1) keys off the same star marker, so star
  effectively goes first across runs.
- Add a hidden subcommand `__refresh-version` in the top-level `switch`:
  `await refreshVersionCache(args[1] as Channel)` then return/exit. Not shown in
  help. Guarded so it only ever writes the cache.
- Do NOT touch `handleEnsure`: its child carries `OCX_SERVICE=1`, and ensure
  itself must stay silent (autostart hot path).

## Prompt copy (opencodex wording)

```
  ✨ Update available!  <current> -> <latest>

  Release notes: https://github.com/lidge-jun/opencodex/releases/latest

  1) Update now (runs `npm install -g @bitkyc08/opencodex@latest`)
  2) Skip
  3) Skip until next version

  [1/2/3] (default 1):
```

Command string and `@latest`/`@preview` suffix come from the channel, matching
`runUpdate`'s actual install command so the label never lies.

## Tests - `tests/update-notify.test.ts`

- `isNewer` latest channel: `2.7.0 > 2.6.4` true; `2.6.4` vs `2.6.4` false;
  prerelease latest ignored on stable channel.
- `isNewer` preview channel: `2.7.0-preview.5 > 2.7.0-preview.3` true; equal
  false; stable `2.8.0` vs preview `2.7.0-preview.3` true (higher base, O3);
  stable `2.7.0` vs preview `2.7.0-preview.5` false (equal base, O3).
- dismiss suppression: `dismissed_version === latest` -> no popup; a strictly
  newer latest re-surfaces.
- source build / `detectInstall==="source"` -> `shouldConsider` null.
- guard: `OCX_SERVICE` set, or non-TTY stdin/stdout -> null.
- first-run skip (O1): star marker absent -> null even when newer exists.
- cache tag mismatch -> `readVersionCache` returns null (re-fetch path).
- stale `last_checked_at` (>20h) triggers refresh spawn; fresh does not
  (assert via injected spawn stub / seam).

Note: prompt rendering and `process.exit` are side-effecting; structure
`maybeShowUpdatePrompt` so the decision logic is unit-testable without a real
TTY (pure helpers exported; the readline shell stays thin).

## Verification

- `bun x tsc --noEmit`.
- `bun test tests/update-notify.test.ts`.
- Manual matrix: `OCX_SERVICE=1 ocx start` (silent), `ocx start | cat` (silent,
  non-TTY), `ocx ensure` (silent), `ocx gui` spawn (silent), interactive
  `ocx start` with a stubbed newer cache (prompt shows), pick 3 then restart
  (stays silent), bump cache to a higher version (prompt returns).

## Commit

`feat(update): interactive update-available prompt on ocx start`

## Risk

STANDARD. Touches the startup path. Mitigated by: hard source-build/TTY guards,
full try/catch so it can never block startup, prompt fires before any port/PID
is taken, and no change to the existing upgrade mechanics.
