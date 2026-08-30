# 010 — Make the test runner local to one user and one machine

The release train cannot trust a runner that mistakes an incomplete GUI install for a complete one
or serializes unrelated machines through a shared home directory. This phase lands the README
hygiene correction unchanged, repairs the GUI bootstrap, then rebuilds the lock on that surface.
The order is load-bearing: `#2957` and `#2949` overlap in both runner files; `#2952` does not.

The line anchors below are against `dev@47b8d1643`. They describe the patch destinations on that
snapshot; the new blocks introduced by the PRs naturally have their own patch-relative lines.

## `#2952`: merge the README asset guard as authored

`tests/repo-hygiene.test.ts:230`, case `every relative README asset is actually shipped in the npm
tarball`, lets every `package.json#files` entry authorize descendants. A regular file such as
`assets/banner.png` or `LICENSE` can therefore vouch for a nonexistent path below it.

Land commit `7b2fa9032a` without repair. In `tests/repo-hygiene.test.ts:2`, add `statSync`; at the
existing asset filter at lines 247–253, derive `shippedDirectories` only from entries that exist
and whose `statSync(...).isDirectory()` is true. Keep exact-file membership separate from directory
prefix membership. Keep the two inline regression assertions for `assets/banner.png/missing.gif`
and `LICENSE/missing.png`; no production file or new test file belongs to this PR.

## `#2957`: bootstrap the dependency that the tests actually import

Commit `a238a7423b` inserts `ensureGuiDependencies` in `scripts/test.ts` immediately before the
`import.meta.main` block at line 436. Keep its boundaries: no `gui/package.json` means no action;
a source checkout gets CI's frozen install; install failure is reported before test discovery.

Two details must be repaired on the contributor branch before merge.

First, `tests/test-runner.test.ts:4` imports `join`, but the new `paths` fixture at patch line 468
compares native paths with hard-coded `/` suffixes. Windows asks for `\repo\gui\package.json`, so
three cases return `absent`. Build every fixture suffix with `join("gui", "package.json")` and the
dependency marker below, matching the path grammar used by production.

Second, the new `ensureGuiDependencies` check at patch line 458 must not use the existence of
`gui/node_modules` as proof of a successful install. `bun install` can leave that directory behind
after interruption or failure; caching that partial tree as `present` suppresses every retry. Use
`join(guiDir, "node_modules", "react", "package.json")` as the readiness marker because React is
the dependency the GUI-importing tests require. Keep the source-tree gate, frozen install,
actionable manual command, and bounded stderr/stdout detail unchanged.

Retain `describe("ensureGuiDependencies")` with these exact repaired case names:

- `installs when gui/package.json exists but the React dependency marker does not`
- `does nothing when the React dependency marker is already there`
- `does nothing when there is no gui package`
- `reports the failure detail instead of continuing`

Add `retries installation when a partial node_modules directory exists`: report the package and
`node_modules` present but omit React's marker, then assert `kind: "installed"` and one install.

## `#2949`: reimplement the default lock root

Do not merge commit `c49cd66d90`. On `dev@47b8d1643`, `scripts/test-run-lock.ts:16` places the lock
directly under `tmpdir()`. The PR moves it to `homedir()` at its patch lines 59–60, but that changes
the failure instead of fixing the scope. A network-mounted home lets two hosts rendezvous on one
directory even though `processIsAlive` at base lines 89–96 interprets PIDs only on the current host.
One host can reclaim another's live lock, or a colliding PID can hold it for the 45-minute bound at
lines 170–171. An unwritable home throws `EACCES` at lines 183–201 before test discovery.

Keep the owner file, member registration, atomic `mkdir`, stale rename, bounded wait, and explicit
`lockPath` test seam unchanged. Replace only default-path resolution in
`scripts/test-run-lock.ts`: remove the module-level `DEFAULT_LOCK_PATH` at line 16, export a pure
`resolveDefaultTestRunLockPath` backed by a small injectable filesystem/OS dependency object, and
call it from `acquireTestRunLock` at line 168 when `options.lockPath` is absent.

On POSIX, resolve the numeric UID with `process.getuid()`. Prefer `XDG_RUNTIME_DIR` only after
canonicalizing it and proving real-directory type, UID ownership, mode `0700`, and writability with
a create/remove probe. Otherwise canonicalize `tmpdir()`, create or reuse mode-`0700`
`opencodex-test-runtime-v1-<uid>`, and re-read ownership and mode. Never repair a foreign owner or
follow a symlink; place the lock below the proven-private root.

On Windows, use the OS-resolved `tmpdir()`/profile result, never `$USER`, `USERNAME`, or paths built
from them. Canonicalize and probe writability. ACL identity remains the OS resolver's contract;
do not introduce PowerShell or duplicate coordinator SID machinery.

Append a machine discriminator before `opencodex-bun-test.lock`: hash current host identity and the
canonical runtime root to a fixed-width path-safe value. Host identity separates redirected paths
shared by machines; canonicalization makes aliases on one machine rendezvous. If no candidate is
private and writable, throw one actionable error naming each rejected candidate and reason before
the acquisition loop.

Update only the user-facing nouns at `scripts/test.ts:454–458` and `tests/preload.ts:33–39` from
`machine lock` to `machine-local user lock`. `tests/preload.ts` must continue to call the same
`acquireTestRunLock`; wrapped and bare Bun runs must therefore resolve the identical default path.

Replace `tests/test-runner.test.ts:364` with `describe("bun test machine-local user lock")` and add:

- `prefers a private writable XDG runtime directory for the effective uid`
- `rejects foreign-owned, permissive, symlinked, and unwritable XDG runtime directories`
- `falls back to a mode-0700 uid-scoped directory under the OS temp root`
- `does not consult USER or shared home state on Windows`
- `separates two machine identities even when their canonical runtime root is shared`
- `canonical path aliases resolve to one lock path on the same machine`
- `fails with candidate-specific guidance when no runtime root is safe`

Do not retain the PR's `resolveDefaultTestRunLockPath(...).startsWith(tmpdir())`: `/tmp-other` passes
a `/tmp` prefix. Assert `join`ed paths and use `relative` plus absolute/`..` rejection for
containment. Existing lines 365–460 still prove identity, joining, reclaim, contention, and opt-out.

## Focused verification

Run only the owning file after each landing step:

```bash
bun test tests/repo-hygiene.test.ts
bun test tests/test-runner.test.ts
```

Then verify the combined wp1 head once:

```bash
bun test tests/repo-hygiene.test.ts tests/test-runner.test.ts
```

The local full suite, `bun run test`, `bun run typecheck`, and `bun run prepush` are forbidden here.
Cross-platform proof comes from exact-head remote CI, including the final Windows dispatch.
