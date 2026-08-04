# 050 — WP6: locale sync (ko / ja / ru / zh-cn)

Work-phase: `wp6-locale-sync`. Depends on: `030`, `040` (English must be settled
first). Execute as one full PABCD cycle; four locale lanes (sol/medium), max 3
concurrent — run ko+ja+ru, then zh-cn, or two rounds of two.

## File change map (per locale L ∈ {ko, ja, ru, zh-cn})

| Path | Action |
|------|--------|
| `docs-site/src/content/docs/L/getting-started/for-agents.md` | NEW (translate) |
| `docs-site/src/content/docs/L/guides/combos.md` | NEW (translate) |
| `docs-site/src/content/docs/L/reference/proxy-formats.md` | NEW (translate) |
| `docs-site/src/content/docs/L/reference/management-api.md` | NEW (translate) |
| `docs-site/src/content/docs/L/reference/configuration.md` + 4 subpages | NEW/MODIFY (mirror the split) |
| `docs-site/src/content/docs/L/reference/cli.md` + 3 subpages | NEW/MODIFY (mirror the split) |
| `docs-site/src/content/docs/L/guides/sub-agent-surface.md` | MODIFY (mirror restructure) |
| `docs-site/src/content/docs/L/guides/codex-integration.md`, `.../codex-app-models.md` | MODIFY (mirror dedupe) |
| `docs-site/src/content/docs/L/getting-started/quickstart.md` | MODIFY (mirror pin refresh) |
| `docs-site/src/content/docs/L/guides/{grok-build,image-bridge,opencode,pi,video-bridge}.md` | NEW (translate the 5 missing guides) |
| `docs-site/src/content/docs/L/troubleshooting/windows-memory.md` | NEW (translate) |
| `readme/README.{ko,zh-CN,ru,ja}.md` | MODIFY — sync only the quick-start sections changed in `010` (human/agent/star note) |
| `docs-site/src/data/README-frontier.md` | MODIFY — three locales → five locales |

## Translation rules

- English is canonical; translations must not contradict it
  (`docs-site/AGENTS.md`). Code blocks, commands, config keys, endpoint paths,
  error codes, and model names stay untranslated.
- Keep each page's frontmatter `title`/`description` translated; keep anchors and
  internal links site-relative so they resolve inside the locale tree.
- Sidebar `translations` labels for every new entry were added in `020`/`030`/
  `040`; verify they render in each locale.
- Do not translate `devlog/` or repo-internal docs.

## Acceptance criteria

- For each locale: every English page under `docs-site/src/content/docs/` has a
  same-path counterpart in the locale tree (diff the two file lists).
- `cd docs-site && bun run build` exit 0; localized routes built (route list
  shows `/ko/guides/combos/` etc.).
- No locale page contains untranslated English body prose outside code/technical
  terms (spot-check 2 pages per locale).
- `rg -n "three locales|en/ko/zh-cn" docs-site/src/data/README-frontier.md` →
  fixed to five locales.

## Verification

Fresh docs build + file-list diff per locale + spot reads.
