# 002 — Audit synthesis, roadmap round 1 (FAIL, 10 blockers) — canonical decisions

Reviewer: Volta (same reviewer retained for re-audit). Per-blocker disposition:

1 [fold] Fixture repair: hub-too-new = hub{p:2,min:2} vs client p1; hub-too-old = client p2 requiring min2 vs hub{p:1,min:1}. Zero/malformed rows move to the malformed-input test class (400), not the mismatch class.
2 [fold] Chain completion: 030's readyz metadata builder signature becomes build(config, req) from Phase 1; Phase 2's file map adds src/remote/protocol.ts + the /readyz handler as consumers of hub.managementPublicOrigin (config wins over observed origin when set).
3 [fold] Pairing end-to-end: the relay (060) and the mgmt ingress (070) BOTH allow POST /opencodex-session (exchange) in addition to GET bootstrap; ocx gui pair prints a code bound to a caller-supplied browser origin (default http://localhost:10100); dogfood config (070) adds corsAllowOrigins:["http://localhost:10100"].
4 [fold] Plane mapping is per-CALL, not per-page: Startup/Integrations keep their existing /api/* calls on the shared plane; only new machine sections call /api/machine/*. 060 file map adds gui/src/pages/Startup.tsx, Integrations.tsx, ApiKeys.tsx, Grok.tsx (call-site routing), and drops the page-level table.
5 [fold] Canonical names, propagated everywhere: routes = exactly 060's /api/machine/{status,clients,sync,shim,disconnect,hub-relay} with GET/POST /api/machine/shim (no PUT clients/:id — 010 updated); connect flags = --pairing-code-stdin | --admin-token-stdin (050 drops --credential-*; 010 drops --token-env/--token-stdin).
6 [fold] Phase 6 owners renamed to the real creators: src/client/hub-client.ts, src/client/hub-relay.ts, tests/client-connect.test.ts; tests/remote-catalog.test.ts either created BY Phase 6 (listed as Add) or folded into client-connect tests — 080 names it as Add.
7 [fold] /v1/catalog gains authenticated-only response header x-opencodex-key-id echoing the admitted key's id (030 IN-scope; never on unauthenticated paths); 080's rotation probe consumes it.
8 [fold] Remove impossible self-invalidation: pairing grants are NOT key-bound; disconnect revokes nothing on the hub by itself — key deletion is an operator action (hub GUI / ocx connect revoke WITH admin credential). 080 reworded; 040 grant contract loses boundKeyId.
9 [fold] 050: transient admin credential is retained in memory until the connect transaction commits or rolls back, then zeroized.
10 [fold] 080 rotation names src/cli/connect.ts (parser) + tests; src/client/state.ts pendingOperation {kind:"rotate", newKeyIssuedAt, oldKeyBackupPath} full chain; rotation writes old key to <tokenfile>.prev (0600) until verified commit, then deletes — crash recovery documented.

No rebuttals; all 10 folded.
