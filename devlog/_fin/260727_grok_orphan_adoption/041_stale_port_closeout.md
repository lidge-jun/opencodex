# Closeout: dead-port fence, live repair, and the missing warning

Date: 2026-07-27
Cycle: P -> A -> B -> C -> D (session 019f9d76)

## What was actually wrong

`~/.grok/config.toml` carried two generations of our own entries: 8 pinned to
`127.0.0.1:4179` (nothing listening) and 23 on the live `10100`.
`[models] default = "ocx-gpt-5-6"` named a stale one, so every turn hit a
refused connection. Grok retried 15 times entirely on its own side, which is
why the opencodex log stayed empty and the TUI still showed the correct 372K —
the stale entry carries `context_window`, only its port is dead.

The fence markers were gone because Grok re-serializes the file with
`toml::to_string_pretty` (its `persist.rs`), which preserves keys and drops
comments. Our `extra_headers` inline table came back as a `[model.<alias>.extra_headers]`
sub-table, and the markers vanished with the rest of the comments.

## Independent audit corrected two of my claims

An adversarial Sol reviewer verified the live state and refuted:

- **My root-cause candidate.** I blamed `chooseListenPort`'s ephemeral fallback.
  `shouldPersistSelectedPort(10100, 4179, 10100) === false` is *intentional* —
  a transient fallback port must not be persisted — and there is no service-log
  evidence that 4179 ever came from that path. Disabling the fallback would
  break Grok routing while a fallback proxy is healthy.
- **My "Grok reads config only at startup" premise.** Grok 0.2.112 watches
  `~/.grok/` (`watcher.rs:101-110`) and reloads model config
  (`reloader.rs:384-392`). A fence written after grok launched *is* picked up.

Both rebuttals were accepted and that scope was dropped. Verdict: NEAR-PASS.

The reviewer also confirmed the current sweep is already correct: running
`syncGrokConfig(10100, ...)` against a copy of the live file yields
`port4179=0, markers=2, modelTables=23`. The on-disk file was simply stale
because no sync had run since Grok's last rewrite.

## What shipped (c532cefb)

The sweep was left alone — it works. What was missing was any way to *notice*:

1. `grokFenceEndpointDrift()` in `src/grok/status.ts` compares the fence
   endpoint against the port we actually bound. It stays silent when there is
   nothing actionable (no fence, no live port, an endpoint shape we never
   emit, or agreement).
2. `ocx status` reports the mismatch and names the repair command. This is the
   diagnostic that would have turned a 15-minute investigation into one line.
3. The three `syncGrokConfig` call sites in `src/cli/index.ts` no longer
   swallow a thrown sync. A sync that throws is exactly when the fence goes
   stale, so it now says what failed and how to repair it.

## Evidence

- `bun run typecheck` — exit 0.
- `bun run test` — 4834 pass / 0 fail across 375 files (182.35s).
- Live repair via `POST /api/grok/apply`: `4179` count 0, markers 2,
  fence `base_url = "http://127.0.0.1:10100/v1"`, 23 tables.
- Drift check against the real file:
  `driftVsLive=null`, `driftVsDead={fencePort:10100,livePort:4179}`.
- Live smoke through the fence endpoint:
  `POST /v1/chat/completions {"model":"xai/grok-4.5"}` -> 200, content `"ok"`.
- Usage log recorded it with the grok attribution tag:
  `"provider":"xai","model":"grok-4.5","surface":"grok",...,"status":200`.

## Known residual (documented, not fixed)

opencodex and Grok are independent read-modify-rename writers over the same
file with no shared lock. Concurrent writes can race. The ownership sweep makes
the result recoverable on the next sync, and `ocx status` now reports the
symptom, but the race itself remains.
