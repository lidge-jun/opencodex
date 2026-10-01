# 010 Diagnosis and diff-level plan

## Symptoms (2026-09-30, while verifying #6304)

1. `bun run test:changed` from the Codex-managed worktree `~/.codex/worktrees/77b7/opencodex`: 863 failures. A sample file (`tests/codex-integration/model-visibility-management-api.test.ts`) fails 23/23 on its own with `refusing to remove a path inside the real Codex home (~/.codex) from a test process: ".../tests/codex-integration/.tmp-model-visibility-management-<pid>" resolves there`. The same head cloned to `/private/tmp` drops to 56 failures.
2. `tests/service/shutdown-launcher.test.ts` fails SIGINT/SIGTERM/SIGHUP at both `dev` `6538001e2f` and the #6304 head: `The proxy answered /healthz but did not inject Codex config ... Proxy already running on port 10100; requested a second instance on port <n>`.

## Causes

1. `protectedRemovalReason` (`src/lib/test-home-guard.ts`) refuses any removal target inside `~/.codex`. Forty test files keep their fixture directory next to the test (`join(import.meta.dir, ".tmp-...")`) and clean it through `removeTreeWithRetry`. When the checkout itself is a Codex-app worktree under `~/.codex/worktrees/`, every such cleanup is refused, although the directory is repository content the test created, not Codex state.
2. The launcher test gives the child a fresh `OPENCODEX_HOME` with no `config.json`. `handleStart` probes the configured port (`findProxyOwnerBeforeJournalRecovery({ probeConfiguredPort: true })`), which defaults to 10100. On a developer machine running ocx there, the child finds that live owner, takes the sibling path, and by design never injects Codex config, so the test's precondition never arrives. CI has no proxy on 10100, which is why it only fails locally.

## Diff

- `src/lib/test-home-guard.ts`: a removal target strictly inside the checkout that loaded the guard (`resolve(import.meta.dir, "../..")`, both canonical and lexical spellings) is not a protected location. Equality and ancestor checks still run first for every protected tree, so the checkout root itself and anything above it stay refused; outside a checkout that lives under a protected tree the exemption changes nothing. Computed lazily so production module load does no extra work.
- `tests/ci-workflows/test-home-guard.test.ts`: a probe with a sentinel real home whose `.codex` is a symlink to the checkout's parent, so the checkout sits inside the protected Codex home. Asserts a fixture path under `tests/` is allowed, while the checkout root, its parent and a sibling of the checkout are refused. Skipped where symlinks are unavailable, like the existing symlink probe.
- `tests/service/shutdown-launcher.test.ts`: write `{ "port": <freePort> }` to the fresh home's `config.json` so the configured-port probe targets the test's own port, not the host's 10100.
- `structure/`: record the checkout exemption where the guard is described, if a doc owns it.

## Verification

- `bun test tests/ci-workflows/test-home-guard.test.ts tests/service/shutdown-launcher.test.ts` from the managed worktree, with the host proxy live on 10100.
- `bun test ./tests/codex-integration/model-visibility-management-api.test.ts` from the managed worktree (23/23 failing before).
- `bun run test:changed` from the managed worktree: failures must fall to the `/private/tmp` level and contain no `refusing to remove`.
- `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`; exact-head CI; after merge, the `dev` push CI for both merge commits.

## Residual, out of scope

The `/private/tmp` full run still showed 5 s timeouts in the Claude picker/intercept TLS suites and service-state suites when 1566 files share one machine; each passes in isolation and on the sharded CI. Recorded, not changed here.


## Audit fold (NEAR-PASS, two blockers)

1. The exemption is tied to one protected tree. It lifts only the "inside `protectedPath`" refusal, and only when a checkout root spelling is strictly inside that same `protectedPath` and the candidate is strictly inside that checkout root. Equality, ancestor and real-home checks stay unconditional. A bunfs build (`import.meta.dir` under `/$bunfs/root`, root `/`) or a checkout at `$HOME` never satisfies "checkout inside the tree", so the guard is unchanged there. Probe: `OCX_REAL_HOME=<checkout root>` still refuses `<root>/.codex/x`.
2. Each spelling (canonical, lexical) is judged on its own and any refusal wins. Probe: a symlink inside the checkout that points at the protected tree outside the checkout is refused through its canonical form.

Notes taken: the launcher test also pins `GROK_HOME` and `OCX_OWNER_REGISTRY_DIR` into the fixture home (the `sibling-home-client-sync` pattern) so inherited real state cannot mark the child a sibling; the `protectedRemovalReason` doc comment is updated; verification adds a run from a checkout outside `~/.codex`.
