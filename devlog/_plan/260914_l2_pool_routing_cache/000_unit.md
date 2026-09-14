# 260914 L2 — pool routing prompt-cache preservation and honest routing status

Lane R1-L2 of the 260914 delivery round. One pull request against `dev` from
`codex/260914-l2-pool-routing-cache`, closing two issues that both come down to the
same thing: the pool tells the operator one story and does another.

- #4546 — quota-strategy account rotation moves a **bound** conversation mid-thread, so the
  account-isolated prompt-cache prefix is discarded on every turn once the pool is hot.
- #4550 — `ocx status` prints `routing=opencodex-local` read from config on disk, which is the
  *configured* route, not the route an already-running Codex client actually adopted.

## Write scope

Permitted: `src/codex/routing.ts`, the account-pool / session-affinity code, a new
`src/codex/routing-adoption.ts` leaf, `src/codex/native-profile-processes.ts`,
`src/codex/autostart-health.ts` wiring, their tests, the docs-site configuration reference,
`structure/providers/openai-tiers.md`, and this unit.

`structure/providers/openai-tiers.md` is not optional: `structure/manifest.json` lists it as a
doc for `src/codex/`, and `structure/AGENTS.md` makes changing an owned source area oblige the
same change to update its doc. `bun run structure:check` is wired into the suite by
`tests/ci-workflows/structure-ssot.test.ts`, so ownership here is enforced, not advisory.

Tests EXTEND existing subsystem files rather than adding new ones. A new test file would also
require entries in `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`, and `tests/test-layout.test.ts` enforces that.

Excluded, owned by concurrent lanes: `src/providers/devin*`, `src/providers/antigravity*`,
`src/server/responses/*`, `src/codex/catalog/*`, `src/adapters/cursor/*`, `gui/`.

## Verification posture

Local suite, typecheck, install and GUI build are **not run** for this unit by explicit
instruction. Proof is hosted CI at the exact final head SHA and nothing else. The pull
request states that posture in its Verification section rather than implying a local green.

## Roadmap

| Doc | Work phase | Outcome |
| --- | --- | --- |
| `010_cache_safe_rebind.md` | wp1 | A live binding only moves to an account with real headroom (#4546) |
| `020_routing_adoption.md` | wp2 | Status separates configured routing from adopted routing (#4550) |
| `030_delivery.md` | wp3 | One template-filled PR, hosted CI green at the exact final head |

Implementation is delegated to subagents on `devin/swe-2` and `xai/grok-4.6` at a 2:3 ratio,
each with a disjoint write scope so two writers never hold the same file.

## Review record

An independent reviewer audited this roadmap before implementation and returned FAIL with three
blocking findings, all folded in: the planned Codex-client process set could not see a CLI process
at all, `adopted` was not sound as written, and the write scope omitted the `structure/` doc that
owns `src/codex/`. The `010` diagnosis was confirmed correct on every point.
