# Delivery

One branch codex/260924-regression-risk-fixes from origin/dev with one commit per fix plus this plan. Local gate: bun run typecheck, bun run structure:check, focused tests for each touched area, test-layout and file-size-ratchet tests. Open one PR to dev with the repository template and merge it immediately with gh pr merge --admin --squash (owner instruction: no PR CI wait). Then dispatch gh workflow run ci.yml --ref dev -F lane=all on the merged tip and require every job completed success; a multi-file timeout is rerun once, a repeat is a defect fixed by another PR merged the same way, followed by a fresh lane=all on the new tip.

