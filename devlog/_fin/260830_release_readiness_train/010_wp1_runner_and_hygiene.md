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

Commit `7b2fa9032a` landed without repair. In `tests/repo-hygiene.test.ts:2`, it adds `statSync`; at
the existing asset filter at lines 247–253, it derives `shippedDirectories` only from entries that
exist and whose `statSync(...).isDirectory()` is true. Exact-file membership remains separate from
directory prefix membership. The two inline regression assertions for
`assets/banner.png/missing.gif` and `LICENSE/missing.png` remain; no production file or new test file
belongs to this PR.

#2952 is DONE at `dca16949b`. Nothing was pushed to its contributor head, so its exact-head author
attestation remained valid and it merged without returning to draft. That is the control case for
the repaired candidates below: `maintainerCanModify` permits a push, but the push invalidates the
review-readiness state needed to merge the contributor PR.

## `#2957`: bootstrap the dependency that the tests actually import

Commit `a238a7423b` inserts `ensureGuiDependencies` in `scripts/test.ts` immediately before the
`import.meta.main` block at line 436. Keep its boundaries: no `gui/package.json` means no action;
a source checkout gets CI's frozen install; install failure is reported before test discovery.

Both required details are repaired at #2957 head `08c5b5005`.

First, `tests/test-runner.test.ts:4` imports `join`, and the repaired `paths` fixture at patch line
468 normalizes both POSIX and Windows separators. Windows asks for `\repo\gui\package.json`; the
dedicated separator case now proves that the fixture recognizes both path grammars used by
production.

Second, the repaired `ensureGuiDependencies` check at patch line 458 no longer uses the existence
of `gui/node_modules` as proof of a successful install. `bun install` can leave that directory
behind after interruption or failure; caching that partial tree as `present` would suppress every
retry. The repaired head uses `join(guiDir, "node_modules", "react", "package.json")` as the
readiness marker because React is the dependency the GUI-importing tests require. The source-tree
gate, frozen install, actionable manual command, and bounded stderr/stdout detail remain unchanged.

The landed repaired head retains `describe("ensureGuiDependencies")` with these exact case names:

- `mocked paths match POSIX and Windows separators`
- `installs when gui/package.json exists but node_modules does not`
- `retries when node_modules exists without the required dependency`
- `does nothing when the required dependency is already there`
- `does nothing when there is no gui package`
- `reports the failure detail instead of continuing`

The retry case reports the package and `node_modules` present but omits React's marker, then asserts
`kind: "installed"` and one install.

The repair push reset #2957's exact-head checklist, so #2957 is now
DRAFT/BLOCKED/REVIEW_REQUIRED and must not be re-attested by a maintainer. Cherry-pick the
contributor's commits plus the repair onto a maintainer-owned branch; Git preserves the original
author metadata. Open a maintainer PR that credits the contributor and explicitly names #2957 as
the PR it carries, then close #2957 as carried. The maintainer PR, not the blocked contributor PR,
is the landing vehicle for this phase.

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
