# 020 — PR #149 docs reconcile (C2)

Source: wibias/docs/npm-allow-scripts-sudo (3 README files, +55/−10, base main).
Landed overlap: our 9a6e20e6 already covers allow-scripts command + sudo variant
 + package-name warning on the same troubleshooting blocks.

Additive content in #149 worth absorbing (not in ours):

1. Quick-start install comment: "Prefer a user-owned Node (nvm/fnm) — avoid
   sudo npm install -g" (README.md:73 area + ko/zh equivalents).
2. Summary line widened: "bundled Bun runtime is missing / npm blocked Bun
   install scripts?" (better discoverability).
3. Anti-sudo framing: prefer user-owned Node; sudo reinstall is a last resort
   for an existing root prefix ("not recommended — migrate when you can").

Not absorbed: their restructure of the command block (ours already merged with
sudo variant + npm-warning caveat; keeping ours avoids re-churning 9 surfaces —
#149 only touched the 3 READMEs).

Execution: one commit, author Wibias (reconstruction of their additive docs
content adapted onto our landed text), body naming PR #149 + source head.
Surfaces: README.md, README.ko.md, README.zh-CN.md (zh dirty hunk :17x
preserved — edits confined to install/troubleshooting block).

Checks: docs-only; git diff --check; zh-CN staged via hunk isolation if needed.
