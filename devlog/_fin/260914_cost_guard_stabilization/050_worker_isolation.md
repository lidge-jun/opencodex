# 050 — wp5: fan-out must not spend an interactive session's capacity

## Today

The proxy does not budget fan-out at all. There is no per-root cap on concurrent
children, no cold-input ceiling, and no cumulative spend limit per workflow. The
only limits are process-wide (`MAX_ACTIVE_TURNS`, `MAX_ACTIVE_SESSION_LANES`), and
Codex's own `max_concurrent_threads_per_session` and `max_depth` live in client
TOML that the proxy never enforces. `checkInputAdmission` is a single-turn context
preflight, not a budget. The main-account hard lock is described in its own code as
an observed-usage policy rather than a reservation.

Worse, the pool affinity key is derived from `x-codex-parent-thread-id`, so an
entire fan-out pins to the same binding the interactive session is using. Hundreds
of large children and the conversation the operator is actually watching draw from
one account, and the children are the ones with cold prefixes.

## The rule

Reserve before dispatch, not after billing. A root workflow holds a budget covering
its children and their retries; children are admitted against the reservation, and
the reservation is charged with real usage as results arrive. Interactive traffic
keeps capacity that worker fan-out cannot take, whether by separate accounts or by
priority reservation within one pool. Exhausting the worker budget stops dispatch;
it does not spill onto the interactive account, and it never silently escalates to
a paid API path — that needs its own approval and its own ceiling.

The seams are known: turn admission plus parent-keyed inflight accounting for
concurrency, the pool affinity key and thread resolution for who pays, the spawn
preview before auth for pre-dispatch refusal, and input admission for cold and
cumulative input volume.

## Identity, kept separate

Four concepts are currently collapsed and need to stay distinct: the root workflow
that owns the budget, the conversation that owns the account binding, the cache
cohort that can share a prefix, and the execution lane that de-duplicates
overlapping runs of the same child. The existing split between a parent-preferring
affinity key and a parent+child execution lane is deliberate and correct —
serialising siblings under one parent id turns healthy parallelism into 503
collisions — so the budget must attach to the root without re-merging the lanes.
