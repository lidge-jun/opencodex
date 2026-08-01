# 010 — #146 install-guidance corrections (docs + hint strings)

Base: current local `dev` (provider-workspace lane HEAD). All edits additive/
string-level; no lifecycle or code-path changes.

## Canonical recovery block (English)

```bash
# preferred: user-owned npm prefix (nvm/volta/fnm or npm prefix in $HOME)
npm install -g --allow-scripts=bun @bitkyc08/opencodex

# if the original install was made with sudo into a system prefix
sudo npm install -g --allow-scripts=bun @bitkyc08/opencodex
```

Rationale to state in each troubleshooting section: recent npm (`--allow-scripts`
exists as of npm 11.18; absent in 11.5 — verified against npm/cli sources) may
block bun's postinstall under `allowScripts`; its abbreviated warning
(`npm install -g --allow-scripts=bun`) omits the package argument and would
reinstall the current directory — always pass `@bitkyc08/opencodex` explicitly,
and match `sudo` to however the package was originally installed.

Note on the grep gate: prose that intentionally QUOTES npm's abbreviated warning
(to explain why it is wrong) is exempt; the gate applies to every command we
RECOMMEND. Concretely: recommended command lines must match
`--allow-scripts=bun @bitkyc08/opencodex`; the quoted-warning mention appears
only inside explanatory prose, never in a fenced command block.

## MODIFY [README.md](../../../README.md)

- `~:97-100` troubleshooting `<details>`: extend cause sentence to "skipped
  lifecycle scripts (including npm's `allowScripts` blocking of bun's
  postinstall) or optional dependencies", replace the single command with the
  canonical two-command block, keep the `# no --ignore-scripts, no
  --omit=optional` comment on the first command.

## MODIFY [README.ko.md](../../../README.ko.md) `~:94-98`, [README.zh-CN.md](../../../README.zh-CN.md) `~:90-94`

- Same change, natural ko/zh phrasing (ko: npm이 bun postinstall을 `allowScripts`로
  차단한 경우 포함; sudo로 설치했던 prefix면 sudo로 재설치). zh-CN README carries
  uncommitted user edits — verify hunk locality before patching; if the edited
  region overlaps, patch around it without reverting user content.

## MODIFY docs-site installation.md (en `:21` area, ko `:21`, zh-cn `:21`)

- After the `npm install -g @bitkyc08/opencodex` block, add a short
  "npm blocked the bun postinstall?" aside (Starlight `:::note` or plain
  paragraph, match file's existing style) with the canonical two-command block.

## MODIFY [scripts/install.sh](../../../scripts/install.sh) `~:24-26`

- Comment only: note that if npm reports `install scripts blocked` for bun,
  rerun as `npm install -g --allow-scripts=bun @bitkyc08/opencodex` with the
  same sudo-ness as the original install. The comment states the FULL command
  (grep-gate compliant); script behavior unchanged — it does not pass the flag
  by default.

## MODIFY [scripts/install.ps1](../../../scripts/install.ps1) `~:25`

- Same comment-only change as install.sh, with the full command text (Windows
  npm installer is the symmetric 9th surface; no sudo variant — mention
  elevated PowerShell instead where the original install was elevated). Check
  `tests/install-scripts.test.ts` for assertions pinning either script's
  content and update in the same commit if the comment text is covered.

## MODIFY [bin/ocx.mjs](../../../bin/ocx.mjs) `fail()` `~:190-198`

- Extend hint string:

```text
  npm install -g --allow-scripts=bun @bitkyc08/opencodex
(use sudo if the original install used sudo; without --ignore-scripts and
without --omit=optional / optional=false)
```

## Checks

- `rg -n "allow-scripts" README*.md docs-site scripts bin` → every hit carries
  the full package argument, except explanatory prose quoting npm's warning
  (see grep-gate note above).
- `node --check bin/ocx.mjs` (tsconfig only includes `src/`, so tsc does not
  cover the launcher; syntax-check it directly).
- `bun x tsc --noEmit` for overall repo health (unchanged surface).
- Docs gate: docs-site build (`cd docs-site && npm run build` or the repo's
  existing docs build script) — `bun run docs:check` does not exist.
- `rg -n "allow-scripts" tests/` → update any test pinning the fail() text
  (`tests/install-scripts.test.ts` and any launcher-hint tests) and run them:
  `bun test --isolate tests/install-scripts.test.ts`.
- Rollback: single revert commit; no state migration.
