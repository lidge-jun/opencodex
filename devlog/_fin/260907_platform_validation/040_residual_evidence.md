# Windows and request diagnostic residuals

## Read-only targets

- #3383: inspect current PR and merged descendants for Windows temp creation and OAuth teardown. Confirm current source behavior and test coverage before proposing a residual patch. No picker UI changes.
- #3522: inspect response spill telemetry and fresh-versus-memoized timeout handling. The acceptance is recovery within the same affected Windows process; generic synthetic success does not prove the reported process recovered.
- #3573: inspect decompression rejection diagnostics and exact latest issue measurements. Serialized journal size and normal requests after raising a cap do not prove the rejected compact payload size or compact success.

## Conditional delta

No production edit is pre-approved by this document without a source-grounded residual. If the existing code covers the measurement, record the missing field evidence and leave the issue open. If a specific content-free diagnostic is missing, amend with exact files, field flow and negative assertions before implementation. Never change admission caps, parse a rejected body to count items, relax ACLs, clear memo state, or choose a new recovery/retry policy.

## Completion

Record source/commit evidence, original contributor attribution where code is carried, and a separate status per candidate: already implemented, proven patch delivered, or blocked on field evidence. Do not close an original feature PR or issue merely because one residual probe passes.
