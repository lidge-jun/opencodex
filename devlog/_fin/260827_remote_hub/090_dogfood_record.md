# 090 — Dogfood record: clisu-oracle hub + MacBook client (2026-08-28)

Branch build @ f98081fbf. Hub: clisu-oracle (aarch64), OPENCODEX_HOME=~/.opencodex-hub,
bind 100.100.245.81:10190, data token file-fed, remoteGui.allowInsecureHttp=true,
hub.managementPublicOrigin=http://100.100.245.81:10190, corsAllowOrigins += http://localhost:10100.
Client: this MacBook, isolated OPENCODEX_HOME/CODEX_HOME under /tmp/ocx-dogfood-SzfA
(real user config untouched; the temp grok rewrite from the earlier standalone probe was
reverted to :10100).

Proven end-to-end (commands + outputs in session log):
1. /readyz over tailnet: status ready, protocol 1, managementUrl advertised.
2. /v1/catalog over tailnet: 401 without token; 200 + strong ETag + Cache-Control
   private,no-cache with the data token (516 KB).
3. Admin token over plain HTTP refused by connect ("Admin credentials may be sent only
   over HTTPS") — HTTPS-only admin rule enforced live.
4. ocx gui pair --origin http://localhost:10100 issued a single-use grant (json shape).
5. ocx connect <hub> --pairing-code-stdin --allow-insecure-http --clients codex:
   full transaction — grant exchanged, per-client key 085da5fb… auto-issued, key stored
   ONLY in service-api-token (0600, 50 bytes), catalog placed atomically (262 KB),
   dedicated provider block injected (base_url hub, env_key contract, absolute
   model_catalog_json), client state committed with apiKeyId.
6. Real routed completion through the hub with the per-client key: gpt-5.6-luna answered
   "HUB_OK" (chat.completions 200).
7. Usage attribution on the hub: the request row carries apiKeyId 085da5fb…,
   admissionKind configured — per-machine slice works.
8. ocx disconnect: injected config restored byte-identically to the seeded original,
   token file deleted, client state cleared, reminder to revoke the still-valid key via
   hub GUI (by design — operator-owned revocation).

Three live defects found and fixed during dogfood (each with a regression test):
- 596bb02f3 runtimeRole=hub refused ocx start (state read).
- 19eb6a4bd hub role ran local client syncs on start (readyz failed + grok rewrite).
- f98081fbf connect refused to commit on a fresh machine with no config.json.

