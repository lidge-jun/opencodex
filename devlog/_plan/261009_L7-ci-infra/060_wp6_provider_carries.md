# 060 — wp6: provider carries #6779 and #6754

Two PRs from sibling worktrees `.tmp/lanes/L7-ci-infra-6a` and `-6b`.

## 6a — #6779 opencode-go Haiku wire pin

PR title: `fix(opencode-go): pin claude-haiku-5-5 to the Anthropic wire`. Credit: agents-dev
(`Co-authored-by` with the account's GitHub noreply address, because the source commit identity is not linked to a GitHub account).

| Path | Change |
| --- | --- |
| src/types/wire.ts | add `claude-haiku-5-5` to `ANTHROPIC_WIRE_MODELS["opencode-go"]` next to the MiniMax siblings (PR :49-61) |
| tests/server/adapter-resolve.test.ts | PR's direct-resolver test, plus the open review fix: assert the exact model through `captureRouteStaticPolicy` and the resolver's fifth argument, including an attempted Chat/Responses override and repeat resolution |
| structure/transports/responses-wire-shapes.md (:211-214) | name Haiku in the Go wire list, citing https://opencode.ai/docs/go/#endpoints |
| structure/providers-and-adapters.md | owner of `src/types/wire.ts` (`structure/INDEX.md:176`): add Haiku to the provider-local Anthropic-wire pin list, or record in the PR why the existing wording already covers it |
| docs-site/src/content/docs/guides/providers.md | required: add one sentence to the **OpenCode Go** paragraph (:662): OpenCodex sends `claude-haiku-5-5`, like the MiniMax models, over the Anthropic Messages wire, matching OpenCode Go's endpoint table. Translation disposition: the seven locale pages do not describe Go wires, so they are left unchanged and the PR says so |

Evidence: the official OpenCode Go endpoint table lists `claude-haiku-5-5` at
`/zen/go/v1/messages` with `@ai-sdk/anthropic`.

## 6b — #6754 Azure vision/context/output metadata

PR title: `fix(catalog): refresh Azure vision and token metadata during discovery`. Credit:
`Co-authored-by` x3M3x (commit identity from the source PR).

Carry the full PR (20 files) plus fixes:

1. Register `azure-vendor-metadata.test.ts` → `codex-integration` in both
   `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`. Without
   it, the `^azure-` seed sends it to `providers` and `tests/test-layout.test.ts` fails.
2. Cache isolation in `src/providers/azure-model-metadata.ts:13-15,56-62,79-96`: key
   `snapshot`/`inFlight`/`retryAfter` by the resolved config directory captured at call time,
   and add an A→B root-switch test.
3. Keep: hostname-suffix check, Accept-only fetch (no Azure credentials), 16 MiB / 2 s bounds,
   modality filter, precedence rules.

## Acceptance (both)

- Focused: the changed tests, `tests/test-layout.test.ts`, metadata sync check for 6b
  (`scripts/generate-model-metadata.ts` output matches), typecheck, privacy, structure,
  docs build for 6b's eight locale pages if the docs job is not in CI.
- Hosted: exact-head CI green.
