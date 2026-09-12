# Accounts work is delivered as independent policy and lifecycle changes

Readers: the integration maintainer deciding which PRs can land and which issue acceptance remains open. OAuth callback retirement is independent of pool scheduling; history precedes capacity estimation; dedicated native-main reauthorization precedes its dashboard control. Existing reset activation, reset-credit operation identity, and canonical Fake-IP transport are preserved and verified rather than reimplemented.

## Execution contract

Satisfy-spec HOTL, triggered by the accounts-lane delegation on 2026-09-12. Scope: PRs #4280/#4080 and issues #3375/#3376/#4211/#3781/#3898. Goal: reviewed, attributed implementation PRs and final-tip hosted CI evidence with truthful remaining acceptance. Non-goals: merges, releases, service/account/config/network changes, native GitHub stacks, local product test execution of any size, heavy local build/typecheck/install. Existing credential/tool scope only; no user-imposed token/time/agent-count cap.

Verification: source inspections and `git diff --check` are text checks only; regression test sources run on GitHub-hosted CI at each final cumulative tip. Intermediate cycle C records source review and deferred remote evidence, never local test passes. Stop: all implementation/disposition and final CI criteria met, or actual inaccessible field acceptance distinctly recorded. Outcomes: DONE for demonstrated delivered scope; PARTIAL/NEEDS_HUMAN for authenticated field or maintainer security acceptance still missing; actual tool rejections retained without bypass. Main owns implementation; inherited-model read-only agents advise on design, reflect the concrete plan, and independently audit A. No native architect role is exposed, so none is claimed. No extra setup is required by that limitation.

Memory artifacts: this numbered unit, session-bound goalplan/ledger, and task-local `.tmp/accounts-20260912/000_handoff.md`. Security analysis stays only in scratch. Escalation: actual tool permission denial or new out-of-scope action; main reclaims failed read-only work after two distinct failed dispatches, retaining any independence gap.

## Delivery map

| Cycle | Outcome | Dependency | Branch relationship |
| --- | --- | --- | --- |
| roadmap | Lock these documents, no product edit | none | local docs checkpoint |
| callback | Carry latest #4280 with author credit | roadmap | independent dev PR |
| eligibility | Automatic pool selection honors excluded plans; explicit route preserved | roadmap | independent dev PR |
| reset | Carry #4080 reset-first ordering | roadmap | independent dev PR |
| generic-family | Family headroom and cooldown context | roadmap | independent dev PR |
| lifecycle | Generic affinity and classified recovery | generic-family | child of generic-family |
| generic-health | Selection reasons and health presentation | lifecycle | child of lifecycle |
| warmup | Durable one-shot zero-usage activation | roadmap | independent dev PR |
| history | Bounded raw quota observations, generation-safe retention | roadmap | independent dev PR |
| capacity | Estimated capacity with evidence/sample count | history | child of history |
| tun | Safe probe failure classification and consumer projection | roadmap | independent dev PR |
| reauth-api | Dedicated native-main device grant persistence and CLI | roadmap | independent dev PR |
| reauth-ui | Main-card start/poll/cancel | reauth-api | child of reauth-api |
| final | Repair hosted final-tip CI, collect reviews and disposition | all implementation | no merge |

Per-phase decade documents carry before/after contracts and conditional acceptance. Every later P revalidates source anchors. Ordinary manual chains express only real dependencies. `.github/workflows/ci.yml` runs pull_request without a base filter; no workflow modification or cancellation is authorized. Source ownership comes from `structure/manifest.json` and `structure/INDEX.md`; update all owners when their area changes, preserving relevant facts with cross-links.

## Current evidence and limitations

Baseline `origin/dev`: 69e3dcda755a52feb1327edad6c8ea6cefd6e871. PR #4280 live head: 1f826d92c7205f31ce174bbd987c04b2b08f7da4; its follow-up includes 404 closure and all three OAuth structure owners. PR #4080 live head: ecf6b4e48a4c2992c296fada2caf6a8132313eaa. Both remain open. Fresh source/issue snapshots are in scratch; historic CI claims in PR bodies are contributor evidence only.

`cxc map src/codex --limit 18` is unavailable in the installed plugin (requires a source checkout); use source ownership and bounded text searches instead. Session is bound to this managed worktree and host goal exists; hooksVerified=false does not prove Stop continuation. Local tests/build/typecheck/install: NOT RUN. Authenticated TUN field acceptance cannot be inferred from injected-DNS tests.

## Source reconciliation decisions

#4238 already implements the excludedPlans selector; this unit completes reasons and removes automatic all-excluded fallback, preserving explicit routing and native-main exemption. #2562 latest maintainer comment chooses generic pooling, so both Google-specific routers remain design inputs. Generic work is split into family context → lifecycle → health presentation; a separate warmup cycle covers one-shot zero-usage scheduling. These units are registered in the same goalplan. #3588 reset activation and manual reset operation-id are already implemented.

Two design follow-ups encountered inherited-model capacity errors; one same-handle retry was requested, no model/settings were changed. Independent A audit remains required.

## Roadmap cycle outcome

Independent design reflection and A re-audit passed with the source restrictions in 001_roadmap_audit.md. B freezes the contracts as documentation only. C checks document paths/numbering and git whitespace; local product suites NOT RUN. D next direction: execute 010_callback.md independently, then the remaining dependency-ordered cycles. Runtime behavior has not improved yet; the rejected hypotheses were native history identity by sentinel alone, attempt timing inferred from untimed attempts, and one-shot implying one physical request through a retrying primitive.
