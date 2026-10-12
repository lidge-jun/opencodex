# Preserve native Ollama tool batches through assistant commentary

Ollama replay currently settles an open tool batch when assistant commentary appears, so the later genuine result becomes orphaned. Carry #6509's local batch deferral and add adversarial validation/immutability coverage. This is independent of the Antigravity PR #6514.

Reader: release coordinator choosing an independently verified head for integration.

- Archetype/trigger/goal: satisfy-spec Lane C 020, C3 adapter contract. Preserve genuine results next to their original calls while retaining strict validation.
- Non-goals: merge/release, account/config/service changes, OpenAI adapter changes, cross-batch result recovery, shared registry normalization, new paid resources.
- Verifiers: existing native request/parser/reasoning/structured-output tests, shared tool-conformance tests, new malformed/history/frozen-input cases; typecheck/privacy/structure/file-size/docs build and applicable exact-head PR CI. Baseline seven Ollama/conformance files passed 87 tests; commands and logs in ignored scratch. Full local suite exception: concurrent worktrees and import-graph expansion to 1,490 files; prior broad run failed in documented unrelated test-home fixtures, not claimed passing.
- Stop/outcomes: local implementation cycle closes after focused proof and independent code/security review; c-4 retains actual successful CI and complete handoff. DONE requires all lane criteria; unavailable native service or unrelated harness coverage remains explicit, never fabricated.
- Artifacts: this unit and .tmp/release-stabilization/report.md. Escalate only new scope/authority or valid unresolved blockers; no user token/time cap. Bounded commands, inherited leaf subagents, no account mutations or new paid resources.

Previous D: Antigravity local cycle closed at f9e1e6b492 with focused tests/gates/docs and code/security PASS; #6514 current-head CI remains c-4. Continue the prewritten independent Ollama 020 direction. Coordinator ROADMAP LOCKED remains in force. Its final integrated parallel regression is coordinator-owned; this slice may publish promptly after scoped review/tests. Lane B exclusively owns shared registry duplicate normalization; this slice needs no new registry entries because the existing native test file is uncapped.

Source #6509 de5bb1f215c613670e03585e918a344c510ba97a remains open; carry all four source commits with provenance and Co-authored-by: potota90 <85318310+adtumk@users.noreply.github.com>. Use own codex/release-261003-c-ollama branch from fresh dev, ordinary PR target dev, no native stack registration. Preserve source author branch and PR.

Prior roadmap architect Hume 01a1020f-0150-7a62-ba3e-e2b7bad4494a proposed D5/D6 and reflected ALIGNED; whole-roadmap independent audit PASS. This cycle revalidates the exact 010 source diff and specified new tests at current dev. No change in module responsibility or interface: unresolvedCount is request-local pending-batch state. Independent A recheck precedes B.

File map: MODIFY src/adapters/ollama-native.ts; tests/providers/ollama/ollama-native.test.ts; docs-site/src/content/docs/reference/adapters.md; structure/providers/chat-compat.md. ADD this numbered unit documentation. Detailed source diff and acceptance scenarios are in 010_replay.md. No new public field, stored schema, endpoint or dependency. Runtime flows and all adjacent adapter owning documents are reviewed; only the Ollama replay paragraph changes.

Revalidation: git apply --check on the source four-file diff exits 0 against current dev. Existing adapter source remains byte-identical to the original roadmap baseline. Baseline counts are 26 native + 29 parser + 6 v4 + 7 reasoning + 10 structured-output + 8 tool-conformance + 1 buffered-conformance = 87 pass, 0 fail, each file isolated.

Same-architect D5/D6 reflection ALIGNED; corrected stale self-reference and removed unused new-file alternative. Exact additional adversarial test block is recorded in 010. Coordinator provided common registry normalization 29a9e91f400d24ac746a18dfe3af357f5da6dec3 for adoption with -x provenance; no auth runtime carry.

B carried all four #6509 commits with original authors and -x provenance. Additional negative/frozen-input tests failed five cases on the original adapter (31 pass/5 fail) and all42 native tests passed after carry. No new fixture registry entry or routing/account change. Next C validates related native/conformance suites, typecheck/privacy/structure/docs and independent security review.
