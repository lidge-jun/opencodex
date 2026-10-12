# Recover the integration train and prepare the production candidate

The previous integration stopped after combining 31 contributor changes and before
integrating two completed issue implementations. Preserve those commits, review the
combined behavior in five isolated worktree lanes, repair demonstrated defects, and
land reviewed integration candidates on dev. The final platform run establishes
production readiness; this unit does not publish a release.

Reader: the integrating maintainer, deciding what can land and what remains unverified.

## Scope and completion contract

- Archetype: satisfy the recovered integration specification (C4 for sensitive surfaces).
- Trigger: continuation of the interrupted train with five worktree chats and inherited subagents.
- Goal: reviewed dev integration, attributable commits, final cross-platform evidence.
- Non-goals: release/promotion/deployment/install, credential changes, unrelated backlog,
  revival of policy-blocked items, native GitHub stack registration.
- Verifier: diff/ancestry and attribution inspection; focused explicit regression files;
  one final root/GUI typecheck as relevant; existing structure/layout/privacy gates;
  required final PR checks and final dev workflow_dispatch CI lane=all.
- Stop: only after the disposition ledger and exact-SHA CI evidence support readiness;
  absent/skipped/cancelled checks stay unverified. External acceptance limits stay explicit.
- Memory artifact: this numbered unit; private drafts and raw session evidence stay in scratch.
- Outcomes: DONE with evidence, NOOP for proven already-landed items, or a named unresolved
  blocker. No arbitrary time/token bound was supplied and none is invented.
- Escalation: unresolved product policy, external access, or new out-of-scope authority.
  The user authorized branch preparation, PR integration and coordinator merge judgment.
- Resources: existing local git/gh identity, five lane tasks, bounded inherited subagents;
  no full local suites, test:changed, prepush, dependency install or native builds.
  CI dispatch only once the candidate is assembled; necessary failure repair remains in scope.

## Dependency-ordered work phases

1. Roadmap: lock source commits, lane ownership and verification/closure boundaries.
2. Integration: consume existing patches, review/repair each lane, reconcile the union,
   publish ready A-D first, then E, and land eligible work through the maintainer integration policy.
3. Verification: run full cross-platform CI on final dev and prepare the readiness handoff.

Detailed executable operations are in 010_integration.md and 020_verification.md.
Architecture/source-of-truth remains structure/INDEX.md and its owned documents; each
runtime repair must update its owner doc in the same change.

## Baseline and exclusions

Local train: da40c734a558ea32ce391613f5a0309d14cfce81. Remote dev observed:
2e3acab46e (TokenLab #6474); Grok #6482 is also already landed. The existing train
contains a historical #6474 carry; preserve history but introduce no duplicate content.

Accepted source sets (recovered lane-a.md through lane-d.md packets): A #6474 #6463 #6445 #6470 #6417 #6254 #6382 #6416 #6461;
B #6450 #6449 #6451 #6452 #6453 #6192 #6466;
C #6459 #6479 #6119 #6455 #6477 #6457 #6460 #6415 #6335;
D #6426 #6471 #6149 #6151 #6405 #6458.
Issue implementations #6313 and #6223 are explicitly included.

Deferred dispositions: #6378 #6143 #6472 #6370 #6076 #6301 #6381 #6436 #6336;
#5253 is superseded by the selected locale contribution. Research-only #2511 #4961
#4198 stay deferred for unresolved policy/access. Preserve existing rationale; do not
mistake an effort estimate for a product rejection.

Do not close #6220 without real launcher acceptance or #6473 without native Windows
acceptance. Passing source tests alone is insufficient. Other issue closures require
fresh acceptance review, not just a commit message.

## Consultation and evidence

Recovery explorer established the source scope and original cancellation; main checked
the original user request and follow-up dispatch. Existing lane reports and logs are
historical evidence, not current verification. The architect proposal, main decisions,
reflection, independent audit and current lane manifest are recorded in scratch and
summarized here when received. No private transcript is copied into public git.

Architect consultation: REC-ARCH-01/04/06/07 accepted; REC-ARCH-02/03/05 amended
to keep original A-D carry ownership and put both complete issue slices in E.
REC-ARCH-08 amended to final dev dispatch after merge, preserving pre-merge PR CI.
Same architect returned ALIGNED on the three documents; its two verification gaps
were folded in: check returned headSha and require fresh comprehensive evidence after
a repaired candidate changes SHA. Independent audit remains a separate gate.

Roadmap audit: independent reviewer PASS, no blockers. Fresh reader understood the
answer (preserve and review the recovered train), evidence (pinned git objects and
workflow/policy contracts), and next action (bounded implementation handoff). No
reader-structure repair remained. Document checker passed on numbered documents,
source object existence/parentage, workflow inputs and diff whitespace.

## Integration cycle entry

Previous D: roadmap 995dee54a0 locked after semantic audit and document receipt.
Direction remains to integrate five lane handoffs. The executable 010 design is
unchanged. Fresh preflight confirms the contributor train is clean, original work
remains preserved, and current dev is 2e3acab46e. Five lane tasks now own bounded
implementation/verification, with production code changes limited to demonstrated
defects and the two authorized issue implementations. Root/GUI dependency manifests
and lockfiles match an available existing dependency tree; no install is required.

User steering: land ready work progressively. A-D is ready for its PR now; E follows
in a separate PR. Do not wait for E to publish or land A-D. Final manual lane=all
remains after both landings.
