# 110 — Three open bug issues: #2152, #2157, #2156

Unit: 260820_bug_pr_backlog_consolidation
Verification host: `ssh lidge:~/ci-wp3/opencodex`.

Three issues, three different shapes of answer. Two shipped fixes; one is honestly blocked.

## #2152 — Windows CI, three groups (PR #2178)

Three read-only lanes read the three groups. The shape PR #2178 already had was right, and two
of the issue's own premises turned out to be wrong — the fix follows the evidence:

- **Group 1** is not "the case budget is too small". `A-reduced` failed at 79,978 ms against a
  150 s ceiling, so the outer budget was never the constraint. The real abort came from
  `Fixture.request`'s unscaled 10 s `AbortSignal` firing from inside. And `E` does not start
  `ocx` at all — it starts two lock helpers, and its holder released after a fixed 3 s wait
  that a Windows contender's spawn can outlast.
- **Group 2** is not "an unprivileged Windows user cannot create symlinks". The runner can, so
  `canSymlink` was true and the cases ran — then failed on Unix mode semantics that a Windows
  directory cannot satisfy. Production already returns `windows_skip` for exactly that reason,
  which is what makes the platform guard a correct skip rather than a masked failure.
- **Group 3** needed the crash retry the macOS leg already had.

### The defect I found in the fix

Group 3's retry grepped for `panic(thread`. This repository already worked that out and wrote
it down: `devlog/_fin/260731_pr_issue_triage_round/050_windows_ci_flake_rca.md:172` says not to
key on it, because Bun emits **both** `panic(thread 2852)` and `panic(main thread)` for the
same failure, and names `Internal assertion failure` as the stable fingerprint. Probed:

```text
MATCH   panic(thread 3960): Internal assertion failure
MISS    panic(main thread): Internal assertion failure
MISS    panic(main thread): PANIC: reached unreachable code
```

The retry would have failed the shard on roughly half the crashes it exists to absorb, while
looking correct.

Three copies of that signature list exist — macOS inline, the new Windows inline, and
`is_bun_runtime_crash` — and the workflow comment already said to keep them in sync with
nothing enforcing it. They had drifted. All three now match, and the contract test pins **the
sync itself**, not the literal text, so the same drift cannot recur. RED-proven: restoring the
bad signature fails it with `windows:Internal assertion failure:false`.

`hasShellCommandHead` was added because the existing exact-whole-line matcher rejected the
`| tee` the retry requires — that is why the Windows step assertion went red — while still
rejecting an echoed or commented-out copy.

**What no local run can prove:** whether 45 s suffices under real Windows contention, the actual
skip result on the runner, and `PIPESTATUS` under Git Bash. Those need a `workflow_dispatch`,
and a useful proof run must exercise the crash path — a green Windows run shows the suite runs,
not that the retry fires.

## #2157 — shadow-helper observability (PR #2179)

The dashboard half of the attribution field #2166 landed. Delivered.

## #2156 — muse-spark truncation: BLOCKED, deliberately

PR #2180 was opened claiming to fix this. An adversarial review found the attribution wrong, and
the source agrees:

- A stall abort emits `response.incomplete` / `upstream_stall_timeout` (`bridge.ts:1371-1396`),
  after which the bridge has cancelled upstream, closed, and explicitly discards any late
  adapter event (`bridge.ts:837-845`).
- The reporter's error is emitted only after `reader.read()` returns EOF with tool calls still
  pending (`openai-chat.ts:1819-1827`), surfacing as `response.failed`.

Different path, different client frame. The heartbeat **cannot** produce the reported error.

What the heartbeat does fix is real and worth landing alone: tool-call deltas are buffered, the
bridge arms its watchdog on adapter activity rather than socket activity, so a large argument
payload was indistinguishable from a hung upstream. The `#2156` references were reworded to
"found while investigating", and the closing keyword removed.

**Second finding, partially addressed.** Making the adapter emit one heartbeat per delta
exposed retention in `guardTerminalEventStream`'s `seen`, which feeds both the continuation
analysis and the rebuilt request. Two event classes must be distinguished: #2180 stopped
retaining `heartbeat` events, but the terminal guard still retains every OTHER nonterminal
event (tool-call deltas included), so a large argument payload can still grow `seen` without
bound wherever `terminalContinuationGuard` is on. The empty-completion guard passes heartbeats
through unretained; matching it for the remaining nonterminal classes is follow-up work, not
something this record's PR landed.

**Why blocked rather than fixed.** The adapter is reporting truthfully: that stream really did
end. What cannot be determined from here is why it ended for ocx and not for Pi direct.
`hadUsage: false` is suggestive — ocx does send `stream_options.include_usage` — but a provider
may simply ignore that flag, so it is not decisive either way.

Asked the reporter for the one thing that settles it: redacted raw SSE captures from a
Pi-direct success and an ocx failure for an equivalent request, through socket close, and
whether either carried `finish_reason`, `[DONE]`, or a usage-only final chunk. If ocx's
upstream closes without a terminal frame while Pi's does not, the difference is in what we send
or how we read it and it is ours. If both close identically and Pi is merely more tolerant, the
right answer is the buffered-mode fallback the reporter suggested — and that choice should rest
on their capture, not on a guess.

## Verification

At the branch tips, on `ssh lidge`:

- #2178: `bun test` 13719 pass / 15 skip / 0 fail; `tests/ci-workflows.test.ts` 132 pass / 0 fail.
- #2180: `bun test` 13722 pass / 15 skip / 0 fail; focused trio 112 pass / 0 fail.
- `bun x tsc --noEmit` exit 0 and `bun run privacy:scan` passed on both.
