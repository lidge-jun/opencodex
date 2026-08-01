# 260722 repo governance config — plan (P)

## Objective

Land repository-level governance/config artifacts on `main` (then sync to `dev`) so both
CodeRabbit (installed 2026-07-22) and Codex-style agents review PRs with the project's real
rules: dev-branch-first flow, `claudedesktop` in-development status, security-boundary
review requirements.

Scope split (audit blocker #2): PR lane = CodeRabbit review + Codex Cloud code review.
Issue lane = CodeRabbit issue enrichment + planning (NOT "code review"; Codex has no
issue-review product surface, so Codex-on-issues is out of scope).
English/detail guarantee applies to PR reviews (language + tone_instructions + profile);
issue outputs are validated empirically post-merge with a test issue.

## Deliverables

1. `.coderabbit.yaml` (new, repo root)
   - `language: en-US` — reviews always in English (user amendment 2026-07-22).
   - `reviews.profile: assertive` — most feedback-heavy profile (schema enum
     quiet|chill|assertive; schema wording is "more feedback", not a completeness
     guarantee — detail is driven by profile + tone_instructions + path instructions
     together).
   - `tone_instructions` (top-level string): demand very detailed, specific,
     evidence-backed findings in English. Max 250 chars per schema.
   - `reviews.auto_review.enabled: true`, `drafts: false`,
     `base_branches: ["^dev$", "^preview$"]` (regex-anchored; default branch `main`
     is auto-included by CodeRabbit, so it is not listed).
   - Path instructions: `src/**` (Bun-native TS, no Node-only APIs), `tests/**`,
     `gui/**`, `.github/**` + `scripts/release.ts` (security boundary), `docs-site/**`.
   - Issue lane (YAML is the single source of truth; no separate dashboard step):

     ```yaml
     issue_enrichment:
       auto_enrich:
         enabled: true
       planning:
         enabled: true
         auto_planning:
           enabled: true
           labels:
             - plan-me
     ```

     Manual trigger stays `@coderabbitai plan` on any issue.
2. `AGENTS.md` (new, repo root)
   - Written in English (review agents consume it; reviews are English).
   - Repo orientation: what opencodex is, layout map (src/tests/gui/docs-site/structure).
   - Branch policy: PRs target `dev`; `main` is release-promoted; `preview` is the
     prerelease lane; `claudedesktop` is an ongoing in-development branch whose
     changes may be PARTIALLY integrated into `dev` already (418d29b1 merged an
     earlier snapshot); remaining commits are maintainer-controlled — do not treat
     its divergence as a bug and do not merge it without maintainer action.
   - Commands: `bun run typecheck`, `bun run test`, `bun run privacy:scan`, `bun run lint:gui`.
   - `## Review guidelines` (exact heading — this is the section name Codex GitHub
     code review consumes): reviews in English, detailed and evidence-backed;
     security-boundary list (auth, credential handling, GitHub Actions, release
     automation, dependency install) requiring explicit security review;
     test-coverage expectations; devlog/structure conventions. Note: Codex reviews
     are P0/P1-focused by design; guidelines steer focus, they do not force
     low-priority nitpick volume.
   - AGENTS.md summarizes but never redefines merge policy: add an explicit
     "MAINTAINERS.md is authoritative for review/merge policy" pointer; do not
     restate approval counts or merge permissions.
3. `CONTRIBUTING.md` (edit, minimal)
   - Add a short "Branches" section: `dev` = integration target for all normal PRs,
     `main` = releases only, `preview` = prerelease train, `claudedesktop` = WIP.
   - Keep the pointer-style doc; do not duplicate the hosted guide.
4. Codex Cloud review enablement (post-merge, web UI)
   - Codex settings -> repository `lidge-jun/opencodex` -> enable **Code review**
     and **Automatic reviews**; manual trigger stays `@codex review`.

## Landing strategy

- Work on a `codex/repo-governance-config` branch off `main`; commit; push; merge to
  `main` (fast, config-only, no runtime code). Then bring the same files to `dev`
  via `git merge main` into dev ONLY (no cherry-pick — duplicate commits would
  create friction at the next dev->main promotion). This main-first landing is an
  explicit governance exception to the normal dev->main promotion flow; record it
  in the commit/PR description.
- User instruction "main에 설정해놔" = explicit approval to land on main and push.

## Out of scope

- No runtime/src changes, no workflow changes, no release.
- No rewrite of docs-site contributing guide.

## Verification (C)

- Schema validation: validate `.coderabbit.yaml` against
  https://storage.googleapis.com/coderabbit_public_assets/schema.v2.json (not just
  YAML syntax parse).
- `git diff --stat` limited to the three files.
- Files render on GitHub after push (spot check).
- Post-merge smoke tests (D notes / follow-up): CodeRabbit auto-review on a
  non-draft PR targeting dev; `@coderabbitai review` manual trigger; `plan-me`
  labeled test issue produces English enrichment/plan; `@codex review` works after
  enabling Code review in Codex settings; both services reflect AGENTS.md security
  rules.

## Risks

- `.coderabbit.yaml` schema drift → validate keys against current CodeRabbit docs
  during build; keep config minimal to stay schema-safe.
- CONTRIBUTING.md divergence from hosted docs-site guide → keep the section short and
  pointer-first.
