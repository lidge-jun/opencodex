# 020 — wp2: carry L1–L3 with layout registration

Status at write time: carried in the worktree, unpublished. Heads: L1 `769e4208f`,
L2 `094cb93d0`, L3 `85ad0a29a` (pre-audit-fix).

## Audit round 1 (claude-opus-5, adversarial, read-only) — NEAR-PASS

| # | Finding | Disposition |
|---|---------|-------------|
| 1 | Qoder catalog branch in `src/codex/catalog/provider-fetch.ts` (4 hint calls, ~1598–1628) omits `captured.effectiveAlias`, which `45045623b` (#3601) threaded through every sibling branch. Git auto-merged because lines do not overlap. | FOLD — maintainer fix commit on L2 appends the argument to all four calls. |
| 2 | `tests/adapters/adapter-tool-conformance.test.ts` exempts `codebuddy`/`qoder` with a bare `continue`; a future tool bridge would keep passing silently. | RESIDUAL — v1 contract is `--tools ""`, documented in registry notes and docs-site. A guard test cannot be validated locally under the no-local-suite rule; deferred to a follow-up that can run it. |
| 3 | `src/adapters/coding-agent/protocol.ts:198` matches bare `authentication`, so vendor text like "authentication service degraded" becomes a 401 `invalid_api_key`, which drives reauth messaging and key-pool rotation. | FOLD — anchor to credential verdicts (`authentication (?:failed|error|required)`, `unauthorized`). Existing fixture "Not logged in; invalid token" still classifies 401. |
| 4 | `qoder`/`qoder-cn` seed `noVisionModels` with the full roster, advertising image input the adapter rejects. | REBUT — this is the repository convention (`registry.ts:912`, parity test :388, CodeBuddy CN roster §二十九): membership routes images through the vision sidecar and the fail-closed strip applies to every such provider. The adapter's 400 is the defense when an image reaches it without the sidecar path. |

Non-blocking notes carried: CodeBuddy Global roster has no `noVisionModels` (static, vendor
manifest); `docs/qoder-cli-provider.md` lives outside docs-site (kept, wp3 adds the published
section); `--effort` vs `--reasoning-effort` rests on vendor manifests.

Clean under audit: registry contract shape, seed parity fields, `qoder` free-directory
promotion + `preserveCustomDestination`, `authorityIdentity` backward compatibility,
connection-test path ordering, layout-guard JSON (delta is exactly the four new keys),
privacy (PAT redaction, allowlisted child env, SHA-256 fingerprint), CI path (no docs-site
build or provider enumeration on `pull_request`).
