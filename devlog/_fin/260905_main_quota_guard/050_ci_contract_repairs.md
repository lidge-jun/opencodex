# CI contract reconciliation

CI33943946291 exposed an integration regression: policy retention was applied to legacy reset-only short tuples. It is now restricted to the policy merge; legacy rotation keeps dev's unknown-tuple behavior, credits/weekly carry and fresh observation-time stamping. The upstream routing assertion remains unchanged, while own tests exactly distinguish legacy unknown data from retained policy99.

The same run exposed an undeclared existing GET /api/quota-resets and a lazy-dispatch guard that the route scanner could not assign a method. The route is declared under its actual read-only handler; exact-only matching reuses the existing namespace helper without changing other namespaces, authorization, handler semantics or lazy imports. GET200/invalid-limit400 remain covered; child/prefix/POST cases require null. No scanner exemption or weakened gate was introduced.

CI33944061586 also found an exact header snapshot missing dev's new shortObservedAt. The assertion now requires that numeric field and equality with the same write's updatedAt, preserving all window values. The finite-range wording nit in017 is corrected in this already-required update.

No local suites. Fresh exact-head CI and upper cascade are mandatory; failures are treated as contract evidence, not flakes.
