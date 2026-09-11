# 050 — wp7: generic OAuth multi-account 429 failover (#2568)

Public statement of the gap (the issue is public; the patch design is not, and lives in
`.tmp/260825_backlog_scratch/050_full_analysis.md` until it ships — `AGENTS.md`
§"Security working notes").

Today's ladder: API-key pools rotate by default (`hasKeyPoolFailover`), the Codex pool
has its own quota/lease machinery, and Anthropic OAuth rotates only when its opt-in is
set. `hasKeyPoolFailover` returns false for `authMode === "oauth"`, so several OAuth
providers have no recovery path on a 429.

Phase requirements (acceptance, not design):

1. Enumerate EVERY `hasKeyPoolFailover` call site — Responses core, compact Responses,
   native Chat — and prove each observable OAuth 429 path is covered. Generalizing the
   rotator without this leaves live paths unfixed (001 §H4).
2. The Codex pool is out of scope; its quota scopes, probe leases and affinity must not
   be reimplemented.
3. Existing Anthropic configuration keeps its current meaning.
4. Rotation is bounded per request.
5. **Open consent question for the user:** presence-driven default-on rotation spends a
   second account's subscription quota. This is a product decision, not a code decision,
   and is escalated rather than settled by an opt-out knob.

