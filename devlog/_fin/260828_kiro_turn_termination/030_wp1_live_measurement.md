# wp1 — live measurement: what is stale, what is a real defect

Measured 2026-08-29 by direct probe of three hosts plus the current tree.
This phase changed no production code.

## Host attribution

| host | opencodex | process | age at measurement | verdict |
|------|-----------|---------|--------------------|---------|
| jun's mac (local) | 2.35.0, run from the checkout via `bun src/cli/index.ts start --port 10100` | PID 62773 | started 2026-08-28 22:12:11 | **STALE by 3 commits** |
| `suji` (sujis-MacBook-Pro, 100.65.106.2) | 2.24.2, installed binary `~/.local/bin/ocx` | PID 98048 | uptime 941472s ≈ **10.9 days** | **GROSSLY STALE** — predates every Kiro fix in this unit |
| `macmini-cf` (juniui-Macmini) | checkout `~/opencodex` at `d7a82a8fc` (dev, includes all of #2819) | none | `ocx` not installed, no proxy running | current source, not serving |

Commands: `ps -o lstart=,etime= -p 62773`, `curl -s localhost:10100/healthz` on each
host, `git log --oneline -3` in `~/opencodex` on macmini-cf.

## Finding 1 — part of the non-termination report is a stale process

The local proxy the user was routed through started at **22:12:11**. Three commits
of #2819 landed *after* that:

| commit | time | content |
|--------|------|---------|
| `b0740840d` | 22:14 | mark the physical attempt as locally answered too |
| `d9d26552f` | 22:15 | state the code-mode echo rule before the first call |
| `68eaf45d8` | 22:30 | remember a delivered final answer instead of trusting the client to echo phase |

`68eaf45d8` is the one that matters: it stops the terminal boundary from depending
on the client echoing `phase`. A proxy started before it cannot have the completed
form of the wp1 terminal-boundary fix. So the user's "still doesn't finish" report
is measured against a binary that never contained the finished fix.

`suji` is worse and is worth stating plainly: at 2.24.2 with 10.9 days of uptime it
predates the entire unit, so any Kiro turn routed there reproduces every symptom
regardless of what `dev` contains.

**This does not close the report.** It explains part of it. Finding 2 is a real
defect in current source.

## Finding 2 — the duplicate answer is live in current `dev`

Live probes against the running proxy (`/v1/responses`, streaming,
`kiro/claude-opus-5`):

- plain question, no tools -> 1 visible assistant message, `phase: "final_answer"`, `end_turn: true`
- question with a tool available, answered directly -> 1 visible message
- tool-result round trip -> normal `function_call`

Those turns are clean, which is consistent with finding 1's fix having landed in
source. But the duplicate needs a specific shape: **one inference that emits
ordinary prose AND then calls the private completion tool**. The model does not
take that shape on every turn, so a live probe is not a reliable trigger.

It does not need to be. The shape is pinned deterministically by the suite in the
current tree — `tests/kiro-stream.test.ts` asserts the duplicate as expected
behaviour in three places:

| test | asserted events |
|------|-----------------|
| "tool-enabled commentary can finish only through a fragmented private completion call" (:267) | `"Checking the result."` commentary, then `"Task complete."` final_answer |
| "STOP_SEQUENCE text also enters bounded completion validation" (:659) | `"Done."` commentary, then `"Done."` final_answer — **byte-identical** |
| "END_TURN does not promote a private completion answer's commentary" (:746) | `"Checking the result."` commentary, then `"Task complete."` final_answer |

Verified green at HEAD: `bun test tests/kiro-stream.test.ts -t "STOP_SEQUENCE text
also enters bounded completion validation"` -> 1 pass, 3 expect() calls.

The `:659` case is the user's symptom exactly: the same text delivered twice, once
as commentary and once as the final answer. `src/bridge.ts` splits on the phase
change, so the client renders two assistant messages.

Mechanism in source, unchanged from `000_research.md`:
`src/adapters/kiro.ts:1468` flushes the whole `deferred` collection
unconditionally when `mode === "required"`, immediately before the completion
answer is emitted as `final_answer`. Nothing consumes the retained prose when a
valid completion answer supersedes it.

## Finding 3 — the outer drain is a second, independent emitter

`parseKiroAttempt` drains `deferred` again at `src/adapters/kiro.ts:996-999` after
the inner generator returns. Skipping only the inner flush at `:1468` therefore
does not remove the duplicate — it reverses its order. Any fix must CONSUME the
collection, not skip one of its two readers. This confirms the audit round-2
correction in `020_wp2_duplicate_answer.md` against current source.

## Conclusion

- The non-termination report: **partly stale process** (local proxy predates
  `68eaf45d8`; `suji` predates the entire unit). Restart is the remedy, not a code
  change.
- The duplicate answer: **a real, currently-pinned defect in `dev`**. It is wp2.

Both hosts need a restart onto current `dev` before any further live judgement of
turn termination is meaningful.

