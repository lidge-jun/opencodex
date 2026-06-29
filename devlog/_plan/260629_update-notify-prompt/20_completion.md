# 20 - Completion: Interactive Update Notify Prompt

Implemented per `10_implementation.md` with O1/O2/O3 as resolved in
`00_design.md`.

## Changes

- `src/update.ts`: exported the shared helpers (`detectInstall`,
  `currentVersion`, `updateTag` now returns a `Channel`, `latestVersion`, `PKG`)
  and added `updateCommand` / `updateCommandStr`. `runUpdate` now builds its
  install command via `updateCommand`, removing the duplicated arg logic.
- `src/star-prompt.ts`: added `hasStarPromptRun()` so the update prompt can
  yield on the user's first run (O1) without duplicating the marker name.
- `src/update-notify.ts` (new): cache I/O over `~/.opencodex/version.json`
  (`atomicWriteFile`, channel-tagged, stale-channel invalidation), channel-aware
  `isNewer` (latest = maj.min.pat only; preview = -preview.N, plus
  strictly-higher-base stable counts as newer per O3), `shouldConsider` guard
  (source build, interactive triple guard, first-run yield),
  `getUpgradeVersionForPopup` (dismiss-aware), detached 20h background refresh
  via the hidden `__refresh-version` subcommand, and `maybeShowUpdatePrompt`
  (3-option readline prompt; "Update now" runs `runUpdate()` then exits).
- `src/cli.ts`: call `maybeShowUpdatePrompt()` in `handleStart` BEFORE
  `chooseListenPort` / `startServer`; added the hidden `__refresh-version`
  subcommand. `handleEnsure` untouched (stays silent; child carries
  `OCX_SERVICE=1`).
- `tests/update-notify.test.ts` (new): 19 tests covering channel-aware
  `isNewer`, source-build gate, cache round-trip + stale-channel invalidation,
  dismiss suppression / re-surface, and the cli wiring order.

## Verification

- `bun x tsc --noEmit`: clean.
- `bun test tests/update-notify.test.ts`: 19 pass / 0 fail.
- `bun test tests/startup-prompt.test.ts`: 3 pass / 0 fail.
- Full suite: 1458 pass / 71 fail / 13 errors. The 71 fail + 13 errors are
  PRE-EXISTING and unrelated (cursor-agent resolver, ACP logger, cursor bridge
  hook). Verified by stashing this change set: clean tree shows the identical
  71 fail / 13 errors, and this work only adds 19 passing tests (1439 -> 1458
  pass).

## Guard matrix (manual reasoning, from code)

- `OCX_SERVICE=1` (service, ensure-spawned child, gui not applicable): silent
  via `interactiveGuardOk`.
- piped / non-TTY stdin or stdout: silent.
- `ocx ensure` (parent): never calls the prompt.
- `ocx gui` spawned start: `stdio:"ignore"` -> non-TTY -> silent.
- source checkout (`detectInstall()==="source"` or version `0.0.0`): silent.
- first run (no star marker): silent; evaluated from the next start.

## Follow-ups (not done)

- O2 alt: a registry `fetch` fallback for npm-less environments remains a
  contained future option; current code reuses `npm view`.
- No automated test exercises the live readline prompt / `process.exit` path;
  decision logic is covered by pure-function tests instead.

## Independent verification (worker subagent)

An independent verifier reran the gates and audited the 6 design intents:

- `bun x tsc --noEmit`: clean. `bun test tests/update-notify.test.ts`:
  19 pass / 0 fail. Full suite: 1458 pass / 71 fail / 13 errors, identical to
  the pre-existing baseline (no new failures attributable to this change).
- All six intents confirmed with file:line evidence: interactive/service
  gating, prompt-before-port/PID ordering, channel-aware `isNewer` incl. the O3
  edges, dismiss suppression, detached non-blocking refresh, and a silent
  `ensure`/`gui` path. Verdict: PASS, "ships safely".

Findings recorded (no code change; left as intended behavior):

- Low: a bare Enter defaults to "Update now", which installs globally and
  exits. This matches codex-rs (Update now is the default highlight) and the
  prompt label states `(default 1)`, but in a plain readline context an
  accidental Enter is more consequential than in a TUI. Kept for parity; revisit
  if users report surprise dismissals.
- Low: forcing `--tag preview` on a stable build (current has no `-preview.`)
  is a quiet no-op in `isNewer` rather than a wrong prompt. Only reachable via
  an unusual manual flag combination.
- Informational: by design the current run reads the pre-refresh cache and the
  freshly fetched version surfaces on the next start (codex-rs parity,
  non-blocking).
