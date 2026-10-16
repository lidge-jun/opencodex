# 031 — wp3 execution packets (cycle plan, PR C → dev)

**Continuity.** wp2 D (019) said "wp5 guards next, then wp3". The goalplan cursor selected wp3 first (registration
order; both are ready), and the two are independent, so wp3 runs now on `codex/ocx-launcher-bun-fallback` from dev
fd2032050a; wp5's packets (021) and branch stay ready. 030 anchors were written against c15037b324; dev's move to
fd2032050a did not touch bin/, src/lib, src/cli/root.ts or src/cli/version-skew.ts, so they hold.

Contract: 030 incl. r2/r4 (later wins) + 003. PR A (#6802) already added the "Using the ocx CLI with the desktop app"
section to the docs-site desktop guide, so this PR does not touch that page (040's doc item is satisfied there).

| Worker | Write scope | Notes |
|---|---|---|
| K1 launcher | NEW `src/lib/bun-path-runtime.mjs` + `.d.mts`; MODIFY `bin/ocx.mjs`; tests `tests/cli/ocx-launcher-runtime.test.ts`, `tests/cli/ocx-launcher-source.test.ts`, `tests/ci-workflows/bun-runtime.test.ts` | order override → bundled → installer recovery → validated PATH; identity `-e` probe; POSIX writable rejection; same major, minor ≥ pinned; macOS Desktop CLI pointer in `fail`; source assertion scoped to `resolveBun`/`fail` |
| K2 skew notice | NEW `src/cli/version-skew-notice.ts`; MODIFY `src/cli/root.ts`; tests `tests/cli/cli-version-skew.test.ts` | lifecycle commands only, 200 ms, neutral text, never changes exit code, skip --json/--help |
| K3 docs | `structure/runtime.md` (net 0, cap 600), `structure/ops/docs-and-release.md`, `structure/ops/service-and-sidecars.md` (launcher paragraph ~:139 only), docs-site install troubleshooting page(s) named in 030 §"MODIFY public installation troubleshooting" (en + ko; other locales must not contradict) | PR A edits other paragraphs of service-and-sidecars.md/runtime.md; touch only the launcher text |

Verifier (main): `bun test tests/cli/ocx-launcher-runtime.test.ts tests/cli/ocx-launcher-source.test.ts tests/ci-workflows/bun-runtime.test.ts tests/cli/cli-version-skew.test.ts tests/cli/cli-head.test.ts` (isolated
`OPENCODEX_HOME`), `bun run typecheck`, ratchet, structure:check, privacy:scan, docs-site build, and a real Node
reproduction of the reported failure: a temp copy of the package without `node_modules/bun` launched with
`node bin/ocx.mjs --version` and a PATH containing the user's Bun → succeeds with the fallback notice (read-only; no
proxy start).


Reflection (Pascal): MISALIGNED → folded: main's verifier also runs `tests/cli/cli-help-recovery.test.ts`,
`tests/cli/cli-ready.test.ts`, `tests/cli/cli-ready-subprocess.test.ts`, `tests/cli/cli-resolve.test.ts`,
`tests/cli/cli-resolve-subprocess.test.ts` (030:1076). Combined-tree check (030 r4): main merges PR B's and PR C's
branches into a scratch branch before the later PR's last push and runs ocx-launcher-source + ocx-launcher-runtime there.

Audit (reviewer 01a11e4b): GO-WITH-FIXES (blockers=1), folded: the Node reproduction runs with a child-only
environment — `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, `OPENCODEX_HOME`/`CODEX_HOME`/`HOME`-derived caches pointed at the
temp fixture, `OPENCODEX_BUN_PATH` unset, PATH = the user's Bun directory plus system dirs (child only), and the temp
package copy keeps every installed dependency except `node_modules/bun` so nothing installs during the run.
