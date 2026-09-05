# Review synthesis

A: Huygens GO-WITH-FIXES. Accepted old-hub metadata absence and disabled exact-ID collision blockers; final implementation uses explicit hub booleans only and checks complete IDs before filtering.
B: Mendel found one documentation contradiction (old export exclusion). Accepted and replaced the stale paragraph. No runtime/auth/secret blocker in parent scope. Worker Noether completed all shared serializers and CLI transport with no local tests. Parent preserved direct OpenCode ordering and corrected CLI emitted counts using serializer summaries.
Verification pending: exact-head CI and final independent export review. No local suite or typecheck executed.

C: Nietzsche independently reviewed the complete export slice at 13f8d0391. No blockers; accepted P3 launcher count correction so both CLI commands report expanded model counts. All twelve serializer paths, remote authority, collision/idempotence, metadata and auth preservation reviewed.

## C repair: suffix-shaped real model identities

CodeRabbit suggested suppressing every selector already ending in --fast. Independent adjudication by Nietzsche rebutted that blanket fix: fastRowBases seeds configured real IDs before its structural suffix refusal, and parsing strips exactly one suffix. Thus a configured model--fast legitimately has a model--fast--fast priority selector. Synthetic export rows already carry false availability, so repeated expansion is inert.

Accepted the narrower defect: live-only suffix-shaped bases are deliberately not recognized by the parser, but capability-only discovery could advertise them. Fix the shared listing/export eligibility predicate to reject suffix-shaped bases absent from fastRowBases, and test configured versus live-only base behavior plus all-client configured-suffix exports. Both raw discovery and management exports consume this predicate, avoiding divergent fixes. Previous 4ca1ec5ff full CI passed; this repair requires a new exact-head CI run.
