# Adjacent Kiro result implementation

The adapter retains each original call ID beside its normalized wire ID and checks
that exact identity on every result. A local group tracks only adjacent results;
non-tool messages, another ID and end-of-input finalize it before the existing
conversation validator runs. The encrypted-result rejection still happens first.

Single results keep their precomputed, tool-identity-aware normalization. Multiple
results keep ordered raw text, real whitespace and failed-exec wrapper information,
while empty-success wrappers do not become extra messages. An initial empty hint
is replaced when later text exists. Images remain on the user turn with existing
limits, error status is sticky, and entirely text-empty image/error groups use one
neutral fallback. Group bookkeeping remains outside Kiro wire objects.

Regression coverage is added to the existing adapter test file, including the
parent task-input plus code-mode-output sequence, collision controls, barriers,
empty/failed wrappers and images. Yrlan's source contribution is attributed.
Proof is independent review and exact-head hosted CI; saved local metadata did not
contain a current multi-output reproduction and no live Kiro call is performed.
