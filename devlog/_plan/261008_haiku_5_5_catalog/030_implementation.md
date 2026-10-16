# 030 Implementation and verification

Implemented the audited 010/020 scope on `codex/haiku-5-5-catalog`, based on `bf9ecf3d79`.
The implementation reuses the existing family predicates, exact price overlays, context-tier
estimator, provider seeds and metadata generator. No pricing mechanism or default changes.

## Implementation commits

- `56f777ddfd872ea1fc5636577f0d5ba106049f6c`: Haiku 5.5 request contract and regression coverage.
- `a624064711dbce22ca8b332d777f951d3a1dceb4`: snapshot/generation, 18 generated Cursor exact IDs,
  38 exact context-tier rows, reseller provenance and Sonnet 5.5 cache-read correction.
- `fb36e34e54dedb98c526145f9f3dced10000a319`: Anthropic/Claude CLI, Devin, Kiro and Desktop seeds,
  catalog/output/alias coverage. All existing defaults retained.

The three new tests are registered in both layout inventories. Overlay membership is checked
for unique keys against the actual overlay array rather than a restated count (currently 184).
Structure docs remain 600/600/599 lines; layout.json remains 1,955; Kiro's test stays 2,047
(cap 2,050). Snapshot rows on unbundled providers remain inert; runtime tiers/overlays name
the serving provider and exact ID, as required by the audit.

## Verification (2026-10-08)

Logs are in scratch `.tmp/haiku55/`; none contain OAuth credentials or account identifiers.

| Command | Result | Log |
| --- | --- | --- |
| `bun run generate:model-metadata` | exit 0; generated from source, never hand-edited | generator stdout |
| focused `bun test` command below | 588 pass / 0 fail, 12 files | focused-final.log |
| `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/ci-workflows/file-size-ratchet.test.ts` | 28 pass / 0 fail, 3 files | layout-ratchet.log |
| `rg -l 'claude-haiku\|CONTEXT_TIERS\|EXPECTED_PRICE_OVERLAYS\|ANTHROPIC_MODELS' tests -g '*.test.ts'`, then `bun test --isolate <selected files>` | 1,820 pass / 0 fail, 46 files | mentioned-test-files.txt, mentioned-isolated-tests.log |
| `bun test tests/routing/fastwire-observability.test.ts tests/usage/usage-anthropic-fast-pricing.test.ts` | 36 pass / 0 fail, 2 additional expected-price consumers | additional-price-tests.log |
| `bun run test:changed` | running; import graph against origin/dev merge base bf9ecf3d79 | test-changed.log |
| `bun run typecheck` | exit 0 | typecheck.log |
| `bun run structure:check` | exit 0, SSOT checks passed | structure.log |
| `bun run privacy:scan` | exit 0, Privacy scan passed | privacy.log |
| `git diff --check` | exit 0 | no output |

Focused command:

```sh
bun test tests/adapters/anthropic/anthropic-haiku-5-5-contract.test.ts \
  tests/usage/usage-haiku-5-5-pricing.test.ts tests/providers/haiku-5-5-catalog.test.ts \
  tests/adapters/anthropic/anthropic-sonnet-5-5-contract.test.ts \
  tests/adapters/anthropic/anthropic-output-maxima.test.ts tests/usage/usage-cost.test.ts \
  tests/usage/usage-antigravity-55.test.ts tests/providers/cursor/cursor-catalog.test.ts \
  tests/providers/devin-adapter.test.ts tests/providers/kiro/kiro-adapter.test.ts \
  tests/providers/provider-registry-parity.test.ts tests/codex-integration/model-metadata-sync.test.ts
```

Earlier diagnostic runs:

- Haiku contract before implementation: 11 pass / 11 fail (contract-red.log).
  After implementation, the Haiku+Sonnet contract set passed 49/0; an extra direct parsed
  `__omit__` test was removed because that sentinel is normalized by the caller and was
  outside the audited adapter contract. Omitted reasoning remains covered.
- Initial pricing/catalog: 153 pass / 1 fail: the new catalog test assumed devin-cli was a
  registry entry; it is a pricing surface. Corrected to test the canonical Devin registry.
- Initial focused set: 587 pass / 1 fail: a scripted fixture replacement changed Bedrock's
  expected 0.22 to 0.12. Restored 0.22; usage-cost passed 102/0, final focused 588/0.
- A direct multi-file Bun invocation without `--isolate` gave 1,750 pass / 70 fail.
  The shared `mock.module` OAuth store in vision-backend-union remained active for later
  account-pool/Kiro files. Isolated file globals, matching scripts/test.ts, passed 1,820/0.
  No production or existing test harness changes were needed.

## Live API evidence and discrepancy

Read-only local Anthropic OAuth credentials stayed in memory; no refresh or credential-store
write occurred. `.tmp/haiku55/live-probe.ts` builds requests with createAnthropicAdapter.
No credential, account ID, request text or upstream response text is logged.

- Haiku 5.5 reasoning none, medium and max: HTTP 200, end_turn.
- Haiku 5.5 required tool choice with medium: HTTP 200, tool_use.
- All four caller inputs requested temperature 0.2 and top_p 0.9; the adapter stripped them.
- Haiku 4.5 medium control: HTTP 200, end_turn.
- Reconstructed legacy non-default sampling shape: HTTP 400, sampling-contract rejection.
- Reconstructed legacy enabled/budget shape: HTTP 200, not the documented/audited 400.
  A second probe with budget_tokens 8,192 and max_tokens 16,384 also returned HTTP 200,
  model `claude-haiku-5-5`, end_turn (live-enabled-control.log).

These legacy shapes are reconstructed rejected-field probes using current adapter-built OAuth
framing, not a claim that the old checkout was executed live. The live 200 for enabled is a
current OAuth observation that contradicts the supplied docs. The binding audited adaptive
implementation is unchanged; no supported wire emitted by this patch failed a live probe.
The planned assertion that legacy enabled returns 400 could not be established.

## Scope and residuals

No implementation scope expansion. The only extra checks are additional expected-price
consumers and diagnostic scratch probes. A final comment-only change keeps each Cursor model's
provenance directly above its own capability row. The supplied 010/020 planning inputs remain
under parent ownership. No push, PR, release, full local suite, or hosted CI was performed.
The 010 residuals (one-hour cache bucket, raw-input band accounting, preemptive provider wire
availability, regular Cursor variant evidence and dotted Bedrock family parsing) remain.
