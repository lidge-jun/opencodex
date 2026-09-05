# Pre-merge review closure

The final live review refresh found additional CodeRabbit items after the initial independent
review. No merge was attempted while those findings remained open.

- Provider IDs matching Object properties are valid historical ledger data even when current
  configuration rejects them. Both provider-total and model-group projections now use
  null-prototype records, with shared production helpers and `__proto__`/`constructor` cases.
- New missing-policy early returns retain requestedModel in Chat and Messages final logs.
  A regression supplies logIds and checks persisted 404 rows inside its own temporary home.
- 002 now records the actual final roadmap delta re-audit PASS rather than ending at the
  preceding request to re-audit. 020's rejected scheduler/successor directives and test
  references have been replaced with the final per-roster/single-flight contract.
- Credential-reader redirect rejection is implemented and tested in the dependent quota API
  layer (#3584). This attribution layer does not enable or modify those readers.

The bottom-branch repair is cascaded to both upper branches before publication. No local tests,
typecheck, build, lint or scan are run; each changed stack head requires fresh remote CI.
