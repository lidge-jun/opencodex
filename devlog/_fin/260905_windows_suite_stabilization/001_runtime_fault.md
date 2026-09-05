# 001 — The first baseline used the wrong Bun. Everything it concluded is void.

Research doc. Written after the plan audit at `A` returned FAIL and its first
blocker turned out to be correct.

## What happened

The 2026-09-05 baseline in `000` was run with the Bun on the Windows box's PATH,
`~/.bun/bin/bun` = **1.3.14**. The repository pins **1.4.0**
(`package.json:68`, `dependencies.bun`), and `.github/actions/setup-project-bun`
installs exactly that version, keeping "the runtime SOT in one place". The
checkout already carried it at `node_modules/bun/bin/bun.exe`.

So the baseline measured a runtime that neither CI nor a correct local run uses.

## The controlled comparison

Same box, same checkout, same two files, same flags — only the binary differs:

```
$ ./node_modules/bun/bin/bun.exe test --isolate --timeout 60000 \
    tests/abort-idle-deadline.test.ts tests/codex-reset-credit-operation-ledger.test.ts
 50 pass · 0 fail · 211 expect() calls · [8.63s]

$ ~/.bun/bin/bun          test --isolate --timeout 60000 \
    tests/abort-idle-deadline.test.ts tests/codex-reset-credit-operation-ledger.test.ts
  6 pass · 44 fail · 203 expect() calls · [8.75s]
```

The 44-failure guard defect exists only on 1.3.14.

The wedge behaves the same way:

```
$ bun 1.3.14 test --isolate tests/client-hub-relay.test.ts tests/cline-pass-reasoning-efforts.test.ts
  → killed at the 240s deadline; the second file never printed a line (exit 124)

$ bun 1.4.0  test --isolate  (identical command)
  12 pass · 0 fail · [1.60s]
```

## What this invalidates

- `000` — every shard count. The four-shard baseline must be re-measured.
- `010` — the preload run-id provenance analysis. The mechanism it describes is
  real in the source (the auditor verified (a)-(e) line by line, correcting one
  citation: the non-win32 early return is `scripts/test-run-lock.ts:164`, not
  `:162`). What is NOT established is that this mechanism fires on the runtime
  the project actually uses. On 1.4.0 the guard arms and the same files pass.
- `020` — S1 and S6 were argued as ambient-`CODEX_HOME` defects. The auditor
  showed the preload assigns a per-file `CODEX_HOME` when it completes, so both
  may simply be downstream of the guard fault and disappear with the runtime.
- `030` — the wedge, and with it the attribution to
  `tests/cline-pass-reasoning-efforts.test.ts`.

## What survives

The ordered-pair experiment the auditor asked for was run, and it settles the
wedge boundary that adjacency alone could not:

| run | 1.3.14 | 1.4.0 |
|---|---|---|
| `cline-pass` alone | 6 pass, 0.95s | — |
| `client-hub-relay` → `cline-pass` | **wedged, exit 124** | 12 pass, 1.6s |
| `cline-pass` → `client-hub-relay` | 12 pass | — |
| pair without `--isolate` | 12 pass | — |

Order-dependent, `--isolate`-dependent, and runtime-dependent. That is an isolate
realm-transition fault in 1.3.14, not a defect in either test file — which is why
no code change was made against it.

## Method correction

Pin the runtime explicitly in every command against the box:

```bash
cd /c/ocxwin/repo && B=./node_modules/bun/bin/bun.exe && "$B" --version
```

A bare `bun` on that machine is 1.3.14 and must not be used for any measurement
that a conclusion depends on. `.github/workflows/ci.yml` never had this problem:
it calls `./.github/actions/setup-project-bun` before every test step.

## Cost of the mistake

Roughly 70 minutes of shard time and four documents' worth of analysis, caught by
the `A` gate before a single line of product code was changed. That is the gate
working. The re-measured baseline replaces `000` in `002`.
