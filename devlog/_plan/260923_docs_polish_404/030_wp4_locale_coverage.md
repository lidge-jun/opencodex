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
