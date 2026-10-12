# A-phase audit findings and dispositions

Three independent audits were run against `000`-`040` before any implementation:
adversarial process-termination safety, platform-primitive verification against live
hosts, and repository-coverage completeness.

Verdicts: safety **FAIL** (3 blockers), coverage **FAIL** (3 blockers), primitives
**PASS** (0 blockers, 6 nits). Every blocker is folded below. Nothing is rebutted
away.

## Blockers

### B1 — the ancestry bound failed open (safety)

`ancestryPids` is bounded at 16 hops, and the plan never said what happens when the
bound is **hit**. A truncated list makes the self-ancestry intersection miss, so the
direct path would terminate the caller's own tree — the exact failure wp5 exists to
prevent. Deep nesting is not hypothetical here: agent shell, app-server, nested
`ocx`, tmux.

**Disposition: accepted.** Hitting the bound returns `[]`, identical to an unreadable
hop, so the ladder fails closed into `self_ancestry` and therefore into a handoff.
Recorded in `010` §3.4.

A second, opposite semantic had to be pinned at the same time (primitives nit 1): a
parent pid that names **no live process** is a clean end of chain, not a read
failure. Windows never reparents orphans, so the handoff helper always has a dead
parent link; treating that as unreadable would make the helper refuse forever and
wp5 would never work on Windows. Both semantics live in the same paragraph because
getting one right and the other wrong breaks the feature in opposite directions.

### B2 — concurrent handoffs could kill the relaunched app (safety)

Two `ocx sync --restart-codex` runs inside the app, or a handoff racing an ssh-issued
direct run, spawn two ladders. Helper A quits and relaunches; helper B re-enumerates
during the relaunch, sees the **new** root as a target, and kills it. Repeatedly.

**Disposition: accepted.** An atomic singleton lock now guards every restart that
acts, direct or handoff. Recorded in `020` §4.1.

### B3 — path-prefix membership was not boundary-aware (safety)

"`comm` starts with `<bundle>/`" and "under `<root>/`" implemented as a raw
`startsWith` admits `/usr/lib/chatgpt-evil/...` and `/Applications/ChatGPT.app-evil/...`
as members.

**Disposition: accepted.** The root is `realpath`-resolved once at discovery and
compared with an explicit trailing separator. Recorded in `010` §2.1.

### B4 — `catalog pull` was missing, and the plan contradicted a documented exclusion (coverage)

`030` §3.1 claimed one shared scope helper served `catalog pull`, but `src/cli/catalog.ts`
appeared nowhere in the file table, its `knownFlags` set would **reject** the new
flags as a usage error, and it is a fourth `afterCatalogWriteHandleAppServers` call
site. Meanwhile `docs-site` states in English plus `zh-cn`, `zh-tw`, `tr` and `ru`
that desktop restart is not part of that command.

**Disposition: accepted, resolved toward consistency.** `catalog pull` gets the
merged meaning.

The documented exclusion and the `sync` split are not the same kind of statement, and
that is what decides it. The `sync` split was a **consent** decision, argued on the
grounds that quitting the app ends live conversations
(`devlog/_fin/260822_backlog_disposition_program/040_wp4_issue_2292_windows_picker.md`).
The `catalog pull` sentence is a **scope** statement: the capability was Windows-only
and nobody wired it there. Reversing a consent decision needs the maintainer
instruction in `000` §4, which exists. Reversing a scope statement needs only the
capability, which this unit builds.

A flag that means two different things depending on which subcommand it follows is
the confusion this unit is removing, so `--restart-codex` means one thing everywhere.
Full file list in `030` §3.4 and the locale list in `030` §7.

### B5 — the wire `restartCodex` field was unspecified across a machine boundary (coverage)

`POST /api/machine/sync` accepts `restartCodex` from a remote hub
(`src/client/machine-api.ts:79-95`), and `syncConnectedClient` takes it and
deliberately ignores it (`src/client/connect.ts:649-650`, the `_options` underscore).
Under merged semantics the same name would silently mean "quit the user's desktop
app" over a network boundary.

**Disposition: accepted, resolved as no change in meaning.** The wire field keeps
app-server-only semantics and stays unhonored. A remote hub does not get to end a
local user's conversations because a field name changed underneath it; that is a
consent boundary, and the maintainer instruction in `000` §4 is about the local CLI
flag, not about remote callers.

This is pinned by a test rather than left to a comment, because the failure mode is
a future contributor "finishing" an obviously-dead parameter. Recorded in `030` §4.1.

### B6 — the post-write helper returned `void` (coverage)

`catalog pull` derives `codexRestarted` and its `restart_incomplete` code from the
restart result, which a `void` helper cannot provide.

**Disposition: accepted.** The helper returns a `RestartScopeOutcome`. Recorded in
`030` §3.3.

## Nits accepted

| # | Finding | Where folded |
|---|---|---|
| N1 | Linux install root must be trusted, not just `dirname(realpath(launcher))` | `010` §5 discovery |
| N2 | macOS `lstart` is 1-second granular; same-second reuse by another member defeats equality | `010` §2.1 residual |
| N3 | `/proc/<pid>/stat` field 22 must be parsed after the **last** `)` | `010` §5 |
| N4 | member ordering must sort start time numerically, not lexically | `010` §5 |
| N5 | macOS multi-install: path-scoped membership vs bundle-id-scoped quit/relaunch | `010` §4 |
| N6 | Linux relaunch env needs `HOME`/`USER`/`LANG`/minimal `PATH`, not only the five session vars | `010` §5 |
| N7 | `excludePids` can go stale between enumeration and the signal pass | `030` §2 |
| N8 | the hidden handoff command is intentionally unauthenticated; say why | `020` §5 |
| N9 | `open -b` needs a logged-in GUI session; headless macOS relaunches into nothing | `001` §1.2 |
| N10 | `taskkill /T` pid-recycle race could pull the helper into the kill set | `020` §8 |
| N11 | helper spawn `args` recipe is unspecified for installed vs checkout `ocx` | `020` §4.2 |
| N12 | `open -b` foregrounds the app; make it deliberate | `010` §4 |
| N13 | `010` §3.1's reason union is extended by wp5 | `010` §3.1 |
| N14 | `warnIfStaleCodexAppServersAfterStartupWrite` stays warn-only | `030` §5 |
| N15 | `layout.explicit` must equal the fixture table if anyone adds an entry | `030` §6 |

## Confirmed by live probe, not assumed

The primitives audit reproduced every platform claim on real hosts rather than
trusting the plan: `open -b` launching a non-running app and failing loudly on an
unknown bundle id, `osascript` `quit app id` syntax, macOS `ps -o comm=` returning
untruncated full paths over 140 characters, `/usr/bin/setsid` present on `lidge` with
`spawn({detached:true})` + `setsid` being redundant-but-safe, `/proc/<root>/environ`
being 1902 NUL bytes while children carry `XDG_RUNTIME_DIR`, and a detached
`unref()`ed Bun child outliving its parent. It validated the destructive primitives
against Calculator rather than the Codex app.

That matters for one claim in particular: `ps -o comm=` truncation would have
silently broken macOS membership, and it was checked rather than reasoned about.
