# LANE F — Bun 1.4.2 pin update (diff-level plan)

Research lane, READ-ONLY. Repository worktree `/tmp/ocx-249.xGQnxl/wt`, detached at
`7dc7dc99e65268bc8764e19840952256b030bce9` (= `origin/dev`, verified clean immediately before verdict).
Remote: `https://github.com/lidge-jun/opencodex.git`.

Scratch worktree used for lock regeneration and focused tests: `/tmp/ocx-bun142-1lrK/wt`
(created with `git worktree add --detach` from the research worktree; `bun install` was run there only,
per this lane's explicit allowance). Nothing was committed, pushed, or written to the research worktree
or the main checkout other than this document.

## Summary table

| item | verdict | one-line reason | head SHA | CI at head | conflicts |
| --- | --- | --- | --- | --- | --- |
| Bun pin 1.4.0 → 1.4.2 (no PR exists; maintainer-authored change) | LAND_WITH_FIX | Upgrade is mechanically safe and self-contained in 4 files, but `tests/ci-workflows/install-scripts.test.ts:68,71` hard-pins `"1.4.0"` and must move in the same commit or CI goes red | n/a — new branch off `7dc7dc99e` | n/a — not yet opened; full expensive CI will trigger because `package.json`, `bun.lock`, and `Dockerfile` are all on the ci.yml allowlist | none with the luvs01 fixture train (disjoint file set) |

Verdict rationale in one line: this is not a triage disposition on an existing PR — no open PR bumps Bun
(`gh pr list --repo lidge-jun/opencodex --state open --limit 100` filtered on bun/1.4/bump/pin returned only
`4039 fix(codex): retain overlapping multiline TOML terminators`, unrelated). LAND_WITH_FIX describes the
maintainer commit to author: the naive two-line `package.json` bump is incomplete and breaks a green suite.

## (a) npm availability — VERIFIED

```
$ npm view bun@1.4.2 version dist.shasum
version = '1.4.2'
dist.shasum = '79e72a583198bc3cdabe569c8aa83d9f014d6f3d'

$ npm view @types/bun@1.4.2 version
1.4.2

$ npm view bun dist-tags --json
{ "latest": "1.4.2", "canary": "1.4.2-canary.20260906.1" }
```

`bun@1.4.2` is the current `latest` on npm and `@types/bun@1.4.2` exists. The published version list confirms
`1.4.0`, `1.4.1`, `1.4.2` are all stable releases with no intervening stable between the current pin and the target.

## (b) Docker image digest — VERIFIED via Docker Hub registry API

Resolved through the anonymous pull token against `registry-1.docker.io`:

```
$ curl -sI -H "Authorization: Bearer $T" \
    -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
    https://registry-1.docker.io/v2/oven/bun/manifests/1.4.2
content-type: application/vnd.oci.image.index.v1+json
docker-content-digest: sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
```

**Manifest-list (OCI image index) digest for `oven/bun:1.4.2`:**
`sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895`

Per-platform child manifests inside that index:

| os | arch | digest |
| --- | --- | --- |
| linux | amd64 | `sha256:296a79bbc988bb0a91ef11099af70a78a8cba98b73fd53f7b2a7715b7c86ced2` |
| linux | arm64 | `sha256:3121e24dc54514f0e37bcc996a9e6df64519b4caff03a33bbb9993baca7c403b` |
| unknown | unknown | `sha256:eec66493c307828ce09bc4c5c626da0c409a481b195a7267d0e0bdc4a3961563` (attestation) |
| unknown | unknown | `sha256:ac5a8a80ecb1b60ea2cefab6ce99fcc92d5fbcf3e6c81907ddc6e23770478ba5` (attestation) |

Both required platforms (linux/amd64 + linux/arm64) are present, matching the current pin's coverage.

**Control check — the existing pin is still accurate.** The live `oven/bun:1.4.0` tag digest is
`sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6`, byte-identical to the committed
`Dockerfile:4` pin. The tag has not been re-pushed, so the current `Dockerfile` is not stale and this bump
is a deliberate upgrade rather than a repair.

The `Dockerfile` pins the **index** digest, not a per-platform digest — correct, because `Dockerfile:4` is
consumed by both `FROM ${BUN_IMAGE} AS build` (line 6) and `FROM ${BUN_IMAGE} AS runtime` (line 25) and must
resolve on both architectures.

## (c) Bun 1.4.1 / 1.4.2 release notes — behavior changes relevant to this repo

The GitHub releases carry no changelog body; both only link to the blog:

- `gh release view bun-v1.4.1 --repo oven-sh/bun` → name `Bun v1.4.1`, published `2026-09-04T08:33:19Z`,
  body links `https://bun.com/blog/bun-v1.4.1`, 7 contributors.
- `gh release view bun-v1.4.2 --repo oven-sh/bun` → name `Bun v1.4.2`, published `2026-09-05T05:55:48Z`,
  body links `https://bun.sh/blog/bun-v1.4.2`, 3 contributors.

So the actual behavior delta was taken from the commit range:
`gh api repos/oven-sh/bun/compare/bun-v1.4.0...bun-v1.4.2` → **488 total commits**, 300 files
(the API returns the first 250 commit objects; the classification below is over those 250).

### Test runner — the highest-relevance cluster for this repo

| commit | change | relevance |
| --- | --- | --- |
| `bf123ad7c` | test runner: undo a file's `process.env` side effects when `--isolate` swaps the global (#40928) | **Direct.** CI runs `--isolate` shards via `scripts/ci/run-bun-test-batches.sh`. This makes env leakage between isolated files stop propagating — a behavior change that can *surface* a test which was silently depending on a previous file's env mutation. |
| `e1c13251d` | `bun test --isolate`: put the synthetic allocation limit back after every file (#41068) | **Direct.** Same `--isolate` path; affects memory-limit behavior across files. |
| `2a0fda972` | `bun test --parallel`: stop silently respawning workers that exit before ready (#40784) | Indirect; this repo shards rather than using `--parallel`. |
| `07b0f7bff` | `bun test --parallel`: coverage/results to coordinator as data (#40678) | Indirect, same reason. |
| `a27a7a1a1` | `bun:test`: fail instead of crash when `toBeWithin()` gets one argument (#40694) | Low; crash → failure conversion only. |
| `4e1eeff48` | `bun:test`: handle non-numeric `size` when formatting a Set/Map diff (#41148) | Low; diff-rendering only. |
| `85f482931` | `bun:test`: isArray() exception checks for Proxy values in matchers (#40981) | Low. |

The `--isolate` items matter because `scripts/ci/run-bun-test-batches.sh:77-84` contains a crash-signature
allowlist written against Bun 1.3.14 isolate behavior:

```
scripts/ci/run-bun-test-batches.sh:77:  # Bun 1.3.14 can surface a Linux epoll registration failure as exit 1,
```

That retry heuristic is version-tolerant (it matches a narrow string signature and otherwise falls through),
so it does not need editing — but it is the place to look first if a shard behaves oddly after the bump.

### Streams / fetch / Bun.serve

Most relevant, given `src/server/relay-eager.ts` and the WS relay:

| commit | change |
| --- | --- |
| `bc3f119f3` | streams: treat a falsy `controller.close(reason)` as a clean close (#40684) |
| `936bf867a` | `Bun.serve`: cancel the body stream of a Response the server will never transmit (#41011) |
| `e5a18d522` | `Bun.serve`: release the body stream of a Response whose client aborted mid-stream (#41080) |
| `625e00db7` | server: run the error handler when a locked response body cannot become a stream (#41034) |
| `4f7e15b7a` | server: release a response body's stream from one non-generic helper (#41130) |
| `c2a2b28b3` | `Bun.serve`: pause the file reader while the response is backpressured (#41244) |
| `1b315c2ab` | `Bun.serve`: report a rejection from a handler that upgraded before it returned (#41227) |
| `49b74a33a` | `Bun.serve`: write 16-bit header values as latin-1 bytes, not UTF-8 (#40685) |
| `b026de3f2` | `Bun.serve`: ignore a Range header whose positions are not all digits (#40698) |
| `3f78cd93e` | fetch: pool unix-socket connections in the keep-alive pool (#34079) |
| `4884409cc` | WebSocket client: share one libdeflate decompressor and inflate buffer per VM (#40754) |

All of these are fixes in the direction of *more* correct stream teardown, which is the direction the eager
relay wants. None reverts Bun PR #32120 (the use-after-free fix that `MIN_FIXED_BUN_VERSION` gates on), so the
existing `"1.4.0"` threshold stays valid — see the "what must NOT change" section below.

### node:child_process

| commit | change |
| --- | --- |
| `118fdd203` | `child_process`: report a failed child stdin write with syscall `write`, as Node does (#40935) |

Error-shape change only, on a failure path. This repo spawns children in service/CLI paths; the change alters
the `syscall` field of an error that only appears when a child stdin write already failed.

### keyring / napi / ffi

| commit | change |
| --- | --- |
| `e2eac5f48` | napi: match Node's finalizer timing for deleted references and threadsafe functions (#39848) |
| `fd7d527db` | `bun:ffi`: throw the argument errors of `toBuffer`/`toArrayBuffer` (#40751) |

`e2eac5f48` is the one to watch: `@napi-rs/keyring@1.3.0` is a direct dependency and this changes napi
finalizer timing. It aligns Bun with Node, so a correctly-written addon is unaffected, but keyring-touching
tests are worth a focused run (listed below).

### Windows

| commit | change |
| --- | --- |
| `e83de4294` | which: find `.com` executables and stat an explicit path as spelled on Windows (#40582) |
| `03a3f9f25` | errno(windows): spell E like SystemErrno so messages say `ENOENT`, not `NOENT` (#40602) |
| `2b3f66011` | sys(windows): report unmapped Win32 error codes as `EUNKNOWN`, not success (#40860) |
| `5fba7bd23` | windows: unwrap FACILITY_WIN32 HRESULTs in `Win32Error::get()` (#40864) |
| `bd630c1d7` | errno: map a kernel errno outside the table to `EUNKNOWN` instead of transmuting (#40720) |

`03a3f9f25` is a **user-visible error-message change on Windows** (`NOENT` → `ENOENT`). Any assertion matching
on a Windows errno *string* could flip. This is the single most likely source of a surprise Windows CI failure,
so the Windows lane result should be read carefully rather than assumed.

### Other notable

`22f5249e2` (install: run git for git dependencies on the install thread's event loop) and `c89fc95d6`
(install: sort workspace deps by resolved name when writing `bun.lock`) touch the installer. `c89fc95d6`
could in principle reorder a lock file — it did not here; the regenerated lock diff below is purely version
strings and hashes, with no reordering.

## (d) How CI selects the Bun version — package.json is the single source of truth

CI does **not** read `.bun-version` (no such file exists: `cat .bun-version` → No such file or directory) and
does not use `packageManager`. It resolves the version from `package.json` `dependencies.bun` through a
repository-owned composite action.

`.github/actions/setup-project-bun/action.yml:1-30`:

```yaml
.github/actions/setup-project-bun/action.yml:2:description: >-
.github/actions/setup-project-bun/action.yml:3:  Install the Bun runtime for a job. Installs the version declared in
.github/actions/setup-project-bun/action.yml:4:  package.json (dependencies.bun), keeping the runtime SOT in one place so
.github/actions/setup-project-bun/action.yml:5:  version bumps only touch package.json and bun.lock.
...
.github/actions/setup-project-bun/action.yml:19:        version="$(node -p "require('./package.json').dependencies.bun")"
...
.github/actions/setup-project-bun/action.yml:28:      uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
.github/actions/setup-project-bun/action.yml:29:        with:
.github/actions/setup-project-bun/action.yml:30:        bun-version: ${{ steps.resolve.outputs.version }}
```

**Mechanism:** the composite action shells out to `node -p` to read `dependencies.bun` out of
`package.json`, fails the job with `::error::Could not resolve Bun version from package.json` if empty, then
hands that literal string to `oven-sh/setup-bun@v2` as `bun-version`. The runtime that CI *executes* is
therefore the one installed by `setup-bun` — not the one `bun install` places in `node_modules`. Editing
`package.json` `dependencies.bun` is what changes the CI runtime; the `bun.lock` update keeps
`bun install --frozen-lockfile` consistent and delivers the same version to npm consumers.

Adoption of the composite action across workflows:

```
$ rg -c 'setup-project-bun' .github/workflows/*.yml
.github/workflows/release.yml:1
.github/workflows/dev-version-bump.yml:1
.github/workflows/ci.yml:9
.github/workflows/service-lifecycle.yml:3
```

14 usages across 4 workflows all move together with one `package.json` line.

**The one exception — a hard-coded stale pin.** `.github/workflows/cleanup-orphaned-workflows.yml` bypasses
the composite action entirely and pins an old version directly:

```yaml
.github/workflows/cleanup-orphaned-workflows.yml:37:        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
.github/workflows/cleanup-orphaned-workflows.yml:38:        with:
.github/workflows/cleanup-orphaned-workflows.yml:40:          bun-version: 1.3.14
```

This is **1.3.14** — two minor lines behind the project runtime, left behind when `27764f342` moved everything
else to 1.4.0. It runs `bun scripts/ci/cleanup-orphaned-workflows.mjs`, a standalone maintenance script with
no repository install, so it is not currently broken. Recommendation below treats fixing it as an
**optional, separately-revertible follow-up**, not part of the pin bump, because it is a distinct defect
(a workflow that opted out of the SOT) and the repository's own rule is one bug per commit.

## (e) Prior bump commit — the template

`git log -S'"bun": "1.' --oneline -- package.json` returns only `e218f75ce` (the original bundling commit),
because the search string matches the *added* line pattern. The actual most recent bump is found by line
history — `git log -L 69,69:package.json`:

```
27764f342 2026-08-21 chore(runtime): move the bundled Bun to 1.4.0 stable and retire the canary channel
e218f75ce 2026-06-25 [agent] feat: bundle Bun so npm install works without separate Bun (320 P1+P2)
```

**`27764f34259023d88ebe1cdc63ecb13e34d2ab64`** is the template. Its message:

> Bun 1.4.0 is on npm, so the GitHub-canary qualification channel is no longer needed: the composite action
> loses its github-canary input, the preview-dev CI lane and branch are gone, and fetch-canary-bun.ts /
> qualified-bun.json are removed. MIN_FIXED_BUN_VERSION is set to 1.4.0 in the same commit that bumps the
> bundled runtime, per its own contract.

Files it touched (25 files, +40/−418):

```
 .github/actions/setup-project-bun/action.yml       |  42 +---
 .github/workflows/ci.yml                           |  71 +------
 README.md                                          |   8 +-
 bun.lock                                           |  42 ++--
 package.json                                       |   4 +-
 scripts/runtime/fetch-canary-bun.ts                | 232 ---------------------
 scripts/runtime/qualified-bun.json                 |  25 ---
 src/lib/bun-stream-caps.ts                         |  11 +-
 tests/bun-stream-caps.test.ts                      |   4 +-
 tests/ci-workflows.test.ts                         |  17 +-
 tests/install-scripts.test.ts                      |   2 +-
 (+ 14 devlog file moves, 0 bytes each)
```

**Important: that commit is a poor template taken literally.** It was a *channel retirement* (canary → stable)
bundled with a version bump, which is why it deleted `fetch-canary-bun.ts`, rewrote the composite action, and
moved `MIN_FIXED_BUN_VERSION`. A 1.4.0 → 1.4.2 patch bump within the same line carries none of that. The
transferable core of the template is exactly four entries: `package.json`, `bun.lock`,
`tests/install-scripts.test.ts` (now `tests/ci-workflows/install-scripts.test.ts` after the test
modularization), plus `Dockerfile` — which `27764f342` did *not* touch because the Dockerfile pin was
introduced later, by `89c0a64fe`.

## Diff-level plan — 4 files

Every hunk below was applied and verified in the scratch worktree `/tmp/ocx-bun142-1lrK/wt`.
Final `git diff --stat` there: `Dockerfile | 2 +-`, `bun.lock | 34 +++---`, `package.json | 4 +-`,
`tests/ci-workflows/install-scripts.test.ts | 4 +-` — 4 files, 22 insertions, 22 deletions.

### 1. `package.json` (2 lines)

Before (`package.json:69` and `package.json:73` on `7dc7dc99e`):

```json
    "bun": "1.4.0",
    "@types/bun": "1.4.0",
```

After:

```json
    "bun": "1.4.2",
    "@types/bun": "1.4.2",
```

Exact diff:

```diff
@@ -66,11 +66,11 @@
     "@bufbuild/protobuf": "^2.14.0",
     "@modelcontextprotocol/sdk": "^1.30.0",
     "@napi-rs/keyring": "1.3.0",
-    "bun": "1.4.0",
+    "bun": "1.4.2",
     "zod": "4.4.3"
   },
   "devDependencies": {
-    "@types/bun": "1.4.0",
+    "@types/bun": "1.4.2",
     "typescript": "7.0.2"
   },
```

### 2. `Dockerfile` (1 line)

Before, `Dockerfile:3-4`:

```
Dockerfile:3:# Keep the runtime aligned with package.json and pin the multi-platform image index.
Dockerfile:4:ARG BUN_IMAGE=oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6
```

After:

```
ARG BUN_IMAGE=oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
```

The comment on line 3 states the invariant this edit satisfies — the image must track `package.json`. Leaving
the Dockerfile at 1.4.0 while `package.json` says 1.4.2 would violate the stated contract silently, since
nothing mechanically asserts the two agree (see "gap" below).

### 3. `tests/ci-workflows/install-scripts.test.ts` (2 lines) — **the mandatory fix**

This is what makes the verdict LAND_WITH_FIX rather than a trivial bump. Before, `tests/ci-workflows/install-scripts.test.ts:68` and `:71`:

```ts
    expect(pkg.dependencies?.bun).toBe("1.4.0");
    expect(pkg.dependencies?.zod).toBe("4.4.3");
    expect(pkg.devDependencies?.typescript).toBe("7.0.2");
    expect(pkg.devDependencies?.["@types/bun"]).toBe("1.4.0");
```

After:

```ts
    expect(pkg.dependencies?.bun).toBe("1.4.2");
    expect(pkg.devDependencies?.["@types/bun"]).toBe("1.4.2");
```

**Proven live, not assumed.** With only `package.json` and `bun.lock` changed in the scratch worktree:

```
$ bun test tests/ci-workflows/install-scripts.test.ts
68 |     expect(pkg.dependencies?.bun).toBe("1.4.0");
                                       ^
error: expect(received).toBe(expected)
Expected: "1.4.0"
Received: "1.4.2"
      at <anonymous> (/private/tmp/ocx-bun142-1lrK/wt/tests/ci-workflows/install-scripts.test.ts:68:35)
(fail) install scripts > npm package main is a Node-safe wrapper while Bun keeps the TypeScript API [2.22ms]
 9 pass
 1 fail
```

A `package.json`-only bump lands a red suite. The two test lines must move in the same commit.

### 4. `bun.lock` — regenerated, 34 lines

Command (run in the scratch worktree after editing `package.json`):

```
$ bun install --lockfile-only
bun install v1.4.0 (34cbb9a40)
Resolving dependencies
Resolved, downloaded and extracted [32]
Saved lockfile
Saved bun.lock (145 packages) [1113.00ms]
```

`--lockfile-only` is the right command for the commit: it writes `bun.lock` without mutating `node_modules`.
A plain `bun install` produces the identical lock (also verified — it installed `bun@1.4.2` and
`@types/bun@1.4.2`, 103 packages, and `node_modules/.bin/bun --version` then reported `1.4.2`).

Resulting hunk — the workspace block:

```diff
@@ -8,11 +8,11 @@
         "@bufbuild/protobuf": "^2.14.0",
         "@modelcontextprotocol/sdk": "^1.30.0",
         "@napi-rs/keyring": "1.3.0",
-        "bun": "1.4.0",
+        "bun": "1.4.2",
         "zod": "4.4.3",
       },
       "devDependencies": {
-        "@types/bun": "1.4.0",
+        "@types/bun": "1.4.2",
         "typescript": "7.0.2",
       },
     },
```

The twelve `@oven/bun-*` platform packages plus `@types/bun` and `bun-types` (lines 60-91 region) each move
version and integrity hash. Representative entries, with the new sha512 values:

```diff
-    "@oven/bun-darwin-aarch64": ["@oven/bun-darwin-aarch64@1.4.0", ... "sha512-GCpf8QuFLsyioVawP5HrMxA1ZRBlu6Hq9RNnSc3UTUWAzIxBso9trjoZczw1HdgpqSssFkszfIV2zmOzFTjhkw=="],
+    "@oven/bun-darwin-aarch64": ["@oven/bun-darwin-aarch64@1.4.2", ... "sha512-MXdZkP1featqxZ+/VTXWG1BVjM4OGBehVY2Q88EeUj/7L0UMeCGItmyPYTN+wxvlGJ6F66JEtzsw+GvQWewnag=="],
-    "@oven/bun-darwin-x64":     [... @1.4.0 ... "sha512-cIrhwOr0SPEraewznhC+c/k6TG8bwFn5uZ4EJuXwjiKJLcAF36q7/bGjWkeXSe48JwMcPRUR054JXF7+cRwSSA=="],
+    "@oven/bun-darwin-x64":     [... @1.4.2 ... "sha512-gZTxZuLjkUhAWjTETu3tw0WhsEdNkJ64daj60ybhPf835a2yollV3yTkK9JozvzKPx4TRFzLSl8C+U525pxVbw=="],
-    "@oven/bun-linux-aarch64":  [... @1.4.0 ... "sha512-Y5yAtCbHK6JjprXEtkdklDQFPADgs+CkfcliyY5g4JJ8baGHyQSrfpSkX3XVJ2C+aBLsdwNDdW+oczMsAwx6uA=="],
+    "@oven/bun-linux-aarch64":  [... @1.4.2 ... "sha512-3BBP9ovJ2RGHFH6Ae1CAtxNtG1+YY6GD6rmYbsUosoAk9+OEl6zeDQ/k4fBkc6dYOJCtWnx8hUxzNzQATSmvYQ=="],
-    "@oven/bun-linux-x64":      [... @1.4.0 ... "sha512-Du44zebtPXJujvMLmtIxEQ6ykOhYt7L/Q+YIGVm+Yy+Pj/fpOnq60ggwIpKp/pGAFbYHNiTrA3JTjuZ9MTbZIg=="],
+    "@oven/bun-linux-x64":      [... @1.4.2 ... "sha512-9/E/UXOTpSo3YsV5g+FhtTd/qTpiWoKuxS12cqtuYA1ssu9fRAoPQnipFgGyck3tWO63iUdxBiygq+kELFawng=="],
-    "@oven/bun-windows-x64":    [... @1.4.0 ... "sha512-jRKv1NPLznMSZY5BEWciMF7zv0Tiyo2pQSxAJ3w+YWJ6y3VWNJQQQdLlV5Jx8lbOFDrJdrc9dD3GV17k3BP41A=="],
+    "@oven/bun-windows-x64":    [... @1.4.2 ... "sha512-+bN6OuVld/9diT/RLSXSW7JE6CvNE3gL9XsAEjULi1nUsXd6DNO6GuA9jNdNb3r8PdJFnYHr5aypNV1Oj3Rd9g=="],
-    "@types/bun": ["@types/bun@1.4.0", "", { "dependencies": { "bun-types": "1.4.0" } }, "sha512-K+lZULY23vRgK/CfTjFIV+tyifaNdSMlPh9j+6mQ/cLfpOznLyAuzgV/JQysyECpkBQLVMSyvjlr2fBUSA9wFQ=="],
+    "@types/bun": ["@types/bun@1.4.2", "", { "dependencies": { "bun-types": "1.4.2" } }, "sha512-GimotNn7+ZV0uVArItBbriZsR1oNf0+WTzPkdcFrzShI7k2norL0uzEaJT8T33dWr7O/c9ZDuAFQrctKCi72oQ=="],
-    "bun-types": ["bun-types@1.4.0", "", { "dependencies": { "@types/node": "*" } }, "sha512-iIKw23BspnQQYd3prITOBxeUsxBHnwzX6YJfGMuNOZzeNcMmVqzIIVGRm1l69ogaPQmb4wB6BN8mA5bE9YuC5Q=="],
+    "bun-types": ["bun-types@1.4.2", "", { "dependencies": { "@types/node": "*" } }, "sha512-bxV1FgK7yBIzjRe5zBozIM4Bem11ZJcCXSrjWRG3YWLt8yFDePu4cLjpebO8OvPeIE9trbyPF4fuj3Cia4Fj3w=="],
```

And the root `bun` entry (`bun.lock:139`), whose `optionalDependencies` map moves all twelve platform pins:

```diff
-    "bun": ["bun@1.4.0", "", { "optionalDependencies": { "@oven/bun-darwin-aarch64": "1.4.0", ... "@oven/bun-windows-x64": "1.4.0" }, "os": [ "!aix", "!sunos", "!openbsd", ], "cpu": [ "x64", "arm64", ], "bin": { "bun": "bin/bun.exe", "bunx": "bin/bunx.exe" } }, "sha512-iRiFkc2W7UVpCyZXO9tod45TP9QCyN19fWqbpeN/jaM/K7uzeHYx/OSPsahMJazGKBgPsnxRt+4Jc43d8BcHZw=="],
+    "bun": ["bun@1.4.2", "", { "optionalDependencies": { "@oven/bun-darwin-aarch64": "1.4.2", ... "@oven/bun-windows-x64": "1.4.2" }, "os": [ "!aix", "!sunos", "!openbsd", ], "cpu": [ "x64", "arm64", ], "bin": { "bun": "bin/bun.exe", "bunx": "bin/bunx.exe" } }, "sha512-TrSXo6HJfIEaczpb3kjX82I2pL47vK1QUNmHRCUdz9IzaOwa9lzOXSWwu2l18YHE3sNfGRapVLd4nNm+22vVVA=="],
```

Total: 17 changed lines × 2 = **34 lines in `bun.lock`**, all version strings and integrity hashes. No package
was added, removed, or reordered, and no transitive dependency moved — `@types/node@26.0.1` and every other
entry are untouched, so `c89fc95d6` (the workspace-sort installer change) has no effect on this lock.

## What must NOT change — three near-miss traps

**1. `MIN_FIXED_BUN_VERSION` stays `"1.4.0"`.** `src/lib/bun-stream-caps.ts:28` reads:

```ts
src/lib/bun-stream-caps.ts:28:export const MIN_FIXED_BUN_VERSION: string | null = "1.4.0";
```

Its contract comment (`src/lib/bun-stream-caps.ts:22-23`) says "Bump in the SAME commit that bumps
package.json's bundled Bun to a version verified to include Bun PR #32120". Read carelessly that reads like a
mirror of the bundled version, which would make this bump edit it to `"1.4.2"`. That would be **wrong**. The
constant is a *threshold*: the lowest released version proven to carry the fix. `src/lib/bun-stream-caps.ts:6-7`
is explicit — "Bun 1.4.0 is the first RELEASED version proven to carry that fix, so `MIN_FIXED_BUN_VERSION` is
`"1.4.0"`: older runtimes stay 'known-bad'." Raising it to 1.4.2 would falsely re-classify 1.4.0 and 1.4.1
runtimes as known-bad and silently push their traffic back onto `legacy-tee`. The existing test pins this
directly:

```ts
tests/lib/bun-stream-caps.test.ts:50:  test("shipped threshold is Bun 1.4.0; a null threshold is never fixed", () => {
tests/lib/bun-stream-caps.test.ts:51:    expect(MIN_FIXED_BUN_VERSION).toBe("1.4.0");
```

and `tests/lib/bun-stream-caps.test.ts:57` already asserts `bunHasAsyncPullCancelFix("1.4.1", "1.4.0") === true`,
so 1.4.2 is covered by the existing threshold with no edit.

**2. `MIN_BOUNDED_CODEX_WS_BUN_VERSION` stays `"1.4.0"`.** `src/server/responses/ws-upstream.ts:26` — same
threshold reasoning, backed by `tests/responses/ws-upstream.test.ts:67` and the `structure/` prose at
`structure/04_transports-and-sidecars.md:505` ("stable Bun runtime at or above 1.4.0 may use Codex's upstream
`responses_websockets` transport"). "at or above" is already correct for 1.4.2; no doc edit needed.

**3. `tests/service/container-bootstrap.test.ts:214` (`bunRuntimeVersion: "1.4.0"`) stays.** This looked like a
fifth file to edit. It is not: it is a synthetic fixture inside `compatibilitySnapshot()`, a local helper that
writes `"abc"` into temp files and builds a manifest to exercise snapshot validation. The real value is derived
at runtime — `scripts/generate-compatibility-version.ts:80` and `src/routing/compatibility/version.ts:56` both
set `bunRuntimeVersion: Bun.version`. The literal is arbitrary test data, and the file passes unchanged
(confirmed in the focused run below).

Similarly, the ~40 other `1.4.0`/`1.3.14` hits across `tests/` are threshold-comparison arguments
(`tests/responses/ws-upstream.test.ts`, `tests/responses/reserve-dispatch-ws.test.ts`) or historical comments
about 1.3.14 isolate bugs (`tests/storage/*.test.ts`). None is a pin. `README.md` names no version
(`README.md:211` says only "Requires Node 18+"), `gui/package.json` has no bun pin, and `docs-site` matches on
`1.4.0` are prose about the transport threshold, not the bundled version.

## Commands to reproduce

```bash
# scratch worktree off dev
SCRATCH=$(mktemp -d /tmp/ocx-bun142-XXXX)
git -C /tmp/ocx-249.xGQnxl/wt worktree add --detach "$SCRATCH/wt" HEAD
cd "$SCRATCH/wt"

# 1+3: pins and the test fixture
sed -i '' 's/"bun": "1\.4\.0"/"bun": "1.4.2"/; s/"@types\/bun": "1\.4\.0"/"@types\/bun": "1.4.2"/' package.json
sed -i '' '68s/"1\.4\.0"/"1.4.2"/; 71s/"1\.4\.0"/"1.4.2"/' tests/ci-workflows/install-scripts.test.ts

# 2: Dockerfile image + index digest
sed -i '' '4s|oven/bun:1\.4\.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6|oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895|' Dockerfile

# 4: lock
bun install --lockfile-only
```

Digest re-verification (do this at authoring time — a tag can be re-pushed):

```bash
T=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:oven/bun:pull" \
      | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -sI -H "Authorization: Bearer $T" \
  -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
  https://registry-1.docker.io/v2/oven/bun/manifests/1.4.2 | grep -i docker-content-digest
```

## Focused tests — run and results

Run in the scratch worktree with all four edits applied, against the freshly-installed `bun@1.4.2`
dependency tree:

```
$ bun test tests/ci-workflows/install-scripts.test.ts \
           tests/service/container-bootstrap.test.ts \
           tests/lib/bun-stream-caps.test.ts \
           tests/responses/ws-upstream.test.ts \
           tests/ci-workflows/ci-workflows.test.ts

 352 pass
 1 skip
 0 fail
 2668 expect() calls
Ran 353 tests across 5 files. [3.15s]
```

The single skip is `handleResponses Codex WS relay selection > an older runtime stays on HTTP SSE without
opening a WebSocket`, which is skipped on `dev` as well and unrelated to the bump.

Typecheck also clean:

```
$ bun x tsc --noEmit
EXIT=0
```

This is the meaningful check for the `@types/bun` half of the bump — `1ab272b83` ("bun-types: defer Event and
EventTarget to lib.dom when it is loaded", #40576) is a type-surface change in the range, and it produces no
errors here.

**Caveat on the runner.** These focused runs executed under the *host* Bun, which is `1.4.0`
(`bun install v1.4.0 (34cbb9a40)`; `bun --version` → `1.4.0`). `bun@1.4.2` was installed into
`node_modules` and `node_modules/.bin/bun --version` reports `1.4.2`, so the dependency tree and the type
definitions under test are genuinely 1.4.2 — but the *runtime executing the tests* was 1.4.0. The behavior
deltas in section (c), especially the `--isolate` test-runner changes and the Windows errno spelling, are
therefore **not** locally exercised. Only CI, which installs 1.4.2 via `setup-project-bun`, proves them.
Treat local green as necessary, not sufficient.

Recommended additional focused files for the authoring commit, given the napi-finalizer and child_process
items in the range: any keyring-touching test (`@napi-rs/keyring` is a direct dependency, affected by
`e2eac5f48`) and the service-lifecycle suites. Per `AGENTS.md`, this bump changes `package.json`/`bun.lock`,
which are read as data by many source-oracle tests rather than imported — exactly the case `AGENTS.md` names
as the exception where `test:changed` cannot see the dependency. **The full `bun run test` is required for
this PR** both for that reason and as the PR-ready gate.

## CI expectations

The bump touches three files on the expensive-CI allowlist pinned in
`tests/ci-workflows/ci-workflows.test.ts:511-530` — `"Dockerfile"`, `"bun.lock"`, and `"package.json"` all
appear in `ciPaths`. Full CI will run; no path-filter skip is possible, which is the correct outcome for a
runtime change.

Expect, at the PR head:

- All `ci.yml` lanes on Linux, Windows, and macOS running under Bun **1.4.2** (resolved by
  `setup-project-bun` from the new `package.json` line), covering 9 usages in `ci.yml` and 3 in
  `service-lifecycle.yml`.
- The Windows lanes are the ones to read carefully, per `03a3f9f25` (`NOENT` → `ENOENT`) and `2b3f66011`
  (unmapped Win32 codes now `EUNKNOWN` instead of success). A failure there is a real signal about an
  assertion coupled to an old Bun error string, not flake.
- The `--isolate` shard lanes may behave differently under `bf123ad7c` (env side effects undone between files)
  and `e1c13251d` (allocation limit restored per file). A test that passed by inheriting env from an earlier
  file in the same shard would now fail — and that failure would be a latent bug this bump surfaced, not a
  bump defect.
- Docker build lanes pull the new index digest; both linux/amd64 and linux/arm64 children are confirmed present.
- `bun install --frozen-lockfile` (`Dockerfile:14`, `Dockerfile:17`) must succeed against the regenerated lock —
  verified locally by the clean `bun install`.

Per the maintainer-goal priority this is item (4), the lowest of the four, and it should land **after** the
luvs01 fixture train so that a CI-fixture failure and a runtime-bump failure are never in flight together.
Landing it last means any new red lane is unambiguously attributable to the runtime change.

## Gap worth recording (not part of this bump)

**Nothing asserts `Dockerfile`'s `BUN_IMAGE` tag matches `package.json`'s `dependencies.bun`.**
`tests/ci-workflows/install-scripts.test.ts:68` pins the `package.json` value and
`tests/service/container-bootstrap.test.ts:63,92` read the `Dockerfile`, but only for env/COPY/VOLUME
directives — never the `ARG BUN_IMAGE` line. The alignment is enforced solely by the prose comment at
`Dockerfile:3` ("Keep the runtime aligned with package.json"). A future bump that edits `package.json` and
forgets the `Dockerfile` ships a container on a different runtime than CI tested, and every gate stays green.

That is the same class of silent drift that `.github/workflows/cleanup-orphaned-workflows.yml:40` already
demonstrates: it opted out of the SOT and sat at 1.3.14 across a full minor bump without anything noticing.
A one-line assertion in `tests/service/container-bootstrap.test.ts` parsing the tag out of `ARG BUN_IMAGE`
and comparing it to `package.json` `dependencies.bun` would close it. Both belong in **separate,
independently-revertible commits**, per the repository's one-bug-per-PR rule — not folded into the pin bump.

## Shared files / stack order

**Files this lane touches:** `package.json`, `bun.lock`, `Dockerfile`,
`tests/ci-workflows/install-scripts.test.ts`.

**Overlap with the luvs01 fixture train** (#4004 #4012 #4014 #4015 #4039 #4034 #4041 #4036 #4043 #4025 #4006
#3997): **none at file level.** That train is CI fixture and test-determinism work under `tests/` subdomains
and `src/`; this lane touches two root manifests, the `Dockerfile`, and exactly one test file in
`tests/ci-workflows/`. The one file worth watching is
`tests/ci-workflows/install-scripts.test.ts` — if any fixture-train PR also edits it, the two collide on
lines 68/71. Nothing in the current dev state suggests that, but it is the single check to run before
stacking.

**Recommended order:**

1. luvs01 fixture train lands first (highest priority per the maintainer goal, and it stabilizes CI).
2. Bug PRs and small provider/compat fixes.
3. **This bump last, alone, on its own branch off the then-current `dev`.** `bun.lock` is the classic
   textual-conflict magnet — any other PR that adds or moves a dependency forces a regeneration. Because the
   lock here is fully derived, a conflict is resolved by re-running `bun install --lockfile-only` on the
   rebased head rather than by hand-merging hunks. Never hand-resolve a `bun.lock` conflict.
4. Optional follow-ups, each its own commit: the `cleanup-orphaned-workflows.yml` 1.3.14 → SOT repair, and the
   `Dockerfile`/`package.json` alignment assertion.

**Scratch cleanup:** `git -C /tmp/ocx-249.xGQnxl/wt worktree remove --force /tmp/ocx-bun142-1lrK/wt`
(the scratch tree carries an installed `node_modules` and the uncommitted 4-file diff).

## Verdict

**LAND_WITH_FIX.** `bun@1.4.2` and `@types/bun@1.4.2` are published and current; the `oven/bun:1.4.2` index
digest is confirmed with both required platforms; the change is four files, 22 insertions and 22 deletions,
with a fully derived lock diff containing no reordering; typecheck is clean and 352 focused tests pass. The
"fix" carried alongside the obvious two-line bump is mandatory and proven: without
`tests/ci-workflows/install-scripts.test.ts:68,71`, the suite goes red, and without `Dockerfile:4` the
container silently diverges from CI with no gate to catch it. `MIN_FIXED_BUN_VERSION` and
`MIN_BOUNDED_CODEX_WS_BUN_VERSION` stay at `"1.4.0"` — they are thresholds, not mirrors.

The residual risk is entirely in what could not be exercised locally: 488 upstream commits including
`--isolate` test-runner semantics and Windows errno spelling, under a host runtime that is still 1.4.0. That
risk is discharged by exact-head CI on all three platforms, not by the local green reported above.

Nothing was committed, pushed, merged, or commented. No `cxc` orchestration, loop, or goal command was invoked.
