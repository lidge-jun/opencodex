# ZCode Start Plan Provider

Covers the `zcode-start-plan` provider: the Z.ai Start Plan quota consumed through the
ZCode plan gateway (`zcode.z.ai/api/v1/zcode-plan/anthropic`), with no ZCode desktop
installation required.

## Owned surfaces

- `src/adapters/zcode-start-plan.ts` and `src/adapters/zcode-start-plan/` — the gateway
  adapter, its body shaping (`system-blocks.json`, `body-transform.ts`), the captcha
  worker host (`captcha-host.ts`), and the vendored traceless solver
  (`captcha-solver.ts`).
- `src/oauth/zcode-start-plan.ts` — the OAuth CLI login flow and its terminal-refresh
  contract.
- `src/providers/quota/vendor-probes-zcode.ts` — the billing/balance quota probe
  (`X-Device-Mid` persisted under the OpenCodex home; `ZCODE_DEVICE_MID` overrides).

## Invariants

- Plan requests go only to the gateway's Anthropic-wire messages endpoint, authenticated
  with the plan JWT from `ocx login zcode-start-plan` (no V4 signing; the route is
  exempt via the client's `isUnsignedModelRequestPath` set).
- Requests carry the official client's identity/attribution headers and the
  gateway-required ZCode system blocks (biz 3012 otherwise). The Claude Code identity
  block injected by the oauth-mode inner Anthropic adapter is stripped so the model sees
  exactly one identity.
- Aliyun WAF captcha challenges (biz 3007 in-body, or the verify-param response header)
  replay once with freshly minted verify params from the in-process worker-confined
  traceless solver. The solver's fingerprint is deterministic: randomizing it triggers
  F001 risk rejections.
- Gateway business errors inside HTTP 200 bodies map to real statuses (per-window rate
  limit `1005` → 429; others → 502) so clients never see a truncated stream.
- The captcha worker is terminated when a solve times out; a hung guest SDK cannot
  poison later solves.

## Known limitations (documented, by design)

- The vendored solver port (`captcha-solver.ts`) carries a top-level `@ts-nocheck`:
  typing the ~2.3k-line port is follow-up work (requires `suppression-approved`).
- The happy-dom guest executes CDN-served SDK bytes inside the worker realm; isolation
  is thread-level, not process-level. `ZCODE_DEVICE_MID` overrides the persisted
  per-install device id.
- The `@ts-nocheck` and the management route/dependency surfaces require
  `suppression-approved` and `maintainer-sponsored` labels respectively per the PR
  quality gates.

## Known limitations (documented, by design)

- The vendored solver port (`captcha-solver.ts`) carries a top-level `@ts-nocheck`:
  typing the ~2.3k-line port is follow-up work (requires `suppression-approved`).
- The happy-dom guest executes CDN-served SDK bytes inside the worker realm; isolation
  is thread-level, not process-level. `ZCODE_DEVICE_MID` overrides the persisted
  per-install device id.
- The `@ts-nocheck` and the management route/dependency surfaces require
  `suppression-approved` and `maintainer-sponsored` labels respectively per the PR
  quality gates.
