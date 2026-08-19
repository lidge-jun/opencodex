# 000 — Unclaimed bug issues: investigation

Date: 2026-08-19. Scope: open `bug` issues with **no open PR planning to close
them**, for work starting after stage 3d of `260819_next_roadmap/070`.

## Candidate derivation (re-derived live, not copied)

Method: list every open `bug` issue, then scan every open PR's title+body for
`#NNNN` references and subtract.

```
open bug issues (19):
  1049 1225 1419 1527 1587 1688 1730 1852 1924 1933
  1939 2047 2074 2092 2097 2106 2107 2108 2114

referenced by some open PR:
  1225(#2041) 1527(#2054) 1688(#2032) 1852(#1876) 1924(#2027) 1939(#2029)
  2047(#2056,#2062) 2074(#2082) 2092(#2099) 2097(#2101) 2106(#2112)

first pass => UNCLAIMED (8): 1049 1419 1587 1730 1933 2107 2108 2114
```

Timestamp of the derivation: `2026-08-19T11:45:42Z`.

### Correction: reference-counting is not claim-counting (9, not 8)

An audit lane re-derived this independently and returned PARTIAL. Nothing was
missing from the union, but **one exclusion was wrong**.

A `#NNNN` in a PR body proves a *mention*, not an intent to close. PR **#2054**
mentions #1527 and then says, verbatim:

> Does not close #1527. ... Refs #1527 (residual)

Its purpose is Cursor conversation-checkpoint reuse, which relieves some of the
token pressure behind #1527 but is not the reported failure (large-context
turns collapsing or rate-limiting while direct Cursor stays healthy). The
author explicitly reserved the residual.

**`#1527` is therefore still unclaimed. The set is 9, not 8.**

The other ten pairs were each read individually and are strong — every one is
"Fixes/Closes/Implements #N" with a diff whose whole purpose is that issue:
#2041→1225, #2032→1688, #1876→1852, #2027→1924, #2029→1939, #2056 and #2062
both→2047, #2082→2074, #2099→2092, #2101→2097, #2112→2106.

**Method note worth keeping.** The cheap derivation (scan for `#NNNN`,
subtract) is a *starting* filter, not the answer. It over-excludes exactly
where an author was being honest about scope — which is the opposite of what a
triage pass should punish. Any future run of this must read the referencing PR
and ask whether it intends to close the issue.

## Method

Eight read-only subagent lanes, one per candidate. Each was told to read the
full issue thread, locate the responsible code in the current tree, and report
a mechanism with `file:line` — or say CANNOT-DETERMINE rather than guess.

Two lanes had to be re-dispatched (the first batch went silent past three wait
cycles, DISPATCH-RETIRE-01). One candidate, `#1587`, ended up with two
independent lanes, which turned out to be useful: they agreed on the mechanism
and one of them produced a measurement the other did not.

## Findings

### #2114 — native-main 503 when systemctl exists but the user bus does not

**Mechanism (confirmed, two independent lanes).** `inspectSystemd()` maps only
`spawnFailed` to `absent`. Any non-zero `systemctl --user show` exit becomes
`unknown`:

```
src/service-manager-probe.ts:267   if (shown.spawnFailed) return { kind: "absent" };   // #1612 fix
src/service-manager-probe.ts:269   if (shown.status !== 0) return unknown(...)          // this bug
```

That `unknown` then closes native traffic for the life of the process:
`ownership-preflight.ts:155` → `ownership: "unknown"` → `server/index.ts:702`
→ `blockNativeMainStartupForUnownedServiceHome` → `auth-context.ts:313` →
`CodexMainProfileDrainingError` → 503.

**Why #1612 missed it.** #1612 covered *spawn* failure — `systemctl` not on
PATH. Here spawn succeeds and the bus is unreachable, so the escape hatch does
not apply.

**Regression, in two steps.** `a2e4fcf47` (2026-08-11) made
`ownership: unknown` block native-main at all; `bb45902ef` (2026-08-15, #1612)
relieved only the spawn branch. This environment has been broken since the
fence shipped.

**Blast radius.** Linux only, Codex integration enabled. Any host where
`systemctl` is present but the user bus is not: systemd-containing Docker /
devcontainer images under tini, and plausibly WSL without `systemd=true`.
Affected users get **100% native-OpenAI failure**, not degradation.

**Workaround.** Remove `systemctl` from the proxy's PATH — verified by the
reporter as a single-variable control. Setting `XDG_RUNTIME_DIR` does not help.

**Evidence.** Strong. Exact stderr, exit code, single-variable isolation, and a
traced chain that matches the source line for line. The repo currently **pins
the bug**: `tests/codex-service-manager-probe.test.ts:277` asserts that
`status: 1, stderr: "Failed to connect to bus"` is `unknown`.

### #2108 — Windows reboot leaves the native-main gate stuck

**Mechanism (partially determined — and the lane was right to say so).** The
503 is the same process-wide fence as #2114, but the *trigger* is not logged,
so two candidates remain:

1. **Owner ACL fail-closed.** A second `ETIMEDOUT` in the icacls hardening is
   terminal (`native-main-owner.ts:272`), and `observeOwner()` settles the gate
   to `owner-unavailable` and stops (`native-profile-startup.ts:227`). The ACL
   module's own comment already records this exact symptom. The reporter's first
   503 is ~74s after wrapper start, past the ~60s owner budget.
2. **Probe fail-closed.** `SERVICE_PROBE_TIMEOUT_MS` is 2000ms. A
   scheduler-only install still runs `sc.exe query` for WinSW; if that times out
   with the WinSW assets absent, `walkWinswChain()` returns `unknown` instead of
   `absent`.

**The important structural finding:** `startServer()` takes a **one-shot**
ownership verdict and never retries it (`server/index.ts:702-710`). That is why
the gate stays closed until `ocx restart` and why waiting does not help.

**What it is not.** The lane disproved two plausible readings: the
"did not shut down cleanly" log line is the *injection* journal
(`codex/journal.ts:209`), not the native-profile journal; and disk
`manual-recovery` residue would survive a restart, which contradicts the
reporter's restart-cures-it observation.

**Relationship to #2114.** Same fence, different trigger. #2114 is deterministic
and restart does not help; #2108 is transient and restart does help. They share
the *unknown → permanent fence* layer, which is the reusable fix.

### #2107 — WSL 502 after service install

**Mechanism (confirmed, and it is not what the title suggests).** This is
**not** the #2108 gate and **not** a WSL loopback problem. Codex reached
OpenCodex fine; OpenCodex could not reach ChatGPT.

`buildUnit()` (`service.ts:2418-2444`) bakes `OCX_SERVICE`, Bun provenance,
`PATH`, `CODEX_HOME`, `CODEX_SQLITE_HOME`, `OPENCODEX_HOME` — and **no proxy
variables**. systemd does not inherit the installing shell's environment, and
`ExecStart=/bin/sh -lc` is dash on Ubuntu WSL, which reads `.profile`, not
`.bashrc`. So a user whose proxy lives in `.bashrc` gets a service that talks
to ChatGPT directly, and the socket is reset → `fetchWithResetRetry` exhausts →
502 `Provider unreachable`.

The distinguishing evidence is the status code itself: #2108 is **503** with
the native-main string; this is **502** with `recoveryKinds: ["connection-reset"]`.

**Same hole in launchd and the Windows wrapper** (`service.ts:392-407`,
`1516-1533`), though Windows logon tasks often already carry user env.

**Regression.** No — `git log -S HTTP_PROXY -- src/service.ts` is empty. This
has always been true; it only shows up when a proxy is required.

### #1933 — Windows tray registration reported foreign/stale

**Mechanism (confirmed).** Not a missing-file problem despite the title. The
title is a *collapsed summary string*, and the real cause is a text encoding
bug.

`runRegistry`/`runRegistryAsync` decode `reg.exe` output with
`encoding: "utf8"` (`src/tray/windows.ts:120-125`, `335-345`). Redirected
`reg query` emits the console ACP, not UTF-8. The reporter's username is
`MötzJensen`; `ö` is `0xF6` in Windows-1252 and decodes to `U+FFFD`. The
round-trip comparison `registered === state.runCommand` then fails, and
`registrationOwned` goes false → the stale summary.

**This is a known class with an existing fix that was never wired here.**
`decodeWindowsTextBytes` (`src/lib/windows-text.ts:75`) already solves exactly
this for `schtasks` (#1573, with a `C:\Users\Jörg` fixture). The tray reader was
missed.

**Blast radius.** Windows users with non-ASCII in the profile path or
`OPENCODEX_HOME` on a non-UTF-8 ACP. Also blocks the GUI repair path: Install
is hidden when `tray.stale`, and uninstall refuses on a mismatched parse.

### #1587 — routed first-turn tool catalog is 3-5x native

**Mechanism (confirmed by two independent lanes).** `buildTools()`
(`src/responses/parser.ts:155`) never reads Codex's `defer_loading` flag.
`pushFn` and the namespace flattener copy every tool's full `parameters` into
`OcxTool`, and the flag is not on the type, so it is gone by parse time. The
routed adapters then serialize all of them (`openai-chat.ts:1197`,
`anthropic.ts:740`, `google.ts:270`).

The native path is asymmetric **on purpose**: `openai-responses.ts:406`
preserves `defer_loading` and strips it only when a `tool_search_output`
actually loads the tool.

**Measured, not asserted.** One lane ran this tree's real `parseRequest`
against a captured Codex Desktop catalog:

| Sample | Deferred tools | Deferred bytes | After parse |
|---|---|---|---|
| 2026-08-12 rollout | 8 of 8 | 32,927 / 34,404 (**95.7%**) | all 8 emitted with full schemas, 32,887 bytes (~8.2k tokens), zero defer flags surviving |
| second sample | 4 namespaces / 10 tools | 24,227 bytes (~6.1k tokens) | same |

**A caveat both lanes raised.** The headline "3-5x" is not a clean byte
multiplier: the thread's numbers compare *different tokenizers* (OpenAI vs Kimi
vs Claude) and the Opus row also carried a repo `AGENTS.md`. The mechanism is
real and measured; the exact ratio is not.

**Regression.** No. Flattening was added 2026-06-19 so chat models could call
MCP tools; the routed path never honored deferral.

### #1730 — Camel DeepSeek V4 Flash first-round tool call

**Already half-fixed, and the reporter withdrew the rest.** The shared
conversion half — every converted custom tool getting a generic
`input.description`, which broke `exec` — was fixed by `ea0608611` (#1763), an
ancestor of the current head. The current tree special-cases `exec` at
`custom-tool-compat.ts:73`.

The remaining claim (a first-round structured-tool miss) is **CANNOT-DETERMINE
as an OpenCodex defect**: there is no Camel code in the tree, the passthrough
forwards the client's `tool_choice` unchanged, and the reporter's own local
`required` patch proves the *model* will tool-call when forced — not that we
dropped a call. The reporter later attributed it to a config error (Responses
override against a Chat Completions host) and asked to close.

**Proposed action: close as reporter-withdrawn.** Do not implement the
suggested `stream.camelai.com` + `deepseek-v4-flash` hardcode: a hostname/model
special case changing tool-selection semantics for every user of that route,
with no public contract and the reporter now opposing it.

### #1419 — macOS Bun SIGTRAP after TLS failure

**CANNOT-DETERMINE as our defect, and the lane was right to refuse.** The crash
is a native `EXC_BREAKPOINT` in Bun after a TLS handshake failure.
`installCrashGuards()` only hooks `unhandledRejection`/`uncaughtException`
(`crash-guard.ts:332`), so a native trap never reaches JS — which matches the
reporter seeing no `crash.log`. `unknown certificate verification error` is a
Bun string, not ours.

**Bundled Bun is still 1.3.14** (`package.json:65`), and upstream's latest
release is still `bun-v1.3.14`, so there is nothing to bump into. #1691's Bun
1.4 train is blocked for the same reason.

**One real, separable gap the lane found:** `ocx gui` spawns the proxy
detached and unsupervised (`cli/dispatch.ts:255`), while launchd `KeepAlive`
exists only for `ocx service`. That is a *survivability* fix we own, and it is
testable, unlike the trap.

### #1049 — adopt pre-substrate Codex homes into the write coordinator

**Still real; the substrate did not make it moot — it created the leftover
class.** `codexWriteCoordinationEligibility` returns `legacy-uncoordinated`
when there is no coordinator file and residue is not `clean`
(`inject-coordination.ts:46`), and inject/restore then write directly. The
specified adoption path is entirely absent: `adoption-pending` matches **zero**
times in `src/` and `tests/`, and the live schema CHECK does not include it.

**Important for scheduling:** the lane split this into two phases and warned
that phase 2 is the invasive one — a wrong publish can corrupt the user's Codex
home, and Windows needs a real no-replace primitive rather than a POSIX
hardlink. It is also **not a field incident**: no user logs, no crash. The
`bug` label here marks a known gap, not a live failure.

### #1527 — Cursor large-context collapse (added after the candidate correction)

Investigated once the audit established that #2054 does not claim it.

**What #2054 actually covers.** Process-local checkpoint reuse, so validated
linear follow-ups send `continuationMode=checkpoint` with `rootBytes=0` instead
of rebuilding history. Its own body says "Not run: #1527 large-context / 429 /
kimi-k3", and its live-transport change is capture-only.

**Residual after it lands — five items, and they are not one bug.**

1. `kimi-k3` premature completion at ~79-95k input: HTTP 200 with 4-36 output
   tokens while direct `cursor-agent --model kimi-k3` produces ~10k at the same
   scale. Not re-run on the checkpoint branch.
2. `claude-fable-5` 429 asymmetry vs direct Cursor. Unprovable either way today:
   Connect does not expose `cache_read_tokens`, so usage stays estimated and
   `cached_tokens: 0` cannot distinguish a cache hit from a miss.
3. **Teardown misclassification.** Normal completion never sets
   `expectedClose` — only `cancelCursorRun()` does
   (`src/adapters/cursor/live-transport.ts:738`) — while the abort listener
   unconditionally `failAndClear("Cursor request was aborted")` (`:1157`), and
   `"aborted"` is not benign (`cursor-errors.ts:74`). So a turn that already
   emitted `turnEnded` still logs `turn-failed` / `expectedClose:false`.
4. First turn, restart, compaction and helper isolation still full-replay into
   the 512 KiB / 192-blob envelope (`protobuf-request.ts:70`, `:68`).
5. Request-shape parity with official Cursor (e.g. `maxMode: false` at
   `protobuf-request.ts:879`) is untested.

**The useful finding:** item 3 is small, low-risk, and independently testable —
it is a misclassification in the abort listener, not a context-window mystery.
Items 1 and 2 are acceptance work that cannot start until #2054 lands, and item
2 may not be provable at all without an upstream field.

**Evidence.** Strong that the OpenCodex Cursor path diverges from direct Cursor
and that abort classification is wrong. Partial that full replay *causes* the
429/kimi-k3 symptoms — #2054 assumes it and did not re-run the workload.

## Cross-issue observation

Three of the eight (#2114, #2108, and the ownership half of #1939, which
already has PR #2029) are the **same architectural fault**: a probe that cannot
answer produces `unknown`, and `unknown` is treated as permanent evidence of
foreign ownership for the life of the process. #2114 is the deterministic case,
#2108 the transient one.

That is worth naming before ranking, because it changes what "fix #2114" means:
the cheap fix is one classification branch, but the shared fix is making the
fence retryable. They are different sizes and different risks.
