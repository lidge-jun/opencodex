# 260718 — Issue #146 / #92 docs-first fix unit

## Objective

Close out the two "actionable-now" findings from the 2026-07-18 Sol review sweep
(4 parallel gpt-5.6-sol high reviewers, read-only):

- **#146**: Ubuntu global install — npm blocks bun postinstall; the npm-suggested
  recovery command is wrong for sudo-installed prefixes. Fix is docs/install-hint
  only (no lifecycle-script change).
- **#92**: V2 cross-provider sub-agent loses NEW_TASK body (Fernet
  `encrypted_content`). Root cause is client/runtime-side (native parent encrypts
  the spawn message for a non-native child; proxy cannot decrypt). Short-term fix
  is docs truth-alignment: stop claiming cross-model v2 spawns "actually stick"
  unconditionally.

## Constraints / boundaries

- IN: README (en/ko/zh), docs-site installation.md (en/ko/zh-cn),
  docs-site sub-agent-surface.md (en/ko/zh-cn), `scripts/install.sh` and
  `scripts/install.ps1` comments, `bin/ocx.mjs` fail() hint string
  (9 install surfaces total; see 010 for the authoritative list).
- OUT (decision cards, not this unit): posting GitHub comments on #146/#92/#145/#147,
  filing the upstream openai/codex issue for #92, any code change to install
  lifecycle, any #147/#145 rebuild work.
- No push without explicit approval (DEV-GIT-PUSH-01). Local commits only.
- Preserve unrelated dirty work: `README.zh-CN.md` has uncommitted user edits and
  local dev is ahead of origin/dev (provider workspace lane; count drifts as that
  lane continues). Do not touch those hunks; rebase-safe additive edits only.

## Evidence base (from Sol reviewers, 2026-07-18)

- #146 root cause: `package.json` deps `bun@1.3.14`; bun's `postinstall: node install.js`
  replaces a placeholder binary; `bin/ocx.mjs` lazy retry cannot write a root-owned
  global prefix. Correct commands (npm 11.18 dry-run verified):
  - `npm install -g --allow-scripts=bun @bitkyc08/opencodex` (user-owned prefix)
  - `sudo npm install -g --allow-scripts=bun @bitkyc08/opencodex` (sudo-installed prefix)
  - npm's own warning omits the package argument, which reinstalls the CWD — never
    echo npm's abbreviated suggestion verbatim.
- #92 reproduction on dev HEAD: routed child receives
  `Message Type: NEW_TASK\nPayload:\n` + intact Fernet block; `rewritten: 0`.
  PR #94 covered plaintext-in-encrypted-slot only. Fix requires the Codex
  client/runtime to keep plaintext for non-native children — not fixable proxy-side
  without intercepting parent SSE spawn args (rejected here; security/architecture
  decision).

## Work-phase map (dependency-ordered)

| Phase | Doc | Scope | Depends |
|-------|-----|-------|---------|
| 010 | `010_issue146_install_docs.md` | #146 install-guidance corrections across 9 surfaces | — |
| 020 | `020_issue92_docs_truth_alignment.md` | #92 docs claim softening (README ×3, sub-agent-surface ×3) + upstream-issue draft text (file-only artifact) | — |

Phases are independent; 010 runs first (smaller, releases the actionable-now item).
One work-phase = one full PABCD cycle.

## Accept criteria

- AC-1: every install surface (README.md/ko/zh-CN §install + troubleshooting,
  docs-site installation.md en/ko/zh-cn, scripts/install.sh, scripts/install.ps1,
  bin/ocx.mjs fail hint) names `--allow-scripts=bun` with the full package
  argument, covering both non-sudo and sudo recovery. Grep gate per 010: every
  RECOMMENDED command carries the package argument; explanatory prose quoting
  npm's abbreviated warning is exempt.
- AC-2: `node --check bin/ocx.mjs` clean (tsc does not cover bin/); focused
  install tests (`tests/install-scripts.test.ts` and any hint-pinning tests)
  pass; `bun x tsc --noEmit` clean for overall repo health.
- AC-3: README ×3 + sub-agent-surface ×3 no longer state unconditional cross-model
  v2 spawn success; each names the known limitation (native parent → routed child
  NEW_TASK ciphertext, issue #92) and points at v1 as the reliable heterogeneous
  surface. Locale parity across en/ko/zh.
- AC-4: `020` doc contains a ready-to-file upstream issue draft (English) with the
  dev-HEAD reproduction evidence; filing itself stays a decision card.

## Decision cards (user, not agent)

- DC-1 (#147): merge value verdict was NEEDS CHANGES (P0 token leak + 5×P1) and
  58 commits behind dev with router/responses conflicts. Options: (a) request
  changes to Wibias and wait, (b) rebuild as small stack on dev ourselves
  (139/140-style, authorship preserved), (c) decline feature. Not started until
  decided.
- DC-2 (#145): NEEDS CHANGES (3×P2 precedence defects). Options: (a) request
  changes, (b) absorb: re-land the 403 relabel correctly on dev ourselves (~small),
  (c) merge as-is and fix after (not recommended — introduces 401→403 misclass).
- DC-3 (#92 upstream): file the issue on openai/codex once draft is approved.
- DC-4 (review comments): post the four Sol review verdicts as PR/issue comments.
- DC-5 (#144 draft): product placement (docs-site vs GUI lazy-load) — feedback to
  Wibias only, no local work planned.
