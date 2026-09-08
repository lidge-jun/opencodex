# Implementation and verification boundary

The raw conversational-item predicate now reuses externalTaskInputContent, matching
the parsed continuation predicate without another envelope validator. Replay-prefix
skipping and the existing fallback remain unchanged.

Three new cases parse with previous_response_id already in the raw body, exercise
external input alone or after a real protocol result, preserve a historical external
envelope in the replay prefix, and compare raw/parsed/reparsed role-content order.
They retain the stateful field during reparse and assert the initial parsed boundary,
avoiding a fixture that could accidentally validate stateless behavior.

Apply this review fix to #3743. Source review and exact-head hosted CI are recorded
on that PR and in the cycle receipt; no local test suite or live Kiro request is run.
After verification, resolve the review and refresh the preserved Kiro branch before
its implementation cycle continues.
