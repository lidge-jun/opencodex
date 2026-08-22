# Phase 3 — rollout identity hardening (G6). G5 downgraded to conditional.

**Independent of every other phase.** (Round 1 claimed a Phase 2 dependency; the
reviewer proved neither preview parsing nor identity handling consumes Phase 2's
resolver. Corrected.)

> **A-phase amendment (round 1).** The reviewer proved G5's stated impact is NOT
> reachable: `extractUserMessagePreview` output is consumed only by
> `reconstructThreadRowFromRollout` (`src/storage/cleanup.ts:2305`), and paginated
> threads are refused before cleanup ever runs (`cleanup.ts:673`). Sync/restore use the
> DB's existing `has_user_event` column, not the reconstructed preview. So a migrated
> thread is NOT misclassified by this code path. G5 is therefore **conditional** — see
> the gate below. The round-1 fixture recipe was also wrong (`rg -rn` parses `-r n` as a
> replacement); corrected.

## G6 — the filename no longer implies the thread id (unconditional)

`4ef836f88` ("Distinguish rollout IDs from thread IDs", 2026-08-12) permits several
rollout ids/files per thread id; `codex-rs/rollout/src/rollout_file_name.rs` owns
`RolloutFileName`, where reverted/alternate rollouts carry a distinct rollout id.
`4496ba3fd` makes upstream validate a path by its first `SessionMeta.id` rather than by
its name.

opencodex reads `threads.rollout_path` from the DB — correct today. This phase's job is
to **prove** that and prevent regression, since the failure mode is silent
cross-thread corruption.

### Audit + lock

| Location | Requirement |
| --- | --- |
| `src/codex/history-provider.ts:459` `readThreadFieldsFromRollout` | id from parsed `session_meta.payload.id` only |
| `src/codex/history-provider.ts:530` `updateSessionMeta` | already compares `payload.id !== expectedId` — keep; add a comment citing `4496ba3fd` |
| `src/storage/cleanup.ts:222` `normalizeArchivedRolloutPath` | must not derive a thread id from the filename stem |
| `src/storage/cleanup.ts:2297-2312` `reconstructThreadRowFromRollout` | binds `id` from `entry.threadId` (manifest), not the filename — verify and lock |

Expected outcome: **no behavior change**, only regressions. If the audit finds a
filename-derived id, that becomes a real fix in this cycle.

### Tests (MODIFY `tests/codex-history-provider.test.ts`, `tests/storage-cleanup.test.ts`)

1. **Alternate rollout id filename** — a file named
   `rollout-<ts>-<thread-id>_<rollout-id>.jsonl` whose `session_meta.payload.id` is the
   thread id resolves correctly through sync, backup, and restore.
2. **Mismatched id still refuses** — regression-lock the existing `:530` guard.
3. **Archived cleanup with an alternate-id filename** — listing/normalization behave.

## G5 — canonical `ItemCompleted` previews (CONDITIONAL)

`src/codex/history-provider.ts:420` `extractUserMessagePreview` recognizes legacy
`event_msg` and raw `response_item` user messages, but not the canonical
`EventMsg::ItemCompleted { item: TurnItem::UserMessage(..) }` records migration produces.

**Gate — run this BEFORE writing any parsing code.** G5 is worth implementing only if a
production caller can reach a paginated rollout AND consume the reconstructed preview.
Enumerate every `extractUserMessagePreview` / `readThreadFieldsFromRollout` caller and
answer, per caller, whether a paginated file can reach it:

```bash
cd /Users/jun/.codex/worktrees/e80c/opencodex
rg -n 'extractUserMessagePreview|readThreadFieldsFromRollout|parseThreadFieldsFromRolloutText' src/ scripts/
```

Known callers and their current verdict:

| Caller | Paginated reachable? |
| --- | --- |
| `src/storage/cleanup.ts:2305` `reconstructThreadRowFromRollout` | **No** — `cleanup.ts:673` refuses paginated threads first |
| `src/codex/history-provider.ts` sync/restore | Uses the DB's `has_user_event`, not the preview |
| `scripts/openai-provider-option-runtime-smoke.ts:343` | Diagnostic script, its own parsing |

If every row stays "no": **record the finding, delete G5 from the gap matrix, and close
this phase with G6 only.** That is an honest NOOP for G5, not a skipped item.

If a reachable caller IS found, implement the third branch — ordered after the existing
two so legacy parsing is untouched — with these upstream anchors:

| Symbol | Location |
| --- | --- |
| `ItemCompletedEvent` | `codex-rs/protocol/src/protocol.rs:1850` |
| `TurnItem::UserMessage` | `codex-rs/protocol/src/items.rs:44` |
| `UserMessageItem` | `codex-rs/protocol/src/items.rs:78` |
| `UserInput` (snake_case-tagged) | `codex-rs/protocol/src/user_input.rs:15` |

**Do not guess the serialized tag.** `TurnItem` carries no `rename_all`, so the variant
key must be read from generated output. Correct commands (note `-n`, not `-rn` — `rg -r`
means *replace*):

```bash
cd /Users/jun/Developer/codex/121_openai-codex
rg -n 'enum TurnItem' -A 30 codex-rs/protocol/src/items.rs
rg -n 'serde' -B 3 -A 3 codex-rs/protocol/src/items.rs | head -40
```

If no serialized fixture exists upstream, generate one through upstream serde (a throwaway
Rust test that serializes the variant and prints it) rather than hand-authoring JSON —
a hand-written fixture matching a wrong spelling would pass the test while production fails.

## Verification

```bash
bun install                     # REQUIRED FIRST: this worktree has no node_modules
bun test tests/codex-history-provider.test.ts tests/storage-cleanup.test.ts tests/codex-native-residue.test.ts
bun x tsc --noEmit
```

**Verifier receipts (recorded 2026-08-16).** In this worktree the test command exits `1`
with `0 pass, 3 fail` — `Cannot find module 'zod/v4'` — and `bun x tsc --noEmit` exits `1`
with `TS2688: Cannot find type definition file for 'bun-types'`. Environmental:
`node_modules/` is absent. B runs `bun install` and re-records. `package.json:41` defines
`"test": "bun scripts/test.ts"`.

Target observation: both suites import the changed modules directly.

## Accept criteria

1. No code path derives a thread id from a rollout filename (proven by audit + regression).
2. Alternate-rollout-id files survive sync/restore/cleanup unchanged.
3. The mismatched-id refusal is regression-locked.
4. G5 is either implemented with a named reachable consumer and an activation test, or
   formally removed from the gap matrix with the caller table as evidence.

## Out of scope

Writing canonical records; ordinal generation; `thread_history_1.sqlite` reads.

