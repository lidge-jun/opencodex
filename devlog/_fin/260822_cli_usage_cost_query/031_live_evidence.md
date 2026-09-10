# 031 — Live activation evidence

Captured against a **patched** server bound to an ephemeral port. The user's
own proxy on `10100` runs the released 2.27.0 build and was deliberately not
stopped or replaced: a first attempt to run `ocx usage --range today
--provider xai` against it silently returned the unfiltered 30-day window,
which is itself the proof that both flags are genuinely new rather than
accidentally pre-existing.

## `ocx usage --range today --provider xai`

```
Usage — today, provider=xai

Requests   2,026
Tokens     221,161,351  (in 220,340,280 / out 821,071)
Est. cost  ~$218.2842    API list-price equivalent (this range)

PROVIDER  REQUESTS  TOKENS       EST. COST
xai       2,026     221,161,351  ~$218.2842

MODEL     PROVIDER  REQUESTS  TOKENS       EST. COST
grok-4.6  xai       2,026     221,161,351  ~$218.2842

Not a billing receipt. Subscription usage or provider credits may apply instead.
```

This is the question that started the unit, answered by one command. Before
the change the same question needed `--range 7d --json` piped into a script
that filtered `days[]` by date and `models[]` by provider — and even then the
cost was unavailable, because day rows carried no cost field.

Both new branches are observable here: the header echoes `today,
provider=xai`, and the totals are scoped to one provider rather than the
full window.

## `ocx usage --range today --provider no-such-provider`

```
Usage — today, provider=no-such-provider

No usage recorded for provider "no-such-provider" in this range.
Check the spelling against `ocx usage --json`, or widen --range.
```

The miss path is the one with no other observer. A projection that silently
fell back to unfiltered data would look *more* useful here while being wrong,
so the empty result is stated explicitly and points at the two ways to recover.

## Cross-check

The unfiltered run against the same log reports 8,052 xAI requests over 30
days; the today window reports 2,026. The narrowing is real, not a relabelled
total.

## Cache-poisoning guard, by falsification

The guard test was verified by breaking the code it protects:

```
break:   warm loop stores project(summary) under the range:surface key
result:  (fail) a filtered request never poisons the cache for the next unfiltered one
revert:  31 pass / 0 fail
```

A first break attempt (`summary = project(summary)`) was rejected by `tsc` as
an assignment to a const. That is not a falsification — it never ran — so it
was discarded and replaced with one that reproduces the real defect shape.
