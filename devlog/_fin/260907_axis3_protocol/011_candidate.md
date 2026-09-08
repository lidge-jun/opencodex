# Combined candidate

Source baseline: dev 137d6a727. Foundation carries #3815 through 76e07d181 with SB Yoon/Yumi commit trailers. Grok carries #3816 d5e0a9a2 and corrects SSE event overwrite/reset semantics, with Danh Thanh trailers. Added established-history external-task HTTP/continuation/compact fixtures without changing the missing-ID guard. Replay hardening preserves signed/opaque-only inputs and block ordering; signature updates replace previous values according to the SDK accumulator contract, and block closure waits for the next semantic event.

Independent source reviews: Pauli scoped foundation PASS (18/18 files); Faraday Grok/seed PASS. Final Claude combined source audit and remote CI pending. Local suites/typecheck/build not run under user instruction. No live accounts invoked.

Deferred: #3807 lacks raw failing current-version input; #3719 still needs live intended-Anthropic acceptance and controlled cache comparisons. Locally hidden text through Claude and legacy combined-envelope streaming order recovery are not claimed supported. Existing compatibility enforcement, hidden presentation, credential/admission and retention policies remain.

Ordinary PR chain is an integration grouping requested by owner, with final combined CI first. Lower-layer runs only if it fails. Admin merge is authorized after accepted evidence. No GitHub native stack or fabricated check status.
