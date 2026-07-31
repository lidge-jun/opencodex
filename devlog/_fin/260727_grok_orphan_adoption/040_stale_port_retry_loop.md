# Grok retry loop: opencodex entries pinned to a dead port (4179)

Date: 2026-07-27
Symptom (user): "그록 시작하고 372k는 제대로 들어오는데 지금 retry반복하고 로그도 안들어와"

## Observed

Grok TUI shows `4.6K / 372K` (context window correct) but every turn loops
`Retrying (attempt N/15)`, and the opencodex service log records nothing —
no request ever reaches the proxy.

Grok's own log names the destination:

    ~/.grok/logs/unified.jsonl:17806
      msg="shell.turn.inference_retry"
      reason="request error: error sending request for url (http://127.0.0.1:4179/v1/chat/completions)"

`lsof -nP -iTCP:4179 -sTCP:LISTEN` is empty; the live proxy is on 10100
(`ocx status` -> PID 5389, health ok, port 10100).

## Live config state

`~/.grok/config.toml` (355 lines) holds 31 `[model.ocx-*]` tables in two
generations:

| generation | count | base_url | example alias |
| --- | --- | --- | --- |
| stale | 8 | `http://127.0.0.1:4179/v1` | `ocx-gpt-5-6` |
| current | 23 | `http://127.0.0.1:10100/v1` | `ocx-gpt-5-6-sol` |

`[models] default = "ocx-gpt-5-6"` — the *stale* alias. Grok resolves the
default to the 4179 entry, the connection is refused, and it retries 15 times.
The context window reads 372000 because the stale entry carries the correct
`context_window`; only the port is wrong. That is exactly why the symptom
looks like "the patch applied but nothing works".

## Why the sweep did not catch it

Two independent facts combine:

1. **The fence is gone.** `grep "opencodex managed block"` finds neither
   marker. Grok rewrote the file itself: our writer emits
   `extra_headers = { "x-opencodex-grok" = "1" }` inline, but the live file
   has `[model.<alias>.extra_headers]` sub-tables. A TOML re-serializer
   preserves keys and drops comments — including both fence markers. With no
   fence, `findManagedRegion` returns null and every one of our own tables
   becomes "outside the region".

2. **Alias-suffix drift.** With the fence gone, `userModelAliases` reserved
   the pre-existing aliases, so the next sync allocated `-2`/`-3` suffixes:
   `ocx-gpt-5-6-sol-3` sits alongside `ocx-gpt-5-6-sol`. The orphan sweep
   added in `5ff20dc0` / `7ba0fec3` does adopt these entries — a harness run of
   the *current* `injectGrokConfig` against a copy of the live file produces a
   correct fence with zero `4179` references. So the code on `dev` is right;
   the file on disk predates it and no sync has run since.

The proxy last wrote the file at 08:45:39 (service start), Grok started at
08:45:43, and the file mtime is 08:46:15 — Grok wrote *last*, after our sync.
So even a correct sync is undone whenever Grok re-serializes.

## Root cause

Comment-delimited fencing is not durable against a client that rewrites its
own config. Ownership must be recoverable from data that survives
re-serialization, and staleness must be detected by *value*, not by fence
position: an `api_key = "opencodex-loopback"` entry whose loopback `base_url`
port differs from the live proxy port is unambiguously ours and unambiguously
dead.

## Plan

1. `src/grok/inject.ts` — extend the orphan sweep so an opencodex-owned entry
   (our api_key + loopback base_url) whose port differs from the port being
   injected is adopted even when it sits *inside* a surviving fence, and even
   when its `extra_headers` was re-serialized into a sub-table.
2. Repoint `default` / `fork_secondary_model` at the surviving alias for every
   swept entry (already implemented for orphans; extend to stale-port sweeps).
3. Regression tests in `tests/grok-orphan-adoption.test.ts`:
   - a re-serialized file (sub-table `extra_headers`, no markers) with a stale
     port converges to one correct entry per model, zero stale ports;
   - `[models] default` naming a swept alias is repointed to the survivor;
   - a user-authored loopback entry with a *different* api_key is untouched.
4. Live repair: restart via `ocx service` and prove
   `grep -c 4179 ~/.grok/config.toml` is 0 and `default` names a live alias.
5. Verify in the Grok TUI that a turn completes and the proxy logs it.

## Acceptance criteria

- `bun run typecheck` and `bun run test` green.
- New tests fail on the pre-fix code and pass after.
- Live `~/.grok/config.toml`: zero `4179`, `default` resolves to a 10100 entry.
- A Grok turn reaches the proxy (request visible in the opencodex log).
