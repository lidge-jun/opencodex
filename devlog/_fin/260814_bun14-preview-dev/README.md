# preview-dev — Bun 1.4 product candidate branch

`preview-dev` is not a feature branch. It is the staging line where the Bun 1.4
migration is finished **before** Bun 1.4.0 reaches npm, so release day is a
dependency bump instead of a migration.

```text
dev (stable line, Bun 1.3.14)
└─ preview-dev (Bun 1.4 canary + compatibility/memory patches)
   └─ Bun 1.4.0 on npm
      └─ canary → stable commit
         └─ preview-dev → dev → preview → main
```

Upstream tracking issue: **#1691**.

## Current state (2026-08-14)

Landed on `preview-dev`:

- `c7c34f6e3` — CI reads the Bun version from `package.json`; `preview-dev` is a
  CI-qualified push target.
- `f8f9200d4` — this plan unit (decade docs `010`–`100`).
- `d29b837e3` — this README.
- `bce1fe8f4` — the GitHub canary qualification channel (`011`).

**The canary is available, just not on npm.** npm has no 1.4 line
(`latest 1.3.14`, `canary 1.3.13-canary.20260425.1`), but the `oven-sh/bun`
GitHub `canary` release already serves **1.4.0-canary.1+032b8dbf1**. So the
runtime is reachable today through the existing `OPENCODEX_BUN_PATH` override:

```bash
bun scripts/runtime/fetch-canary-bun.ts --json
CANARY="$(bun scripts/runtime/fetch-canary-bun.ts --print-path)"
OPENCODEX_BUN_PATH="$CANARY" bun run typecheck
```

`package.json` deliberately stays at `1.3.14` — that is the runtime users
install. npm is the destination on stable day, not the prerequisite.

The runtime patches (stream caps, relay byte queue, fetch body disposal, worker
settle skip) are still **not** committed. Each is gated on a *qualified*
`Bun.revision`, and `qualifiedRevisions` in
`scripts/runtime/qualified-bun.json` is empty until CI proves a revision on
every supported OS. Having the binary is not qualification.

## Resuming

```bash
git fetch origin
git switch preview-dev
git rebase origin/dev     # keep the stack on current dev
```

Push to `preview-dev` and the `bun-canary-qualify` lane runs the suite against
the canary and reports its revision. When that is green across the supported
platforms, add the revision to `qualifiedRevisions` in its own commit — that
single edit is what opens `050` and `080`.

Then work the decade docs in dependency order. Each doc is one PABCD cycle and
carries its own diff-level file map:

| Doc | Commit | Depends on |
|-----|--------|------------|
| `011` | `ci(runtime): qualify Bun 1.4 from the GitHub canary channel` | done |
| `020` | `chore(runtime): move the npm dependency to Bun 1.4` | stable release day |
| `030` | `test(runtime): record bundled Bun version and revision` | 020 |
| `040` | `test(memory): 1.3.14 vs 1.4 wave and quiescence harness` | 020 |
| `050` | `perf(stream): eager relay for qualified canary revisions` | 020 |
| `060` | `perf(stream): exact byte queue and global relay budget` | 050 |
| `070` | `fix(fetch): cancel unconsumed bodies on retry and failure` | 020 |
| `080` | `perf(worker): skip 1.3.14 OS join settles on qualified Bun 1.4` | 020 |
| `090` | `test(runtime): isolate teardown without legacy job splits` | 080 |
| `100` | `docs(release): promotion and rollback` | all |

The qualified `Bun.revision` gates the rest: `050` and `080` branch on it. Do
not open those gates on a version string — that is what `011` exists to prevent.

## Branch invariants

```text
merge-base(preview-dev, dev) == dev, or a very recent dev
preview-dev unique commits == Bun 1.4 migration commits only
```

Rebase onto `dev` daily, or right after any significant merge. If unrelated
feature drift accumulates here, release-day triage cannot tell a Bun regression
from a feature regression — which is the entire reason this branch exists.

## Release day

One commit:

```diff
- "bun": "1.4.0-canary.N"
+ "bun": "1.4.0"
- export const MIN_FIXED_BUN_VERSION: string | null = null;
+ export const MIN_FIXED_BUN_VERSION = "1.4.0";
```

Plus `bun.lock` regeneration and removal of canary-only waivers. Promotion order
is `preview-dev → dev → preview → main`; see `100_promotion_docs.md`.

## Rollback devices — keep until the first stable-1.4 release

- `OPENCODEX_BUN_PATH` pointing at a 1.3.14 binary
- `streamMode=legacy-tee`
- the 1.3.14 worker settle fallback
- split fresh-process CI jobs
- the 1.3.14 A/B benchmark binary

## Not allowed on this branch

- `npm publish` from `preview-dev` — the release workflow stays pinned to
  `preview` and `main`, which is what prevents an accidental canary publish
- enabling runtime capability from a canary semver alone, without a qualified
  `Bun.revision`
- `Bun.gc(true)` on a timer, `--smol` as a default, or blanket cache-cap cuts
