# Merge train round 2 — roadmap

Inventory at `dev` `6581b561a7` (2026-09-27), rebased on `a846dea201` after the audit (#5981 landed in between). Each
batch lane re-checks its PRs against live `dev` before building; #5951 shares `src/adapters/kiro/stream.ts` with the
landed #5981. Six independent read-only Sol triage lanes covered the open PRs: new bug PRs,
recent and older non-GUI enhancement PRs, the owner's PRs and the older open bug PRs. A sixth lane checked all 63 open
issues and scanned all 89 open PRs for supersession by `dev`. Every carry is one squashed commit with the author and a
`Co-authored-by` trailer. The owner's PRs are cherry-picked commit by commit. Integration fixes are separate commits.
Auth, credential, OAuth, workflow and egress changes get an independent Sol security review on the final batch diff before
merge; the finding is recorded on the batch PR, and specifics of any unfixed weakness stay in scratch.

## Wave 1 — bug batches

| Batch | PRs | Integration work |
|---|---|---|
| 9A | #5965, #5963, #5962, #5961, #5959, #5958 | #5961: raise the YAML fixture to 40k blank lines, so its 1s deadline fails on `dev` (3.3s there, 12ms after the fix). |
| 9B | #5969, #5944, #5938, #5935, #5939, #5951, and #5977 (untriaged; the lane decides) | #5938: Windows service behavior needs hosted Windows proof (`workflow_dispatch` if path filters skip it). Three PRs write the layout registries, so their entries are reconciled once. |
| 9C | #5968, #5966, #5933, #5952, #5942, and #5943 or #5976 (same Antigravity 403 retry; the lane picks one and closes the other as superseded) | #5968: a listener-level revocation regression. #5966: a failed-bind and recovery test for `createOptionalListenerSet.start`. #5933: layout registrations. #5952: retry on the first rejected rung. #5942: record `targetRoute.modelId`, add an alias regression, and register the layout. Security review for #5968, #5966, #5933 and the Antigravity retry. |
| 9D | owner #5926 and #5928; maintainer #5911 (supersedes #5915); #5978 (Remote Link pairing dead end, bug) | Owner commits are cherry-picked as is. #5928, #5911 and #5978 touch `gui/`, so the batch PR needs screenshots, reusing the source PRs' images where they exist. Security review for session admission, SSH/link, pairing and OAuth. #5978 is judged alongside #5928, or it is left with a concrete reason. |

## Wave 2 — non-GUI enhancement batches

| Batch | PRs | Integration work |
|---|---|---|
| 10A | #5949 (supersedes #5834; add a `Co-authored-by` for terrytan95), #5884, #5934, #5893, #5829, #4663, #5431 | #5431: document the GJC reasoning export in the guide and keep translations consistent. #5884 needs Windows proof. #5829 adds a workflow, so it needs a workflow security review and a hosted helper run. Security review for #5934 and #5893. |
| 10B | #5954 (supersedes #5708 once fixed; add a `Co-authored-by` for bradhallett), #5919, #5896, #5147, #4740 | #5954: hold and release leases across every physical send and every response-body completion, error and cancel path, and move the case that exceeds the size cap into a registered sibling file. #5896: Windows file-trust check or no auto-load on Windows, and no raw plugin error text in logs. #5147: log only a bounded status or category. #4740: port into `request-log-filter.ts` and keep `protocolMode`. Security review for #5919, #5896 and #5147. |

## Needs the owner (not merged by this goal)

- #5831: may a two-window WHAM response release the 5h lock?
- #5964: accept losing genuine mid-prose MiMo tool calls?
- #5956: is a pause-only slice of #5649 acceptable?
- #5800: Agent SDK harness policy and its new dependency.
- #5912: adopt a new provider with a native-app OAuth callback.
- #5879: needs its ownership and retry redesign first.
- #5980: presents an OpenCode client identity to reach a free tier that its own PR describes as OpenCode-only. This is a
  policy decision and needs the provider evidence in `MAINTAINERS.md`.

## Left open, with reason

- #5927: security blocker on the images pool path; the details are in scratch.
- #5925: its CodeBuddy half already landed in #5945; the direct-MCP half must be split and reviewed.
- #5953: overbroad summary-budget override.
- #5950: the Qoder BYOK format contradicts the vendor's docs.
- #5539: folds `minimal` for OpenAI API-key providers.
- #5497: six conflicts plus config-surface work.
- #5947: 43-file client interception feature.
- #4732, #4228, #4177, #3742, #3741, #3738, #3463, #5099, #5374, #4056: stale, feature-sized, inert or security-bound (see the lane reports).
- #5782: two feature lines, 11 conflicts.
- #4222: an experimental feature.
- Contributor enhancement PRs that change `gui/` are out of scope.
  That includes #5983, a 27-file GUI memory-routing feature, and #5982 stays open with it.

## Closures

- Superseded now: #5733. Its four commits are patch-equivalent to commits on #5947 (`git cherry`), same author. Its head
  is not an ancestor of #5947, so the triage wording was corrected. Closed.
- Superseded once the successor lands: #5915 by #5911, #5834 by #5949, #5708 by the fixed #5954, and #5943 or #5976 by the other.
- Issues: #5880 is fixed on `dev` by #5924 (`f32f9aabd7`) and closes now. After their batches land: #5948 (#5951),
  #5940 (#5943/#5976), #5913 (#5938), #5881 and #5877 (#5911), #5853 (#5893), #5833 (#5949), #5702 (#5954), #5501 (#5944),
  #5096 (#5952), #5146 (#5147). #3376 stays open, because #5949 only adds the activation slice. Each is re-verified on
  `dev` before it closes. #5733 was closed as a duplicate of the still-open #5947; its behavior is not on `dev`.

## Execution

A Sol ultra lane builds each batch in its own `/tmp` worktree. It pushes `codex/bug-train-9x` or `codex/enh-train-10x`
and opens the templated PR. The coordinator runs the independent security review, waits for exact-head CI, merges with
`--match-head-commit`, and closes the carried PRs. Batches that touch the same test-layout registries land one at a
time; a later batch takes `origin/dev` in by a merge commit, never a force-push. After absorbing `dev`, a later batch
reconciles overlapping hunks and reruns the combined focused tests of the files it shares with anything already landed.
Known runtime overlaps:

- Within batches: #5962 and #5958 (a Claude test); #5952 and #5943 (provider docs and registry); 9D's shared
  `structure/gui-and-management-api.md`; #5954 and #5896 (`fetch-helpers.ts`).
- Across batches: #5935 and #5942 (`claude-messages.ts`); #5966 and #5928 (`link-routes.ts`), with #5978 only
  behaviorally related (it changes GUI files alone); #5938 and #5926 (CLI).
