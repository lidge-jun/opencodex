# Reserve loopback-target parity repair

The maintainer's PR3578 review identified a functional mismatch: the server accepts the single DNS root dot in `localhost.`, but the catalog/injection helper rejected it. The repair plan was independently source-reviewed before implementation.

The target helper now performs the same single trailing-dot normalization as the server. Existing positive/negative tables assert both predicates against explicit expected results, including case/whitespace, `localhost.`, and the still-invalid `localhost..`. The server import is test-only; receiving-listener authority and Reserve entitlement checks are unchanged.

The runtime/UI layers were cascaded onto the latest reviewed parent repair. No local test suite was executed. Fresh exact-head CI and review remain required before bottom-up admin landing.
