# 020 — carry #6746: hosted search history as reference text in portable compaction

Source: https://github.com/lidge-jun/opencodex/pull/6746 (yuanyuanlove, draft), head c938f6ab0e,
two commits, merges cleanly with dev c15037b324. Rebase onto the #6769 carry if it has landed;
otherwise branch from origin/dev and re-verify after #6769 merges.

## Problem

Portable compaction (`buildRoutedCompactionBody` in
`src/adapters/openai-responses/passthrough.ts`) removes every tool declaration, but leaves hosted
`web_search_call` items in the input, and an upstream can reject hosted history without its tool.
Responses Lite also requires `parallel_tool_calls=false` even with no tools, which the same
function strips.

## Changes (carry the PR, then amend)

1. Cherry-pick both PR commits onto `codex/l3-hosted-search-compaction-carry`; squash message
   carries `Co-authored-by: panyuanyuan <panyuanyuan@hetao101.com>` (commit author of the PR).
2. Amend (D6746-2) `src/adapters/openai-responses/compaction-search-history.ts`:
   - emit an assistant reference note instead of a user message:
     `{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }`. The search
     was the assistant's own past action, and a user-role note would lift web-sourced titles to user
     authority.
   - bound copied values: `MAX_FIELD_CHARS = 2048` (each string sliced, with a trailing `…` when cut),
     `MAX_LIST_ENTRIES = 20` for `queries` and `sources`.
   - total size (A round 1): request body limits are off by default
     (`src/server/responses/outbound-body-guard.ts:5`), so add `MAX_PROJECTED_NOTE_BYTES = 65536` per
     summary request, counting the omission note: `buildRoutedCompactionBody` keeps a running byte
     count and reserves the omission note's maximum size (fixed text plus a decimal count) inside the
     budget; once the next note would cross budget minus that reserve, every later hosted cell is dropped and a single assistant note
     `"N further hosted web search actions omitted."` is appended at the first dropped position.
   - keep the allowlist (status; action type, query, queries, url, pattern; source type, url, title)
     and the label text.
3. Amend `tests/responses/responses-compaction-override.test.ts`: role expectation becomes
   `assistant` with `output_text`; add one case with a 5000-character title, 30 queries and an
   instruction-like query asserting the caps, JSON escaping and assistant placement (placement and
   labeling are the defense; no claim of injection resistance beyond lowered authority), and one
   case with 60 hosted cells, each carrying a 2000-character query and 20 sources with
   2000-character titles (well past 64 KiB in total), asserting that the serialized notes plus the
   omission note total at most 65536 bytes, that exactly one omission note follows the last kept
   note, and that its count equals the dropped cells.
4. Fix (D6746-3) `docs-site/src/content/docs/reference/configuration/server.md`: rewrite the spliced
   paragraph so the Lite sentence follows the metadata sentence, and say the note is an assistant
   reference note.
5. `structure/transports/responses-failover.md`: keep the file at or under 600 lines
   (`structure/manifest.json` budget). Restore the original three wrapped lines the PR joined, and
   replace the PR's long paragraph with a wrapped, shorter one that names the module, the allowlist,
   the caps, the assistant role and the Lite flag. If 600 lines cannot hold it, move the paragraph's
   detail into the module doc comment and keep a two-line pointer.

## Acceptance

- Activation (manual and auto, v1 `/responses/compact` and v2 trigger, gateway and canonical
  portable target): outbound summary input contains no `web_search_call`, `additional_tools` or
  `compaction_trigger`; each hosted call within the budget became one assistant note at the same position; messages,
  citations and real function call/result pairs are unchanged (within the 64 KiB budget; beyond it the
  remaining cells collapse into one omission note); the summary succeeds against a stub
  that rejects hosted history without tools.
- Lite: with the Lite header, the summary body carries `parallel_tool_calls: false`; without it the
  field is absent.
- Ordinary turns and native compaction keep hosted history (existing PR test).
- Caps: a 5000-character title is cut to 2048 code units plus `…`; 30 queries become 20.

## Verifier

- `bun test tests/responses/responses-compaction-override.test.ts tests/web-search/web-search-bridge-replay.test.ts tests/responses/responses-compaction-routing.test.ts`
- After #6769 is on the branch base: `bun test tests/responses/external-task-input-repair.test.ts`
  (external task input still a user turn through compaction).
- `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`; hosted CI on the exact head.
