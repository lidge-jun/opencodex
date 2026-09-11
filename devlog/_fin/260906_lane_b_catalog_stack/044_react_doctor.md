# 044 — Separate React Doctor gate

The cross-platform workflow passed at `b33d9347`, but the separate pinned React
Doctor 0.9.11 workflow failed. A cold remote reproduction reported one repeated
array-lookup warning, three test-render global-publication errors, and one unused
timestamp binding in a changed test file. Ordinary lint/build success did not
resolve this gate.

Use a Set for selected-model membership while preserving the native exclusion.
Publish test controls from an effect, release only their owned handles on unmount,
and call the current harness setter directly from its retry callback. Remove the
unused pure timestamp calculation without changing the stale-coverage fixture.
No assertions, waiting bounds, scanner rules or warning threshold are relaxed.

The repaired candidate needs a cold pinned scan, the affected GUI tests and its
current-head hosted checks. Existing browser evidence remains evidence of the
recorded source; reuse requires an explicit comparison of the small membership
lookup change rather than pretending the application bytes are unchanged.
