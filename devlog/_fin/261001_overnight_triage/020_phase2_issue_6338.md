# Phase 2 (wp3): #6338

A `gpt-6.1-sol` worker fixes the PUT `/api/subagent-models` validation so documented bare native ids
are accepted in `pickerOrder` while invalid ids are still rejected, with a red-green regression.
An independent reviewer checks the diff. Land as a maintainer PR that says `Closes #6338`, then close
#6338 manually (PRs target `dev`, so GitHub does not auto-close).
