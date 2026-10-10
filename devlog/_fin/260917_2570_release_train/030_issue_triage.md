# wp4 — issue triage

Every open issue touched in the last week was checked against `dev` `2b19983bfd` in source. The
headline result is the mirror image of the pull-request pass: **almost nothing in the open issue
list is already fixed**, so 2.57.0 does not silently close the backlog.

## Closed

| Issue | Why |
| --- | --- |
| #4730 | Fixed on `dev` and unreleased. `src/codex/catalog/aggregation.ts:233-244` now skips an already-emitted slug, consumed at `src/codex/catalog/retained-sync.ts:523`. Landed as `fab7e427c7` (#4799), CI green at `35084581608`. Ships in 2.57.0. |
| #4688 | Working as intended. `deepseek-v4-flash` is a deliberately retained compatibility alias (`src/providers/registry/entries-core.ts:1000-1013`) and `src/codex/catalog/routed-gather.ts:853-870` implements that retention. The roster/inventory mismatch is the policy showing through. The real gap — nothing marks a row as an alias — belongs in its own enhancement. |

## Linked to the pull request that addresses them

#4808 to #4817, #4787 to #4788, #4644 to #4649, #4524 and #4521 to #4567. Each comment records
what is still present on `dev` and where, so the link is checkable rather than asserted.

## Relabelled

#4810 and #4761 moved from `bug` to `enhancement`: both describe behaviour the code performs
deliberately (`src/codex/inject/config-toml.ts:84-96` writes the hardcoded provider display name;
`src/cli/system-command.ts:132-140` restarts the whole shell by design). #4579 gained
`needs-design`, #4443 gained `chore`.

## Open and confirmed, no pull request

#4822 (Z.AI discovery has no `modelDiscovery` override, `src/providers/registry/entries-extended.ts:414-435`),
#4820 (successful Cursor discovery is still filtered by the static seed, `src/adapters/cursor/discovery.ts:240-252`),
#4812, #4811, #4790, #4779, #4780, #4680, #4662, #4646, #4590, #4587. Each carries a file and line
in the triage record above rather than a restatement of the report.

## Partially fixed, deliberately left open

#4721, #4582 and #4546 each have a landed piece and a named remainder. For #4546 the remainder is
specific: the workflow cap still derives only from `x-codex-parent-thread-id`
(`src/server/responses/request-send-budget.ts:30-37`) while each child still gets an independent
affinity key (`src/codex/auth-context.ts:99-123`), which is what #4780 tracks.
