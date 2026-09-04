# 040 — The two surfaces audit round 1 found missing

Both are pre-existing coverage gaps rather than regressions this unit introduces, and both
strand a 429 that the user's requirement says must move. They become work-phases of their own.

## 040a — Generic OAuth arm for the continuation loop

`src/server/responses/core.ts` ~6549-6628 (the continuation/turn-retry loop) rotates API keys
and Anthropic accounts but has no generic-OAuth arm, so xAI / Cursor / Kimi / Copilot /
Antigravity / Nous continuation 429s never move.

The fix mirrors the arm already present in the main streaming loop at ~6216, using the same
request-local state (`genericFailoverAccountId`, `genericFailovers`,
`GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST`) so the per-request bound is shared rather than
re-armed:

```ts
if (
  response.status === 429
  && genericFailoverAccountId
  && genericFailovers < GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST
  && isGenericOAuthFailoverEnabled(config, route.providerName)
) {
  const nextAccountId = rotateGenericOAuthAccountOn429(
    config, route.providerName, genericFailoverAccountId, response.headers.get("retry-after"),
  );
  if (nextAccountId) {
    try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
    try {
      const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
      genericFailoverAccountId = nextAccountId;
      genericFailovers += 1;
      if (applyFailoverSnapshot(snapshot)) {
        invalidateSameTargetRequest();
        activeAdapter = resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
          config.cacheRetention,
        );
        sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, activeAdapter.name, logCtx.accountLogLabel);
        nextContinuationRecoveryKind = "oauth-account-429";
        continue;
      }
    } catch { /* fall through to emit continuation error below */ }
  }
}
```

Placement: after the Anthropic arm, matching the streaming loop's order (keys, then Anthropic,
then generic). `applyFailoverSnapshot` is mandatory — it carries the Copilot origin,
Antigravity project and Kiro metadata pairing. A hand-rolled `apiKey` swap here would
reintroduce the #2841 mixed-identity bug, and `tests/generic-oauth-failover.test.ts:248`
asserts `failoverAccountSnapshot(` appears exactly 3 times — adding a 4th call site means that
count must be updated to 4 deliberately, which is the guard working as designed.

## 040b — Anthropic arm for the sidecar hook

`rotateSidecarProviderOn429` (~5201-5245) is shared by the web-search loop and the image
bridge. It tries the key pool, then generic OAuth. Anthropic is excluded from generic failover
by design, so an Anthropic 429 inside a web-search or image turn is terminal even with the pool
enabled.

Add a third branch, after the generic one, using the Anthropic rotator and its own
`anthropicPoolFailovers` bound:

```ts
} else if (
  anthropicPoolAccountId
  && anthropicPoolFailovers < ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST
) {
  const nextAccountId = rotateAnthropicAccountOn429(
    config, anthropicPoolAccountId, retryAfter, anthropicSessionKey,
  );
  if (!nextAccountId) return null;
  try {
    const accessToken = await getAnthropicPoolAccessToken(nextAccountId);
    anthropicPoolAccountId = nextAccountId;
    anthropicPoolFailovers += 1;
    route.provider = { ...route.provider, apiKey: accessToken };
    promoteAnthropicActiveAccount(nextAccountId);
    logCtx.provider = formatAnthropicProviderForLog("anthropic", nextAccountId, config);
  } catch { return null; }
}
```

Deliberately NOT routed through `applyFailoverSnapshot`: that helper's contract is
snapshot-pairing for providers that carry per-account routing metadata. Anthropic carries none,
its pool has a fail-closed `local-cli` credential rule that `getAnthropicPoolAccessToken`
enforces, and the structural test at `tests/generic-oauth-failover.test.ts:243` asserts the hook
body does **not** contain `apiKey: snapshot.accessToken` — this branch never builds a snapshot,
so it does not trip that guard. The two existing Anthropic rotation sites apply the token the
same way.

## Test additions

- Structural: the continuation loop contains all three rotators (keys, Anthropic, generic), so a
  fourth surface cannot silently ship with two of them. Same spirit as the existing sidecar
  divergence test that caught this class of bug once already.
- Structural: the sidecar hook contains an Anthropic arm.
- Update the `failoverAccountSnapshot(` occurrence count from 3 to 4.
