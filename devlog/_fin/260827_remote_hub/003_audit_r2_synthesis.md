# 003 — Audit synthesis, roadmap round 2 (FAIL, 7 blockers) — canonical decisions

Closed in r2: old-2 (managementPublicOrigin chain), old-4 (per-call planes), old-6 (phase-6 owners).
Decisions for the 7 remaining (all fold, no rebuttals):

1 P3-A4 fixture: rejection row uses hub {protocol:2, minimumClientProtocol:2}; a p2/min1 hub
  is COMPATIBLE and gets its own acceptance row. "protocol major 2" wording deleted.
2 Pairing e2e, single truth: ocx gui pair --origin <browser-origin> REQUIRED argument, no
  default (040+070 updated; dogfood runbook passes --origin http://localhost:10100).
  060 gains a pairing UI owner row: gui/src/connect-pairing.ts + i18n keys + activation
  scenario (paste code → POST exchange via relay → session stored). Relay contract states
  it forwards the browser Origin header verbatim on POST /opencodex-session and 060 test
  plan adds the exact-POST-route case.
3 Canonical relay spelling everywhere: POST /api/machine/hub-relay/* (prefix + suffix);
  010:179 updated to the wildcard form.
4 x-opencodex-key-id: configured-key admission ONLY (environment/loopback/none → header
  absent); value re-validated header-safe as ^[A-Za-z0-9._-]{1,64}$ at emission (mismatch →
  omit header, log once); emitted on 200 AND 304; response gains Cache-Control: private,
  no-cache; tests cover absence for environment/loopback and no key-id in logs. privacy:scan
  claim removed — runtime-header privacy is proven by the log-absence test instead.
5 Post-disconnect revoke: hub GUI is the SOLE post-disconnect revocation path. ocx connect
  revoke exists only while connected (state carries apiKeyId from issuance response — 050
  state gains apiKeyId field, full chain issuance→state→revoke→display); disconnect prompts
  a reminder naming the hub GUI page. No tombstones.
6 Zeroization wording: "release references and overwrite the coordinator's Uint8Array copy;
  the immutable argv/stdin string copies are best-effort GC" — OneTimeConnectCredential.value
  becomes Uint8Array (decoded once at read), display never renders it.
7 Rotation chain completed: OcxClientConnectionConfig gains pendingOperation?: { kind:
  "rotate"; rotationId: string; newKeyIssuedAt: string; oldKeyBackupPath: string } with
  validation in the client-config reader; recovery on doubly-accepted = COMMIT the new key
  (delete .prev + clear pendingOperation) because new-key acceptance proves issuance
  completed; .prev writer assigned to src/lib/service-secrets.ts (existing owner) as
  writeTokenBackup/restoreTokenBackup; 080 focused commands add tests/client-connect.test.ts
  and tests/service-secrets.test.ts.
