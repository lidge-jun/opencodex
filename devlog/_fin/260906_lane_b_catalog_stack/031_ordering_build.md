# Ordering carry build

Replacement #3700 carries all four source #3571 commits through `0a935c5694229760c8c1cd5a62072107d8ae6696`, retaining voiys as author and coauthor. It preserves configured canonical OpenCode Go ladders in generation/retention and separates full-picker display order from natural spawn priority.

Production-writer tests cover both convergence and retained sync, healthy/outage equivalence, refreshed featured ranks, idempotence and the same five eligible candidates. Source review found that the new merge paths lacked the builder's runtime normalization for the existing passthrough modelPickerOrder field. All three boundaries now share the same nonarray/nonstring/blank filtering while preserving significant ID spelling. Malformed-input production-writer cases and remote causal checks verify that repair. English/French source documentation is synchronized with the six other existing ordering guides and the catalog SoT.

Parent #3695 was admin-merged on dev as `ab6762bdb35db24efbe1ceac77a1f9e5e6139616` after every actual CI producer succeeded. The aggregation-only ci job was still queued and explicitly recorded as an owner-authorized administrative exception; no actual test was bypassed. Independent reviews and remote backend/component/typecheck/docs/browser/red-green evidence passed. Source #3654 and issue #3651 were closed after dev ancestry proof, and #3700 was safely retargeted to dev.

Final ordering review and exact-head remote/hosted execution are pending at this checkpoint. No local repository tests, typechecks or builds were run.
