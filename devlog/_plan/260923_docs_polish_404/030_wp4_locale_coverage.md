# 030 wp4 — locale coverage

## Missing pages (English source to NEW locale file)

| Page | Missing in |
| --- | --- |
| guides/codex-log-guard-reclaim.md | fr ja ko ru tr zh-cn zh-tw |
| guides/codex-log-guard.md | fr ja ko ru tr zh-cn zh-tw |
| guides/codex-native-context.md | fr ja ru tr zh-cn zh-tw |
| guides/cursor-private-inference.md | fr ja ko ru tr zh-cn zh-tw |
| guides/desktop-app.md | fr ja ko ru tr zh-cn zh-tw |
| guides/factory-droid.md | ja ru tr zh-cn zh-tw |
| guides/integrations.md | ja ko ru zh-cn |
| guides/macos-menu-bar.md | fr tr zh-tw |
| guides/minimax.md | ja ko ru tr zh-cn zh-tw |
| guides/native-main-profiles.md | fr ja ko ru tr zh-cn zh-tw |
| guides/remote-workspace.md | fr ja ko ru tr zh-cn zh-tw |
| guides/response-inspection.md | fr ja ko ru tr zh-cn zh-tw |
| guides/routing-profile-editor.md | ja ko ru zh-cn |
| guides/subagent-v1-default.md | fr ja ko ru tr zh-cn zh-tw |
| reference/inbound-body-admission.md | fr ja ko ru tr zh-cn zh-tw |
| reference/platform-support.md | fr ja ko ru tr zh-cn zh-tw |
| troubleshooting/codex-cannot-sign-in.md | fr ja ko ru tr zh-cn zh-tw |
| troubleshooting/disk-usage-temp-files.md | fr ja ko ru tr zh-cn zh-tw |

Also MODIFY the existing `{ko,ja,zh-cn,ru}/guides/macos-menu-bar.md` to the wp3 English rewrite.

Excluded: `contributing/**` (open PR #5593). #5593 appends a "GitHub Copilot App" section to English
`guides/integrations.md`; the new ja/ko/ru/zh-cn copies will lag it if #5593 lands later. The PR notes this.

## Delegation output contract (DIFFLEVEL-ROADMAP-01 for translated prose)

Translated prose is the build output itself, so this doc fixes inputs and mechanical acceptance instead
of pre-writing ~110 pages. Per NEW file `docs-site/src/content/docs/<locale>/<page>`:

- Source: the English file at the wp4 P revision (after wp3 lands).
- Mechanical parity, checked by main with a scratch script and by the verifier lane: same count and
  levels of headings; identical fenced code blocks byte for byte; same number of Markdown links and
  images; every site link either locale-prefixed or an identical external URL; identical frontmatter
  keys; no paragraph over 80 characters that is byte-identical to an English paragraph.
- Build: Layer A passes with the file present.

## Translation contract (per file)

- Frontmatter `title` and `description` translated; every other frontmatter key identical.
- Headings, prose, table text and alt text translated; code fences, inline code, commands, config keys,
  URLs, file paths, env vars, numbers and product names byte-identical, with one exception: site links
  in prose are rewritten as the next rule says.
- Site links gain the locale prefix (`/guides/x/` to `/<locale>/guides/x/`). A fragment pointing into a
  page that exists in that locale uses that page's translated heading slug; otherwise keep the English
  fragment on the fallback route. The Layer A build check (010) verifies every resulting fragment against
  the rendered ids.
- Relative image paths gain one `../` because the file sits one directory deeper.
- Match the register of existing pages in that locale (read two sibling pages first).

## Sidebar

MODIFY `docs-site/astro.config.mjs`: every slug in the table gets all seven `translations` labels
(missing today on Response Inspection, Factory Droid, Cursor Private Inference, Native Context
Compatibility, and any other slug lacking a full set). Main edits this file alone after the workers
return, using the titles they chose.

## Dispatch

Seven gpt-6-sol workers, one locale each; write scope = the listed files under
`docs-site/src/content/docs/<locale>/` only; read scope = the English sources plus sibling pages in that
locale. Then a separate read-only gpt-6-sol verifier per locale checks structure parity: same heading
count and levels, identical fenced blocks, identical link count, no untranslated English paragraphs.

## Acceptance

- The missing-page scan (every English page outside `contributing/`) prints nothing.
- `cd docs-site && bun run build` exit 0; its Layer A check (010) proves localized links and rendered
  fragments. `docs-link-targets` still passes.
- Commits: one per locale, `docs(<locale>): translate the pages English had and <locale> lacked`, then
  `docs(site): label every sidebar entry in all locales`.

## wp4 P revision (2026-09-23, source pinned at `7b60e10439`)

Re-verified: the missing-page scan over every English page outside `contributing/` prints exactly the
18 rows above (112 copies). English sources are final after wp3; `guides/macos-menu-bar.md` and
`guides/desktop-app.md` changed in wp3, and the wp3 C review requires the four existing
`{ko,ja,zh-cn,ru}/guides/macos-menu-bar.md` to be retranslated before push.

Dispatch: 14 gpt-6-sol workers, two per locale, disjoint write sets:

- Group A (per locale): `guides/{codex-log-guard-reclaim,codex-log-guard,codex-native-context,cursor-private-inference,desktop-app,factory-droid,macos-menu-bar}.md`
  — only the ones missing in that locale, plus a full retranslation of `macos-menu-bar.md` where it exists (ko ja zh-cn ru).
- Group B (per locale): `guides/{integrations,minimax,native-main-profiles,remote-workspace,response-inspection,routing-profile-editor,subagent-v1-default}.md`,
  `reference/{inbound-body-admission,platform-support}.md`, `troubleshooting/{codex-cannot-sign-in,disk-usage-temp-files}.md` — only missing ones.

Workers do not build (one shared `docs-site/dist`); main builds once after all return, runs
`.tmp/trans-parity.ts <locale> <pages…>` (mechanical contract above) and the Layer A build check, and sends
failures back to the same worker. Main then edits `docs-site/astro.config.mjs` alone: each of the 18 slugs
gets all seven `translations` labels equal to that locale file's frontmatter `title`. Existing labels that
already match are left alone.

Reflection (Plato) folds:

- Sidebar `translations` keys are `fr ko "zh-CN" "zh-TW" ru ja tr` (`astro.config.mjs:68-69,77`), not the
  `zh-cn`/`zh-tw` directory names.
- Inbound links: once a translated page replaces English fallback, existing locale pages that link into it
  with an English fragment break. Main repairs those inbound hrefs itself after the first build (Layer A names
  them), under the wp2 ledger rule (hrefs only, link text and count unchanged); workers only fix failures in
  their own files.
- `guides/subagent-v1-default.md`'s relative SVG gains one `../`; root-relative public images keep their paths.

Audit (Volta) folds: .tmp/trans-parity.ts now rejects an empty page list, checks the full 116-copy inventory when run bare, and adds title/description, admonition, table-row and inline-code checks; the verifier lane inspects table cells and admonitions explicitly.

## wp4 outcome (C)

- 14 worker packets; five hit a provider 429 at spawn time (fr A/B, zh-tw A/B, zh-cn B) and were re-dispatched
  unchanged with lower concurrency. Bare `.tmp/trans-parity.ts`: checked 116, failing 0.
- Inbound fix: ja/ko/zh-cn/ru `guides/integrations.md` link the English `/reference/management-api/#aside-profile-controls`;
  their translated management-API pages never gained that section (pre-existing drift, out of scope).
- Seven read-only gpt-6-sol verifiers: ja PASS; fr, ko, ru, tr, zh-cn GO-WITH-FIXES (0 blockers); zh-tw 1 blocker
  ("authenticated" rendered as "verified" in `codex-native-context.md`) fixed. Applied: ru and tr "ad-hoc signing"
  terminology, ru inference-endpoint and catalog sentence, tr grace-period sentence. Rejected by contract: English
  labels inside fenced diagrams and code comments (fr, ko, zh-cn, zh-tw), which stay byte-identical to English.
- Sidebar: 24 labels added from the translated titles. Five pages (codex-log-guard, codex-log-guard-reclaim,
  native-main-profiles, routing-profile-editor, inbound-body-admission) have no sidebar entry; Platform Support uses a
  `link:` entry that already had all seven labels.
