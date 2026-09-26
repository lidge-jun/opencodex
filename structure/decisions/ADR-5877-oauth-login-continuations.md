# ADR-5877 — decision recorded under "OAuth login continuations"

- Contract owner: [gui-and-management-api.md](../gui-and-management-api.md#oauth-login-continuations)

## Decision record

- 목적과 의도: Keep management login discovery usable for the current principal and display the
  provider's current next step, including a device grant that falls back to manual input.
- 기존 구현 및 제약 조건: Meta Muse already requires a GUI-session principal at both management
  POST boundaries; a raw admin token is not consent. The first `onAuth` resolves the start request,
  so later callbacks cannot change that HTTP response. A device code is human-facing approval
  material, not a redirect code for the loopback callback parser.
- 검토한 주요 대안: Relax the existing admission rule, let the first hint remain authoritative,
  add a separate event stream, or project the latest transient hint through existing status polls.
- 선택한 방식: Share the existing admission predicate with discovery; retain only the three
  human-facing hint fields and replace them on each current-flow callback. Project them through
  status polling, preserve GUI generation guards, and hide callback paste during device approval.
- 다른 대안 대신 이 방식을 선택한 이유: It fixes the offered-but-forbidden action without widening
  authority, and uses the polling lifecycle already owned by each screen. Complete replacement
  removes stale device codes when a provider switches to manual continuation.
- 장점, 단점 및 영향: No dependency, persistent state or migration is introduced. The current hint
  becomes visible on the next poll rather than immediately; credentials remain outside the DTO.
  Cancellation and settlement clear transient hints, and late callbacks cannot resurrect them.
  Direct CLI login remains governed by its existing policy, not management discovery.
