# Grok cache failover hardening and 2.7.10 promotion

## Loop spec

- Archetype: bounded regression-hardening and release promotion
- Trigger: live Grok cache verification passed, but 429 key rotation retained only unit-level/static coverage for cache-affinity headers
- Goal: lock the rotated xAI request path with an end-to-end regression, then promote the verified build through preview and stable npm channels
- Non-goals: change cache-key derivation, add new config, alter OAuth transport, refactor the response router, or claim that `x-grok-conv-id` alone causes every cache hit
- Verifier: focused server failover E2E + xAI tests, typecheck, full test suite, privacy scan, GitHub branch CI, npm registry/provenance smoke
- Stop condition: `dev`, `preview`, and `main` converge on the stable release commit; npm `preview` and `latest` resolve to the new versions; GitHub releases and CI are green
- Memory artifact: this plan, C-gate output, GitHub Actions URLs, npm/GitHub release URLs
- Expected terminal outcomes: PASS and release 2.7.10; or BLOCKED with the exact failing gate and no partial promotion hidden
- Escalation: main agent retains the test and release path; a reviewer audits the plan and final diff; any test-discovered production defect returns to P before code expansion

## Scope

IN:

- MODIFY `src/providers/registry.ts`
  - Add an explicit `allowKeyAuthOverride` capability to OAuth registry entries.
  - Enable it only for `xai`, whose dashboard and transport already support switching between subscription OAuth and API-key billing.
- MODIFY `src/router.ts`
  - Preserve user `authMode: "key"` only when the OAuth registry entry explicitly enables `allowKeyAuthOverride`; keep canonical OAuth behavior for every other built-in OAuth provider.
- MODIFY `src/providers/key-failover.ts`
  - Add `rotateProviderTransportOn429(config, providerName, options)` as the single owner of key rotation followed by provider-specific transport re-resolution.
  - Keep the existing CAS/cooldown behavior inside `rotateKeyOn429`; return `null` unchanged when no replacement exists.
- MODIFY `src/server/responses.ts`
  - Replace both duplicated `rotateKeyOn429(...)` + `resolveProviderTransport(...)` blocks with `rotateProviderTransportOn429(...)`.
  - Preserve the current streaming web-search and ordinary non-stream retry behavior.
- MODIFY `tests/xai-transport.test.ts`
  - Configure an exact-name xAI API-key provider with a two-key pool.
  - Resolve the initial transport, trigger `rotateProviderTransportOn429`, and build both adapter requests.
  - Assert authorization rotates from alpha to beta.
  - Assert both requests carry the same `deriveXaiConvId(prompt_cache_key)` value.
  - Capture every request header value and assert none contains the raw prompt key.
  - Assert all Grok CLI subscription headers are absent in API-key mode before and after rotation.
- MODIFY `tests/router.test.ts`
  - Assert explicit xAI `authMode: "key"` remains key because the registry opts in.
  - Assert xAI with no explicit key override remains canonical OAuth.
  - Assert another OAuth built-in cannot switch to key mode without the capability flag.
- MODIFY `tests/server-key-failover-e2e.test.ts`
  - Configure the exact built-in `xai` provider with `authMode: "key"` and a two-key pool.
  - Intercept `https://api.x.ai/v1/chat/completions` through a restored-in-finally `globalThis.fetch` seam; return 429 then success.
  - Assert the real `/v1/responses` route reaches both attempts, rotates authorization, preserves the same hashed conv-id, scans every transmitted header for the raw cache key, and emits no Grok CLI subscription headers.
- UPDATE ignored devlog/evidence with fresh verification and release receipts.
- RELEASE preview and stable packages after all gates pass.

OUT:

- No request/response contract change and no new configuration surface.
- No xAI OAuth credential mutation beyond ordinary live smoke/token refresh behavior.
- No dependency upgrades and no unrelated PR landing.
- No deletion of `.claude/` worktrees or user branches.

## Acceptance criteria

1. Activation: a real `/v1/responses` test with built-in `xai` key mode receives a mocked 429 from `api.x.ai`, then succeeds on retry. Observable proof: two intercepted requests and rotated Bearer keys.
2. Affinity preservation: pre-rotation and post-rotation adapter requests contain one `x-grok-conv-id` equal to `deriveXaiConvId(prompt_cache_key)`. Observable proof: request-header assertions.
3. Privacy: every header name/value on both requests is scanned; none contains the raw prompt cache key, and API-key mode emits none of the three Grok CLI OAuth headers.
4. Reachability: `routeModel` preserves xAI key mode only through the new registry capability; the server E2E proves the non-stream 429 branch fires. Both `responses.ts` 429 branches call the tested helper, eliminating the previous duplicated re-resolution sequence. Focused tests for ordinary failover and web-search rotation remain green.
5. Verification: focused tests, `bun run typecheck`, full `bun test`, and repository privacy scan exit 0. Known full-suite flakes are not accepted without fresh isolation evidence.
6. Promotion: hardening commit lands on `dev` and CI passes; preview publishes an unused `2.7.10-preview.20260713.N`; stable publishes `2.7.10`; npm provenance and GitHub releases exist.
7. Convergence: local and remote `dev`, `preview`, and `main` end at the stable release commit. Before promotion run `git branch --set-upstream-to=origin/dev dev`.

## Release order

1. Commit and push hardening on `dev`; set its upstream to `origin/dev` and wait for CI.
2. Create clean sibling worktree `/Users/jun/Developer/new/700_projects/opencodex-release-2.7.10` on `preview`; fast-forward it to `origin/dev` and publish the next unused preview prerelease.
3. In the primary worktree, fetch and fast-forward `dev` through `origin/preview`, then push `origin/dev`.
4. In the clean release worktree, switch to `main`, fast-forward to `origin/dev`, and publish stable `2.7.10`.
5. Fast-forward primary `dev` and release-worktree `preview` to `origin/main`; push both and verify final CI/dist-tags/releases.
6. Remove the clean release worktree after all release and convergence checks pass. The primary `.claude/` worktree remains untouched.
