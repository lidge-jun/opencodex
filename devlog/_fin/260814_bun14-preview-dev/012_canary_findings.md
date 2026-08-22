# 012 — What the canary lane found

A running log of behaviour differences between the bundled stable runtime and
the qualification candidate. This is the output the lane exists to produce:
each entry is a difference that would otherwise have surfaced on Bun 1.4
release day, with production traffic attached.

- control: `1.3.14+0d9b296af` (npm bundled)
- candidate: `1.4.0-canary.1+032b8dbf1` (GitHub `canary`)

## F1 — TOML datetime is now supported (real upstream change)

**Bun 1.4 added TOML datetime parsing.** Measured directly:

```text
Bun.TOML.parse('model_catalog_json = 1979-05-27T07:32:00Z')

1.3.14 →  THREW BuildMessage: Expected key but found -
1.4.0  →  type=string  "1979-05-27T07:32:00Z"
```

Fallout: `tests/codex-native-residue.test.ts` asserted that every non-string
TOML type for `model_catalog_json` lands on `surface: "config"`. On 1.3.14 that
holds because the document does not parse at all. On 1.4 the value parses to a
string, `src/codex/native-residue.ts` accepts it (it requires a non-empty
string, and now gets one), resolves it as a path, and the CATALOG surface
reports it absent.

`src/` is correct on both runtimes — only the test's assumption was
version-specific. Fixed in `4e64e96f7` by splitting the datetime case out and
asserting the property that survives both: the classification is
`indeterminate`, blamed on `config` or `catalog`, and coordinator
initialization is refused either way.

**Worth noticing beyond the test:** any config key read through
`Bun.TOML.parse` that a user could write as a bare datetime literal silently
changes type between these runtimes — throw on 1.3.14, string on 1.4. This is
the only such key in the tree today, but it is the shape to watch for.

## F2 — SHASUMS256.txt lags the rolling assets (upstream artifact, not a bug here)

## F1c — TOML values must start on the assignment line (real upstream change, and it found a latent bug)

**Bun 1.4 enforces the TOML rule that a value begins on its assignment line.**

```text
[features.multi_agent_v2]
hint =
[
  ["nested"],
]
enabled = true

1.3.14 → {"features":{"multi_agent_v2":{"hint":[["nested"]],"enabled":true}}}
1.4.0  → THREW: Missing value after '='; values must be on the same line
```

1.4 is right; the document is not valid TOML.

What makes this the most interesting finding so far is that it exposed a
**latent defect in our own fallback**, not just a test assumption.
`multiAgentV2EnabledFromConfigText` tries a real parse first and falls back to a
line-based scanner when the parse fails. On 1.3.14 the parse always succeeded
here, so the fallback was never exercised for this shape. On 1.4 the parse fails,
the fallback runs, and `tomlTableBody` reads the `[` on the line after `hint =`
as a table header — truncating the table before `enabled = true` and answering
`false` for a feature the user enabled.

That is exactly the failure mode the function's own comment warns against:
"reporting a feature as disabled on account of an unreadable file presents a
failure as a state."

The scanner itself is off limits — its comment records that making it
string-aware previously gave `getAgentsEnabled`, `getAgentsMaxDepth`, and
`getMaxConcurrentThreads` three new wrong answers, and twenty call sites consume
its output. So the repair is at the call site: if the real parse fails, join
dangling `key =` lines to the value that follows and parse once more. If the
joined document parses, that answer wins; if it does not, the old fallback runs
unchanged. The unmodified document is always tried first, so a bad join cannot
displace a correct read.

Fixed in `src/codex/features.ts`. 132 pass / 0 fail on both runtimes.

## F1b — An empty PATH is now passed through to children (real upstream change)

**Bun 1.4 stopped ignoring `PATH=""`.** Measured by having a child print its
own `$PATH` while the parent set `process.env.PATH = ""`:

```text
1.3.14 → CHILD_PATH=[/Users/…/bin:/opt/homebrew/bin:/usr/bin:/bin:…]   (parent's real PATH)
1.4.0  → CHILD_PATH=[]                                                 (what was actually set)
```

1.4 is right. 1.3.14 silently substituted the inherited PATH, so `PATH=""` was
never really in effect.

Fallout: three tests in `tests/codex-runtime.test.ts` set `PATH=""` to stop
PATH-based codex discovery, but their fake launchers are `/bin/sh` scripts that
call `dirname` and `cat`. On 1.3.14 those resolved through the leaked PATH; on
1.4 they fail with `dirname: No such file or directory`, the launcher exits
non-zero, `loadBundledCodexCatalog()` returns null, and the assertion sees
`undefined` where it expected `false`.

The intent was to defeat discovery, not to starve the script of coreutils, so
the fix is `PATH=/usr/bin:/bin` — utilities reachable, no `codex` on it. Fixed
in `tests/codex-runtime.test.ts` via a named `NO_CODEX_PATH` constant.

**Worth noticing beyond the test:** any code that clears `PATH` to sandbox a
child now genuinely gets an empty PATH on 1.4. Checked, and production is
clear: `rg 'PATH\s*[:=]\s*""|delete .*\.PATH' src/ bin/ scripts/` returns
nothing, and the one generated shell script in the tree
(`buildUnixCodexShim`) uses only shell builtins — `printf`, `exit`, `case` —
so it has no coreutils dependency to lose. The exposure was test-only, but a
spawn that relied on the old leak would have broken at runtime rather than in
a test.

```text
bun-darwin-aarch64.zip  updated 2026-08-14T11:52:50Z
SHASUMS256.txt          updated 2026-08-13T14:30:31Z
published digest        e5fab4d53d07…
actual digest           f153e5eca706…
```

Two independent downloads produced identical bytes and an identical revision,
so the assets are stable per-moment; the manifest is what is stale. Recorded in
`011`: `shasumsMatch` is advisory, `Bun.revision` is the pin.

## F3 — The harness qualified the wrong runtime (our bug)

`scripts/ci/run-bun-test-batches.sh` invoked `bun` from PATH, so the lane
exported `OPENCODEX_BUN_PATH` and then ran the bundled stable binary anyway —
a qualification that never happened, reported as if it had. Fixed in
`bce1fe8f4`.

This one is the argument for running the lane at all rather than reasoning
about the runtime on paper.

## F4 — Our own CI drift, surfaced by the lane (our bug)

The first canary run failed `tests/ci-workflows.test.ts` with 3 failures and a
runtime crash. The same 3 failed identically on 1.3.14: earlier commits on this
branch moved the pinned `setup-bun` SHA into the composite action, added a job,
and added a branch, while the hardening test still described the old shape.
Fixed in `7bab92781`.

Bun 1.4 was innocent. Noted because "the canary run is red" is not by itself
evidence about the canary — the control run is what decides that.

## Full-suite result

Run on a dedicated machine (Mac mini, macOS 15.7.4, arm64, 10 cores) rather
than a laptop shared with other work, so a stall could not be confused with
contention:

```console
$ bun test --isolate --timeout 60000 tests/     # bun = 1.4.0-canary.1 (032b8dbf1)
 11712 pass
 8 skip
 0 fail
Ran 11720 tests across 726 files. [422.37s]
CANARY_EXIT=0
```

Every difference above is closed. Note the machine had no Node installed at
first and `tests/cursor-native-exec.test.ts` failed twice — identically on BOTH
runtimes, because the test shells out to `node`. Environment, not runtime;
installing Node 24 cleared it. Same discipline as F4: a red run is not evidence
about the candidate until the control run says otherwise.

## Not yet observed

Nothing yet on the surfaces the migration actually targets: SSE relay
behaviour, Worker teardown timing, or fetch receive-backpressure. A green
functional suite says the runtime swap is safe; it says nothing about the
memory characteristics this migration is FOR. Those need the memory harness
(`040`) and the revision-gated paths (`050`, `080`), which stay closed until a
revision is in `qualifiedRevisions`.

## Promotion status

`qualifiedRevisions` is still EMPTY. One green macOS run is not qualification
across the supported platforms — Linux and Windows are exactly where the Bun
1.3.14 Worker and isolate problems lived, and they are the reason the split
fresh-process CI jobs exist. The CI lane on `preview-dev` is what supplies
the remaining evidence.
