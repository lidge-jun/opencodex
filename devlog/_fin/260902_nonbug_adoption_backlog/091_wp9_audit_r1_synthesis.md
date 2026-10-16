# wp9 audit r1 — synthesis

Reviewer: grok-4.6 subagent (Kierkegaard). Verdict: resolver funnel first; keychain write must not
re-serialize plaintext through failover/save. Adopted: single sync resolver, sync `Entry`, fail
closed at request time, refuse opt-in when the keyring is unavailable, references in pool entries
so failover persists references only. Deviation from the suggestion to split write path into a
second PR: the write path here is a server-side store/restore that verifies read-back before
touching config, which removes the plaintext-rewrite hazard the reviewer flagged; the dashboard
control is what is deferred.

