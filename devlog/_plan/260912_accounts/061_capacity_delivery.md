# Informational effective quota capacity

This child of #4404 estimates observed reported tokens per100percentage from bounded raw observation intervals. It preserves private publication UUID checks and requires an explicit unique pool log label. The estimate is low-confidence with disclosed rounding, retained-valid-row, external-usage and label-continuity assumptions; it is not a provider limit or scheduling policy.

Regression sources cover a hand-computed1000tokens/10points=10000, duplicates, single-send evidence, provenance/reset/interval/independent-model conditions, numeric overflow, bounded ledger rejection, populated API/CLI output and identity replacement during async usage read. Existing local-answer provenance now survives attempt normalization. No local suite/build/typecheck/install was run. Independent design source audit passed; implementation source review and final cumulative hostedCI remain pending. Actual hostgoal blocked/FSMB untouched; no persisted capacity PABCD cycle is claimed.

Source review corrections: API accepts only explicit shared quota scope, excluding blank/undefined model identity through an actual populated API regression. CLI prints insufficient-evidence reasons through the closed reason parser, with estimated/insufficient human+JSON fixtures. A positive fraction that rounds to zero yields no estimate. Local suites remain NOTRUN.
