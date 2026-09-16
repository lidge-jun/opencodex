# 055 — final Linux CI repair

Frozen head 55395a9dc, run 33943525788:

- Linux 2/4, job 101246770906: three route-registry reconciliation failures for GET /api/quota-resets. The new lazy mount used a path-only literal guard and the endpoint was missing from the inert registry. Repair: use the same namespace delegation helper as other lazy mounts; declare the owned GET route; declare the already-implemented provider resets CLI capability and regenerate its source-owned surface map.
- Linux 1/4, job 101246770920: existing rate-limit-reset-credits exact-object assertion omitted newly persisted shortObservedAt. Add the field expectation, retaining every original assertion.
- Linux 4/4, job 101246770910: update-stop-first restarted proxy did not become healthy in its existing 90s budget. An isolated Astra executor is investigating the actual launcher/test lifecycle; no timeout inflation or blind rerun accepted.
- Linux 3/4 is still running. No local tests, suites, or test:changed are executed for repair.

Current worktree for the first two fixes is isolated at the frozen SHA. This is the C-to-B repair loop, not a new feature scope.

