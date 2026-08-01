# WP14 — Native Bedrock Runtime and optional SigV4

## Goal and dependency

Add a native Converse/ConverseStream adapter only for concrete models or features not satisfied by Bedrock Mantle. Start with Bedrock Bearer keys; add SigV4 only when an IAM/production requirement is recorded.

## C4 loop boundary

Before B, P must state credential source, allowed AWS regions/accounts, network scope, write scope, maximum live requests/cost, and wall-clock bound. No unattended live call runs without those bounds.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| NEW | `src/adapters/bedrock.ts` | no native adapter | build Converse/ConverseStream requests; map system/messages/images/tools/tool results/reasoning/usage/stop reasons into OCX events |
| NEW | `src/adapters/bedrock-eventstream.ts` | no AWS event-stream decoder | bounded frame decoder with CRC/length validation, `contentBlockIndex` state, exception frames, abort, and terminal handling |
| NEW | `src/aws/credentials.ts` | no direct AWS credential owner | only if SigV4 is approved: resolve env/shared config/container/metadata credentials with explicit precedence and no shelling out by default |
| NEW | `src/aws/sigv4.ts` | no signer | only if approved: canonical request, signed headers, session token, region/service scope, clock-skew-safe tests |
| MODIFY | `src/server/adapter-resolve.ts` | no `bedrock` adapter case | construct native adapter for the registry id |
| MODIFY | `src/providers/registry.ts` | Mantle only after WP12 | add `bedrock-runtime` with required region and model/inference-profile ids; auth mode distinguishes Bearer key from SigV4 credentials |
| MODIFY | `src/types.ts` | no AWS region/credential config | add narrow Bedrock fields; never a generic secret bag |
| MODIFY | `src/cli/provider.ts`, `src/server/management-api.ts`, `gui/src/components/AddProviderModal.tsx`, `gui/src/provider-payload.ts`, `gui/src/i18n/en.ts`, `gui/src/i18n/ko.ts`, `gui/src/i18n/zh.ts`, `gui/src/i18n/de.ts` | no native AWS inputs | region, model/profile id, Bearer-vs-SigV4 mode, and redacted readiness |
| NEW | `tests/bedrock-adapter.test.ts` | no request mapping fixture | messages, image, tools, tool results, inference config, stop/usage/errors |
| NEW | `tests/bedrock-eventstream.test.ts` | no decoder fixture | fragmented frames, multiple indexes, CRC/length failures, exception, cancel, EOF before terminal |
| NEW | `tests/aws-sigv4.test.ts` | no signing fixture | only if SigV4 is built: AWS-published canonical vectors, session token, path/query encoding, clock boundaries |
| NEW | `tests/bedrock-runtime-e2e.test.ts` | no native relay proof | local event-stream server proves full Responses bridge without AWS credentials; live smoke is separately gated |

## Architecture constraints

- Do not import Kiro adapter code as if it were Bedrock Runtime. Reuse only small protocol helpers after ownership review.
- Event payloads are correlated by `contentBlockIndex`; one global current block is forbidden.
- Frame and aggregate sizes are bounded before allocation. CRC/length mismatch is a protocol error, never ignored.
- Model-specific parameters live in `additionalModelRequestFields` only through audited provider/model policy.
- Bearer API keys may cover the first usable native path. SigV4 remains a conditional subtask, not a reason to block Converse support.
- No new AWS SDK dependency without a P-phase dependency/security review and user approval under C4/new-dependency rules.

## Activation scenarios

- Interleaved tool/text/reasoning event-stream blocks map to the correct OCX item ids and one terminal.
- Corrupt CRC, oversized length, exception frame, and EOF-before-stop each produce a bounded error and release the reader.
- Bearer mode sends only `Authorization: Bearer`; SigV4 mode, when enabled, sends canonical `Authorization`, date, payload hash, and session token without logging secrets.
- A model unavailable on Mantle but available on Runtime proves the need for this lane.

## Verification

```bash
bun test tests/bedrock-adapter.test.ts tests/bedrock-eventstream.test.ts tests/bedrock-runtime-e2e.test.ts
bun test tests/aws-sigv4.test.ts  # only when SigV4 exists
bun run typecheck
bun run privacy:scan
bun run build:gui
```

## Terminal outcomes

- `DONE`: named Mantle gap, native adapter/event-stream negative suite, auth mode, local E2E, and bounded live smoke pass.
- `NOOP`: Mantle satisfies every named requirement; no native adapter is added.
- `NEEDS_HUMAN`: no approved AWS account/model/region or SigV4 requirement decision.
- `UNSAFE`: credential resolution/signing cannot meet secret, SSRF, or dependency policy.
- `BLOCKED`: required model permission or region is unavailable.
