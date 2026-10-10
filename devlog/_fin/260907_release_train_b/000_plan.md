# Lane B delivery roadmap

Satisfy-spec HOTL, triggered by delegated release-train packet. Goal: prepare a manual #3856 -> #3849 carry chain for main-session integration. No merges, releases, installs, local tests/typechecks/builds, native stacks, or edits to other lane files. Resources: existing git/gh and astra reviewers; user set no token/cost/time limit. Stop after exact top-head remote CI success, independent security verdicts, and handoff evidence. BLOCKED means a concrete unresolved owner/security/CI condition; #3848 is DEFER until #3856 lands. Main reclaims after two distinct failed leaf packets; new worker scope requires plan amendment.

Memory/evidence: this neutral roadmap, `.tmp/lane-b/` for all security work notes, `.codexclaw/` for FSM/goalplan. Escalate cross-lane conflicts to main. How-it-works English/ja/ko/ru/zh-cn ownership was explicitly assigned to B by main. No automatic peer writes beyond collision coordination.

1. Docs-only roadmap audit and lock.
2. Carry quota activation original commits with cherry-pick -x and contributor trailers; inspect default-off, identity and pending-state contracts. Lower layer code verification is deferred to top CI by explicit user instruction; its D certifies carry preparation, not runtime success.
3. Carry Mihomo transport commit plus IPv6-only and canonical NO_PROXY/unsafe companion regressions. Publish manual chain, independently review final implementation, dispatch ci.yml lane=all only on top. Repair lower layers sequentially and cascade with rebase --update-refs.

Verifier: gh workflow run ci.yml --ref codex/260907-b-mihomo-ipv6 -f lane=all; read exact head SHA and every job including Windows shards. Local product commands NOT RUN by user instruction. Inspect workflow definitions instead of executing local verifiers. No claims of live TUN validation; deterministic resolver/pinned transport tests are remote CI proof.
