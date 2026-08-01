# Kimi K3 v2.7.23 release evidence

## Acceptance criteria

- [ ] `k3` is a 256K local selector and `k3[1m]` is a 1M local selector.
- [ ] Both selectors route upstream as `k3`, retain image input, max-only
  reasoning, and K3 launch-time parameter locks.
- [ ] Focused provider/routing tests, full isolated test suite, typecheck, privacy
  scan, and diff integrity all pass.
- [ ] `dev`, `preview`, and `main` preserve their existing histories and receive
  the validated candidate.
- [ ] `@bitkyc08/opencodex@2.7.23` publishes under npm `latest`.
- [ ] `v2.7.23`, the GitHub Release, and all three remote branches resolve to the
  exact release commit.
- [ ] A clean temporary-prefix install runs `ocx help` without a system Bun.

## Pre-release evidence

- npm before release: `latest=2.7.22`, `preview=2.7.21-preview.20260716`.
- Focused tests before planning: 116 pass, 0 fail.
- Typecheck before planning: exit 0.
- Live Kimi smoke: request reached the provider and returned HTTP 402 membership
  verification failure; no model-id or request-shape rejection was observed.

## Audit record

- Independent reviewer Boole: `VERDICT: PASS`.
- Confirmed both selectors strip to the upstream `k3` wire id and retain image,
  max-only reasoning, and locked sampling metadata.
- Confirmed `origin/preview` is an ancestor of `origin/main`; merging
  `origin/main` into `dev` first allows both public branches to fast-forward to
  the candidate without rewriting history.
- No blocking findings. GitHub Release freshness remains a mandatory fail-safe
  preflight because the first API lookup returned a transient 503.

## Implementation and release record

Pending.

## Final check evidence

Pending.
