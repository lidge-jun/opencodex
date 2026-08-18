# 030 — #1789: stop calling a workspace denial a credential failure

## Verified defect

`CodexUpstreamOutcomeClass` is `success | credential | quota | transient | caller | neutral | unknown` — no workspace or entitlement member (`src/codex/routing.ts:129`).

`classifyCodexUpstreamOutcome` maps **both** 401 and 403 to `credential` (`src/codex/routing.ts:330`), and a `credential` outcome unconditionally calls `markAccountNeedsReauth`, clears quota health, and drops thread affinity (`src/codex/routing.ts:1678`).

So a K12 workspace 403 tells the user to re-authenticate a credential that is perfectly valid. `tests/codex-routing.test.ts:377` currently PINS that mapping.

A richer-looking classifier exists on a different path (`src/codex/quota-rejection.ts:11`, distinguishing `authentication-error` from `permission-error`), but at `7c348a032` its 403 branch returns immediately WITHOUT reading the body. Nothing anywhere parses the denial today, so the evidence has to be produced, not merely threaded.

### The denial parser

Add it beside the existing exhaustion-code reader, reusing the same bounded, duplicate-key-safe machinery:

```ts
const WORKSPACE_DENIAL_CODES = new Set(["codex_workspace_access_denied", "workspace_access_denied"]);
const ENTITLEMENT_DENIAL_CODES = new Set(["codex_entitlement_missing", "entitlement_missing"]);

async function denialFromResponse(r: Response, signal?: AbortSignal):
  Promise<"workspace" | "entitlement" | undefined>;
```

It reads through `readBoundedResponseBody`, refuses a truncated / non-display-safe / duplicate-key document exactly as `resetEligibleCodeFromResponse` does, then looks for an OWN-property `code` at the top level or under `error` — no coercion, no accessors. An allowlisted code maps to a denial; anything else returns `undefined`.

Fail-closed is the point: an unreadable or unknown body keeps the historical credential handling, or a genuinely revoked credential would stop prompting for reauthentication.

## Fix

1. Add `workspace` to `CodexUpstreamOutcomeClass`.
2. Introduce an explicit discriminator rather than sniffing strings at the classifier. The upstream rejection is already parsed once; carry its structured outcome forward:

```ts
type CodexUpstreamEvidence = {
  status: number | "connect_error" | "timeout" | "connect_neutral";
  /** Set when the upstream body identified a workspace/entitlement denial rather than a bad credential. */
  denial?: "workspace" | "entitlement";
};

classifyCodexUpstreamOutcome(evidence: CodexUpstreamEvidence): CodexUpstreamOutcomeClass
```

   401 stays `credential`. A 403 with `denial: "workspace"` becomes `workspace`; a 403 with no denial evidence stays `credential`, so the change fails safe toward today's behavior.

3. **Carry it on the existing meta rather than changing every signature.** `CodexUpstreamOutcomeMeta` already reaches `recordCodexUpstreamOutcome` from every call site, so adding `denial?: "workspace" | "entitlement"` there means only the sites that can actually observe a 403 body need to populate it — in the Responses path, the two `quotaMeta` construction points.

4. In the outcome handler, a `workspace` result must NOT call `markAccountNeedsReauth`. Record the failure in `upstreamHealth` so routing can prefer a healthier account, then return — deliberately NOT clearing thread affinity. Credential quarantine sweeps affinity because reauthentication is account-wide; a workspace denial is not, so existing bindings stay valid. No new per-route store is introduced: the health entry plus the preserved affinity IS the behavior change, which keeps the blast radius to the one wrong remedy.

## Tests

Two existing tests encode the current policy and both must be revisited, not just the first: the classifier assertion at `tests/codex-routing.test.ts:377`, and the 403 quarantine behavior at `:429`. Update them to the new contract.

Add: a workspace-denial 403 does not set reauth and leaves the credential usable on a non-workspace route; a bare/unclassifiable 403 still behaves exactly as today; 401 is unchanged; and a workspace denial recorded through one call site is classified the same as one recorded through another.
