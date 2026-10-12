# Work phase 2 — Evidence-backed disposition

Final reconciliation depends on wp1. Following the owner steering to tidy PRs before release, each fully verified source may be superseded progressively during publication; writes require its own completed coverage review, not completion of unrelated lanes. wp2 audits the ledger and handles remaining dispositions.

## Changes
- NEW .tmp/next-release/closure-ledger.json: kind/number, observed source head or issue updatedAt, dev SHA, matched implementation PR/commit, coverage/gaps, exact comment text, comment URL, before/after state, decision/reason.
- NEW 021_disposition_results.md: public numbered list of closed/replaced items and retained residuals with source URLs.
- MODIFY each eligible source PR on GitHub: open → commented with replacement link and retained/dropped scope → existing superseded label if available → closed (not merged). Preserve all branches, especially parents of open children.
- MODIFY each proven fully landed open issue/PR: open → evidence comment naming dev commit and resolved scope → closed. No bulk close by age/title. PR closure never masquerades as merge; issue completed only when acceptance is met.

## Procedure and activation evidence
1. Sol PR and issue leaf surveys return disjoint candidate sets. Main spot-checks source intent, actual dev code/commit and regressions; source titles/green checks alone are insufficient.
2. For replacement sources, compare latest source SHA with captured snapshot. A moved head requires delta review before closure. Verify replacement exists, attribution survives, useful changes accounted for and unresolved requirements represented.
3. Read state immediately before mutation; skip already-closed items and record who/what closed it when visible. Publish only scoped disposition comments in English through structured args or body-file, then close.
4. Fresh gh read verifies comment link and closed state. If comment succeeded but closure failed, retry only the failed closure after revalidation. If partial coverage or ambiguous evidence, keep open with reason; do not discard behavior.
5. Issue #6511 remains open absent actual Desktop acceptance. New replacement PRs remain unmerged, issues tied to them remain open.

## Verification
Document validator reads all numbered docs and ten source coverage entries. GitHub reads verify exact remote states. Human semantic review verifies whether acceptance matches landed behavior; a JSON checker cannot prove that. No new runtime enforcement is introduced; final layer: human/agent source review, bypass risk is mistaken evidence, reduced by independent survey plus main spot-check. Source-of-truth docs change only in their owning production lanes.

Progressive closure does not change the six lane ownerships or merge gate. Source #6524 first qualifies: published #6551, unchanged original head, identical runtime source, full regression/document coverage, real-author trailers and exact-range independent security PASS. Hosted CI remains pending and supersession comment must explicitly say the replacement is unmerged.

wp2 P consumes previous wp1 conclusion and unchanged coverage/closure policy. Architect NR-D01 accepted: final remote audit verifies9closed-unmerged originals, exact comments/sourceheads and supersededlabels; partial6548 and relatedissues stayopen. NR-D02 accepted: closure-time SHAs stay historical, current-head review deltas appended separately. Actual remote check-dispositions.py exited0 on all9closures and9openissues; no production verifier is claimed.
