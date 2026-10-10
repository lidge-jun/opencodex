# Phase 010 — done

#6058's routed-model capability editor is on `dev`. It merged through #6105 as `3401e1ee73` from exact head `84be8f48a6`, and the contributor's commit keeps its authorship. #6058 was closed with credit and a summary of what changed on top of it. Post-merge `dev` Cross-platform CI was dispatched as run 36344698221 on `3401e1ee73`.

## Changes after `011_model_settings_evidence.md`

Review on #6105 found real defects that the lane's own audit had missed:

- **Codex review.** Restore left an exact legacy `modelInputModalities` entry in force. The catalog ladder fallback also looked up a bare model ID where routed catalog slugs are `provider/model`. Both are fixed, and each fix has a test that fails without it.
- **CodeRabbit.** A 4xx rejection used to push the dialog into the unknown-outcome state; a rejection writes nothing, so the dialog now stays editable with translated copy. `--modalities ""` normalized to an implicit clear and is now rejected. The Codex catalog warning now names each locale's own "Sync now" button. French copy and the API reference were also completed. The request to cache registry enrichment per provider was declined as a trivial-priority refactor with no correctness effect.
- **React Doctor.** It blocks on any warning, and it flagged `[...values].sort()` in contributor code, now `toSorted()`. Running `npx react-doctor@0.9.11 --scope changed --base origin/dev` in `gui/` before pushing catches this locally.

## What did not go well

- A second local `test:changed` run hit the suite's 900-second cap after waiting 18 minutes for another worktree's test lock. It is recorded as interrupted with 0 failures; CI covered that head.
- `enforce-target` runs on a PR head are routinely superseded by `status`-event runs in the same per-PR concurrency group, so the check on the head shows `cancelled` even though the gate raised no objection. The coordinator's adjusted merge rule replaced repeated rebase-and-wait cycles with a union-tree check. The first rebase under it was still required because #6112 touched both test-layout inventories and the structure doc.
- The unit tests did not catch the dialog menus opening behind the modal; only a real browser click did. Future GUI phases need at least one real-browser pointer pass over every control in a dialog, since keyboard coverage alone would have missed it.

## Next

Phase 020 (#4932) starts from `dev` `3401e1ee73` on branch `codex/t4-gui-ux-combo-sidecar`. The explorer map corrects two claims in `020_combo_sidecar.md`: a missing provider is already rejected by `comboConfigError`, and the request-only field was never persisted under `combos`. It also confirms that writing a text-only declaration is the enrollment mechanism, and that phase 010's editor writes the same axis. Phase 030 (#5617) is deferred because its own acceptance gate fails: there is no migration or rollback from `disabledModels`, and the provider UI still overlaps the account-pool carry #6106.
