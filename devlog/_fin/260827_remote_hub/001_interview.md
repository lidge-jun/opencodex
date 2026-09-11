# 001 — Interview record (2026-08-28)

Answers captured from the maintainer (session 01a0439a, I-phase round 2):

- **Scope: ALL 6 phases, full implementation including hardening (P6).** Delivery as a
  stacked PR chain grown from this branch (codex/remote-hub-design is the stack base;
  each phase PR targets the previous head; retarget to dev as parents land —
  DEV-STACK / enforce-target child rules).
- Q2 (plain-HTTP pairing): accepted — rung 4 ships in Phase 2 with rung 3.
- Q3 (per-client keys): recommendation accepted BUT see new usage requirement below,
  which pulls toward auto-issuing per-client keys at connect.
- Q4 (URL split): accepted — separate managementUrl allowed, /readyz advertises it.
- Q5 (remote session TTL): accepted — renewable long-lived remote sessions.
- Q6 (hub local integration): accepted — hub does not inject locally by default.
- Q7 (Claude): launcher-scope first confirmed; maintainer notes it is machine-local
  anyway — clean separation is the requirement, not persistent integration.
- Q8 (deployment): **dogfood on clisu-oracle as part of this work**, AND the protocol
  must tolerate release-build peers: a released client against a dev-build hub (and
  the reverse) must interoperate "어느정도" — i.e. protocol-version negotiation in
  /readyz is a hard requirement, not polish (Phase 1 scope).
- **NEW requirement (usage attribution):** the client GUI usage page should reflect
  "my machine's usage" while connected, and after `ocx disconnect` the GUI (back in
  standalone mode) shows the local proxy's own usage again. Feasibility confirmed in
  code: usage attempts already persist `apiKeyId` for configured-key admissions
  (src/server/management/api-key-usage.ts:78-89, admissionFields in
  src/server/auth-cors.ts:369-375), so a per-client filtered usage view is a query
  over existing data — it requires the machine to authenticate with its OWN key,
  which is why connect should default to per-client key issuance.

Open contradiction (to resolve this round): shared-token-allowed (Q3 answer) vs
per-machine usage view (new requirement) — attribution is keyed on apiKeyId, so a
shared token collapses all machines into one bucket.

## Round 3 answers (2026-08-28)

- **Q-A = a (auto-issue per-client key at connect).** Storage question resolved in
  code: the key is NEVER written to config.toml (env_key contract); it lands in the
  existing owner-only token file (serviceApiTokenFilePath, src/lib/service-secrets.ts:5,
  0600 + ACL hardening) which the shim already reads into OPENCODEX_API_AUTH_TOKEN when
  the env is empty (src/codex/shim.ts:699-701 unix, :1000-1001 batch, :1043 ps).
  disconnect deletes the file. The shared-token-vs-attribution contradiction is CLOSED:
  per-client keys are the connect default, so per-machine usage attribution works.
- **Q-C = a.** Protocol v1 negotiated via /readyz; same-major interop with
  feature-detection; guaranteed pair = dev hub ↔ latest release client; older peers get
  an explicit "hub protocol too new/old, upgrade ocx" error. Phase 1 hard requirement.
- **Q-B: OPEN ASSUMPTION (low)** — usage page default while connected = "this machine"
  slice with a toggle to hub-wide; not answered explicitly, adopting the recommended
  default; reversible in Phase 4 GUI work.

## Final contradiction rescan (round 3)

- Shared-token vs attribution: RESOLVED (per-client default; shared token remains a
  degraded documented mode where usage collapses into one bucket).
- Pairing-grant issuance vs POST /api/keys authority: connect needs admin-class
  authority ONCE — satisfied by pairing code (rung 3/4) or admin token; neither is
  persisted on the client. No contradiction.
- Dogfood release-compat vs stacked delivery: protocol version lives in Phase 1 (stack
  base), so every later phase rides it. No ordering conflict.
- Remaining OPEN ASSUMPTIONS: Q-B default; session TTL exact value (12h sliding,
  tunable); relay streaming backpressure deferred to Phase 6.

Interview readiness: Goal/Constraint/Success/Ontology all covered by asked-and-answered
rounds 1-3. Ready for I -> P.

## Round 4 answer (2026-08-28) — usage rendering settled

Maintainer's rule, adopted verbatim as the design: **connected → render the hub's
usage (my apiKeyId slice); not connected → render the local usage.jsonl.** No local
mirroring of the connect-period usage (option b rejected as unnecessary complexity);
the connect-period history lives on the hub and is visible there. Grounding:
usage persists where the serving proxy runs (appendUsageEntry →
~/.opencodex/usage.jsonl, src/usage/log.ts:166-167, 521-523), so this rule is just
"render the store that actually recorded the traffic" — zero data duplication,
no schema change. Q-B default (this-machine slice with hub-wide toggle) stands as
the connected view's default.
