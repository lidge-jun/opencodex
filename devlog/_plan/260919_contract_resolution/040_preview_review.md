# Integration preview delivery status

Issue #5118 remains open. [Server PR #5185](https://github.com/lidge-jun/opencodex/pull/5185) and [dashboard child #5197](https://github.com/lidge-jun/opencodex/pull/5197) form an ordinary manual chain. The coordinator will close the issue only after both layers satisfy the original acceptance criteria and land on dev.

The runtime owner retains the server, writer, routes, backend tests and API documentation. The existing policy owner owns the dashboard and its tests. Detailed unshipped review findings, hypotheses and correction plans remain in ignored scratch. They will be summarized as outcomes after integration; individual scoped reviews do not establish whole-feature acceptance.

## Server checkpoint

Server head36cdb569544349e174612cf9569ee01eea761afb has scoped source-review evidence and hosted run35466424534. A subsequent bounded correction and regression are in progress. Final-head review, complete applicable hosted execution and ready-for-review publication remain required. Earlier-head results must not be reused as approval for new source.

English and seven translated API references have been reviewed. Their availability wording was corrected to describe conditional recovery rather than promise unconditional readiness. Existing issue scope and acceptance criteria remain unchanged.

## Dashboard checkpoint

The reviewed dashboard corrections preserve explicit confirmation, cancellation, retry state, localization and profile boundaries. Head580f087376409411d9c5557f9bc7b6679777affd passed hosted dashboard gates and React Doctor. Its full matrix exposed an inherited server-base assertion; it did not establish complete stack acceptance. The final child must contain the accepted server head and pass fresh applicable checks before integration.

The hosted artifact from run35462441376, artifact10590256653, identifies build commitbf1bf424f3ebabe977af0dd7b54e3c285baf1769 and GUI treece7f1018aa53203767a665de94d7e6005311f2a8. The GUI tree matches the reviewed dashboard input. No local product build was used.

## Rendered evidence

Main directly inspected eleven real-browser screenshots of the hosted artifact served with isolated fixture responses: apply, foreign overwrite, restore drift and stale reconfirmation at desktop and narrow sizes, two narrow Korean-label captures, and keyboard focus. No visible clipping or overlap was observed in those captures. These are fixture-rendered interface observations, not live-backend execution.

The receipt records desktop1280x720 CSS pixels at DPR2, narrow480x800 at DPR2, and Korean390x686 at DPR2.5. It includes all eleven PNG hashes, fixture routes and request sequences, the scratch fixture-server command, artifact provenance, and keyboard Escape closing the dialog. Main verified hashes and the final commit-pinned image links. Filenames alone were not used to establish viewport measurements.

The [dashboard capture receipt](https://github.com/lidge-jun/opencodex/blob/3d9fffd1be64ff47ca504493e14a7c293dc139e1/.github/pr-assets/5197-capture-receipt.json) is pinned to commit3d9fffd1be64ff47ca504493e14a7c293dc139e1. Artifact identity and current GUI-tree equality must remain valid after the final cascade, or affected evidence must be refreshed.


Pinned capture files (historical artifact, before the final parent cascade):

- [apply-desktop.png](https://github.com/lidge-jun/opencodex/blob/3d9fffd1be64ff47ca504493e14a7c293dc139e1/.github/pr-assets/5197-apply-desktop.png)
- [apply-narrow.png](https://github.com/lidge-jun/opencodex/blob/3d9fffd1be64ff47ca504493e14a7c293dc139e1/.github/pr-assets/5197-apply-narrow.png)
- [keyboard-focus.png](https://github.com/lidge-jun/opencodex/blob/3d9fffd1be64ff47ca504493e14a7c293dc139e1/.github/pr-assets/5197-keyboard-focus.png)
- [ko-restore-drift-390.png](https://github.com/lidge-jun/opencodex/blob/3d9fffd1be64ff47ca504493e14a7c293dc139e1/.github/pr-assets/5197-ko-restore-drift-390.png)
- [ko-stale-reconfirm-390.png](https://github.com/lidge-jun/opencodex/blob/3d9fffd1be64ff47ca504493e14a7c293dc139e1/.github/pr-assets/5197-ko-stale-reconfirm-390.png)
- [overwrite-foreign-desktop.png](https://github.com/lidge-jun/opencodex/blob/3d9fffd1be64ff47ca504493e14a7c293dc139e1/.github/pr-assets/5197-overwrite-foreign-desktop.png)
- [overwrite-foreign-narrow.png](https://github.com/lidge-jun/opencodex/blob/3d9fffd1be64ff47ca504493e14a7c293dc139e1/.github/pr-assets/5197-overwrite-foreign-narrow.png)
- [restore-drift-desktop.png](https://github.com/lidge-jun/opencodex/blob/3d9fffd1be64ff47ca504493e14a7c293dc139e1/.github/pr-assets/5197-restore-drift-desktop.png)
- [restore-drift-narrow.png](https://github.com/lidge-jun/opencodex/blob/3d9fffd1be64ff47ca504493e14a7c293dc139e1/.github/pr-assets/5197-restore-drift-narrow.png)
- [stale-reconfirm-desktop.png](https://github.com/lidge-jun/opencodex/blob/3d9fffd1be64ff47ca504493e14a7c293dc139e1/.github/pr-assets/5197-stale-reconfirm-desktop.png)
- [stale-reconfirm-narrow.png](https://github.com/lidge-jun/opencodex/blob/3d9fffd1be64ff47ca504493e14a7c293dc139e1/.github/pr-assets/5197-stale-reconfirm-narrow.png)

## Remaining delivery

Complete the current server correction and review, run applicable hosted verification on its final head, cascade the dashboard, inspect the combined changes and current-head checks, then integrate bottom-up and verify dev ancestry before closing #5118. Local tests, typecheck, builds, installation and proxy execution remain prohibited.

Publication correction: review of the intermediate progress PR found that detailed unshipped working findings had entered the draft devlog. Those records were preserved in ignored scratch and replaced here with neutral delivery and evidence status. The PR remains subject to renewed review; this correction does not claim prior remote objects were erased.
