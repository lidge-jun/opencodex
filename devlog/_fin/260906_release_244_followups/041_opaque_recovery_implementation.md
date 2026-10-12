# Opaque recovery implementation evidence

Source 3b8cf8a8f carries PR3535 with a narrowly scoped preflight opt-in. The default
combo event classifier is unchanged; only a matched bare error supplied by the
native decrypt caller is replayable. Headerless streaming is an explicit option
under the existing core condition. Client-reader error evidence is redacted and
bounded before a failed tail is synthesized; real terminals remain authoritative.

Independent plan audit accepted the scoped seam. Independent source/security
review passed: exact 502 gate, one sanitized rebuild, raw-body object identity,
no replay after visible output, cancellation and current rewrite ordering remain.
The source contributor is credited in the carry commit and PR.

Regression commits cover native function and agent-message history, repeated
flat/nested errors, both relay shapes, unrelated errors and default combo byte
preservation, output commitment, missing-header and wrong-media-type controls,
and bounded synthesized-message redaction. The headerless fixture uses bytes
and asserts the absence of Content-Type because a string body supplies text/plain.
No local test suite, typecheck, build or live Kiro request was run. Final evidence
comes from hosted CI on the complete PR head and a fresh independent review.
