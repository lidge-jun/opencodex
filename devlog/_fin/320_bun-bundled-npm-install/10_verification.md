# 320-10 Verification

Verification record for the bundled-Bun npm install (devlog 320). Maps to the
5-step Verification Gate in `00_plan.md` (§Verification Gate, C4 release surface).

## Gate step 1 — typecheck (autonomous, PASS)

```
$ bun run typecheck      # bun x tsc --noEmit
(no output, exit 0)
```

## Gate step 2 — full test suite (autonomous, PASS)

```
$ bun test
390 pass
0 fail
3161 expect() calls
Ran 390 tests across 44 files.
```

Includes the new `tests/bun-runtime.test.ts` (6 tests) covering the size gate
that distinguishes the real Bun binary from the ~450-byte placeholder stub.

`bun install --frozen-lockfile` → "no changes" (lockfile in sync after adding
the `bun` dependency).

## Gate step 3 — local pack smoke into a Node-only shell (autonomous, PASS)

This is the objective's headline acceptance test: `npm install -g` works
without a separately-installed Bun.

```
$ npm pack            # → bitkyc08-opencodex-2.5.5-preview.1.tgz (launcher shipped: package/bin/ocx.mjs)
$ npm install <tarball> into an isolated temp prefix
  → node_modules/bun/bin/bun.exe present, 60M (real binary, not the stub)
$ env -i PATH="<node-dir>:/usr/bin:/bin"  (NO bun on PATH)  ocx help
  → opencodex (ocx) — Universal provider proxy for Codex ...
  → exit 0
```

### Hostile path — `--ignore-scripts` recovery (C7, PASS)

```
$ npm install <tarball> --ignore-scripts   # leaves a 450-byte ASCII stub at bin/bun.exe
  stub size before: 450 bytes
$ ocx help  (no bun on PATH)
  → launcher detects stub (< 1MB) → runs install.js → downloads real binary
  → bun.exe after recovery: 63,096,576 bytes
  → help printed, exit 0
```

This path found and fixed a real bug: the initial guard checked `size > 0`,
but the placeholder is a 450-byte script (not 0 bytes). Fixed by gating on
`size >= 1MB` (commit `d5608a8` / rebased). Re-verified above.

### Supporting checks

- Exit/signal propagation: unknown command → exit 1.
- Baked path: `buildUnixCodexShim(...)` output contains the bundled
  `node_modules/bun/bin/bun.exe` path (durableBunPath); `service.test.ts` +
  `codex-shim.test.ts` (12 tests) pass.
- `node --check bin/ocx.mjs` → OK.
- No stale `bin: ./src/cli.ts` reference; no remaining "install bun first" /
  "bun must be on PATH" claims in any README or docs-site installation page
  (grep → 0 hits, all locales).

## Gate step 4 — CI npm-global-smoke on ubuntu + windows (PENDING — needs push)

`.github/workflows/ci.yml` `npm-global-smoke` job (Node only, no setup-bun)
covers the Windows launcher path that cannot be exercised on the macOS dev box.
Requires pushing the branch to run on real runners → user approval.

## Gate step 5 — version bump + publish (PENDING — needs push)

`scripts/release.ts` gate (version bump, CI-green requirement, GitHub Release).
Requires push/publish → user approval.

## Residual / out of scope

- Windows launcher resolution (`bin/bun.exe` + npm `.cmd` shim) verified only by
  the new CI job, not locally (dev is macOS).
- ~60 MB Bun binary downloaded per install — accepted tradeoff ("can't be used
  without it"). A true runtime-zero path (`bun build --compile` binaries) is a
  separate future effort (Option 2 in `01_research.md`).
- `update.ts` installer detection still assumes npm for any non-`.bun` global
  path (pnpm/yarn globals get `npm install -g`) — pre-existing, out of scope (C8).

## Status

Code + autonomous verification COMPLETE (gate steps 1–3). Steps 4–5 are
push/publish-gated and require explicit user approval.
