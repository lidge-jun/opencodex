# Reserve audit synthesis

Pauli's first plan audit returned FAIL with two accepted high blockers.

1. Custom-named canonical-forward transports bypass auth-context resolution. Fix the real entry boundary, not just the ordinary resolver: main-only proof requirement travels with exact model and qualified transport into every materializer. Expand the auth lane to core/compact producer options, preserve independent keyed-provider behavior, and test the actual handler with zero inference sends on denial.
2. Account generation is not credential/user identity. Exact-token process-local HMAC joins writer identity/generation in cache/flight keys and authorization-object private provenance. Validate the outgoing credential at final materialization; a refresh cannot inherit old permission by object spread. Add same-workspace/different-token and in-flight replacement scenarios.

Cross-blocker consistency: the outer transport decides when proof is required; the owned credential decides which proof can be used. Neither a caller-supplied model nor a copied context field can become authorization. No extra credential file reads are introduced.
No production code written before the updated audit. Parent quota hydration correction is a B prerequisite followed by stack cascade; expiry retirement remains the documented observed-window policy and the timer comment is rebutted by its real cleanup call chain.
