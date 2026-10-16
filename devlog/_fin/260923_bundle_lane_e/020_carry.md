# Carry plan

Commit order (one commit per item, Co-authored-by trailer for the original author):

1. #5629 (luvs01) plus review fixes.
2. #5659 (Ingwannu) plus review fixes; Closes #5495.
3. #5646 (FredAmartey).
4. #5633 (FredAmartey) with the import and structure-doc cleanup.
5. #5489 (AaronZ345) net diff (its upstream/dev merge commit dropped) plus the replayUnsafe fix.

Mechanism: cherry-pick each PR's own commits (squashed per PR) onto the lane branch, then apply the folded review fixes in the same commit. Registries (scripts/test-layout/layout.json, tests/fixtures/test-layout-expected.json) keep every dev entry.


## Documentation folded from the audit

- #5489: one new row in the hop/terminal table of docs-site/src/content/docs/guides/combos.md (an undeclared first tool call before any output and without a replay-unsafe side effect hops; after a replay-unsafe side effect it stays terminal), mirrored in every translated combos.md that carries the table; structure/runtime.md and structure/transports/responses-failover.md updated.
- #5659: one sentence in the English code-mode section of docs-site/src/content/docs/guides/codex-integration.md, next to the existing shell/patch repairs. Locales do not describe these repairs, so they do not contradict it.
