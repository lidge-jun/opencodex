# External task input implementation

The pure task-input leaf validates the complete external envelope before using the
existing input-content converter. It accepts text and URL-backed images, rejects
partial or opaque arrays as a whole, and preserves accepted content order. The
parser uses the result for both the continuation boundary and a user turn that
clears pending reasoning. Ordinary tool results, the core call-id guard and raw
passthrough handling remain unchanged.

Existing unpaired-result regressions remain in place. Added parser cases cover
shape/content controls, original image detail, frozen input, continuation and
reasoning separation; HTTP cases exercise accepted text/images and rejected
envelopes before upstream work. A passthrough case verifies the existing raw
orphan-output behavior alongside the new parsed user representation.

The implementation preserves Yrlan's contributor attribution from the public
issue and supplied proposal. Protocol/security review and hosted CI are recorded
on the fixing PR and source-bound cycle receipt. No local test suite, typecheck,
build or live Kiro request is part of this validation.

The first hosted run exposed two invalid HTTP test stimuli: short text in an
encrypted_content slot follows the existing plaintext normalization path before
the parser. The negative fixtures now use synthetic ciphertext-shaped content
with an explicit classifier check; a separate positive control retains plaintext
slot compatibility. The 400/no-upstream assertions and production logic are unchanged.
