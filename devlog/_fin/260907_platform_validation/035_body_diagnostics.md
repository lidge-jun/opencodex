# Bounded inbound-body diagnostic semantics

Issue #3573 requests usable size evidence. The existing error stores a byte value but returns only the admission limit; the byte value currently mixes declared length, observed wire bytes, an artificial limit+1 lower bound, and exact decoded length.

## File delta

MODIFY `src/server/request-decompress.ts`: extend DecompressedBodyTooLargeError with a closed measurement category and retained limit, preserving existing constructor call compatibility. Annotate existing throw sites: declared_wire, observed_wire_lower_bound, decoded_exact, decoded_lower_bound. Append a bounded numeric/category suffix to the current message so existing core.ts error mapping carries it. No request body, path, headers, item counts, further inflate/read, admission-limit changes, or new retry semantics.

MODIFY `tests/usage/request-decompress.test.ts`: extend small-cap fixtures to verify identity/gzip/zstd/deflate and declared/fragmented input semantics. In particular, limit+1 remains a lower bound, never exact size. Verify HTTP 413 and existing error code/type through existing handler mapping. Preserve stream cancellation.

MODIFY `docs-site/src/content/docs/reference/proxy-formats.md`: explain wire declared length vs measured/lower-bound diagnostics, separately from compact-response limits. State that Bun listener rejection may happen before application diagnostics and that this does not measure the exact historical compact payload.

## Acceptance

Unchanged 256 MiB listener/decoder limit and rejection classification. No context-window wording that causes errors.ts to reclassify the failure. Message remains bounded, only fixed categories and finite numeric values. Negative tests run in final remote CI; no local test/typecheck. Keep #3573 open pending exact real compact evidence.

This is a new diagnostic refinement of an issue, not a carry of a new contributor PR. Credit reporter @nowhere1975 in commit prose without inventing name/email. Any borrowed existing PR patches must additionally retain their actual git author trailers.
