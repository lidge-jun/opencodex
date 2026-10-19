# ADR-7369: decision recorded under "Cold opaque-state rejection recovery"

- Purpose: recover an explicitly rejected native reasoning blob in a restored thread (#7369).
- Constraint: process-local route/retention history can be absent after restart, while real outbound
  ciphertext still exists. HTTP 200 SSE can carry a failure; a projected HTTP 502 can identify the
  same rejection. Neither status alone is proof of acceptance or rejection identity.
- Alternatives: strip every cold blob in advance, duplicate the recovery serializer, or reuse the
  existing bounded preflight, strict rejection classifier and guarded outbound-only rebuild.
- Decision: preserve the same dedicated code/exact wording across flat and nested envelopes,
  select preflight from actual outbound opaque state, and admit an explicitly identified
  502 under the existing classifier. Preserve the special function-output evidence requirement.
- Consequences: native success retains ciphertext; one sanitized rebuild follows only a proven
  pre-output rejection, subject to the existing send/ambiguity guards. Generic transient retries
  remain separately counted. No on-disk history change, plaintext invention or native decryption is
  introduced. Stream preflight may retain its existing bounded prelude on more cold opaque turns.
