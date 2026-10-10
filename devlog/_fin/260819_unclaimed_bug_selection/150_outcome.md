# 150 — outcome: what shipped, what stayed open, what is still unverified

Closing record for the 260819 unclaimed-bug unit. Five PRs on `dev`.

| PR | dev | issue | disposition |
|---|---|---|---|
| #2116 | `bdaf4463a` | #2107 | **closed** — proxy env baked into service definitions |
| #2117 | `c701cc7e6` | #1933 | open — decoding fixed, diagnosis unproven |
| #2118 | `239cae9e5` | #1527 | open — 1 of 5 residuals fixed |
| #2121 | `fbc6f26a2` | #2108 | open — diagnostic shipped, mechanism not |
| #2126 | `8e7b63387` | — | audit remediation |

Only #2107 is closed, and that asymmetry is the point: three of the four fixes
are slices, and saying so on the issue is cheaper than a reopen.

## The two defects our own work introduced

Worth leading with these rather than the wins.

**A cross-file test leak that read as CI flake.** The #2107 tests assigned proxy
variables onto the real `process.env` and restored them in a `finally`. `bun
test a b` runs every file in ONE process — `--isolate` does not change that — so
the values outlived the file, and the Lab sandbox rejects any live proxy variable
as `harness_failure`. 73 macOS failures, zero when the Lab suites ran alone.

**A credential written world-readable.** #2107 made service definitions
credential-bearing (a proxy URL routinely carries `user:password`) while they
were still written with a bare `writeFileSync` — 0644 under umask 022, measured.
In a file where the API token and install state already use 0600, and in a repo
whose `collectProxyEnv` deliberately reports proxy presence as a boolean so the
URL never escapes.

The second one merged. It was caught only because the final audit asked a
question the author never asked — *what mode is that file?* — and then measured
instead of reasoning.

## What actually caught things

- **Ablation, three times.** The #1527 fix looked right at `failAndClear` and all
  ten tests still passed — that helper is not on the failure path. The first
  proxy-leak theory (Bun spreading `null`) produced 50 fail / 50 fail with and
  without the "fix". A number that does not move is not a fix.
- **Running the suite the way CI runs it.** Per-suite local green missed the leak
  entirely, because the defect only exists across suites in one process.
- **Removing our commits.** The same two files on `origin/dev` went 144 pass / 0
  fail. That is what converts "CI is flaky" into "we broke it".
- **An auditor that re-derives rather than re-runs.** Round 1 returned fail on
  #2121's design; the final round found the P1 and mutation-tested our
  assertions in a scratch tree to prove they were not vacuous.

## Still unverified, stated rather than filed as done

Everything below is real and none of it is closed by this unit.

- **Windows.** The Windows ACL half of the 0600 fix and the `utf16le` scheduler
  assets are asserted for mode on POSIX only. `owner-unavailable` — the branch
  #2108 most needs named — is a Windows icacls path asserted nowhere in the
  suite.
- **#1933's diagnosis.** The encoding mechanism is proven in code; that it is
  *this reporter's* problem is inference from a GitHub display name. If their
  path is ASCII, the diagnosis is wrong and the issue should stay open.
- **#1527's other four residuals.** kimi-k3 collapse and the 429 asymmetry depend
  on #2054. The 429 half may be unprovable while Connect withholds
  `cache_read_tokens`.
- **#2108 phase 2.** Waiting on a field report that names a reason. Two candidate
  triggers, and phase 2 targets one of them.
- **wp1587**, the deferred tool catalog, was never implemented. Both its blockers
  cleared, so it is ready, not done.

## Final state

`dev` full suite on `ssh lidge`: **13,505 pass / 15 skip / 0 fail** across 855
files. Cross-platform CI green on the merged head.

