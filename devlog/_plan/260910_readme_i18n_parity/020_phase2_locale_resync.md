# wp3 — locale resync (spec + delegation packet)

## Canonical outline every locale must reproduce

`README.md`, in order. Prose is translated; structure, commands, links and assets are not.

1. `<h3 align="center">make codex open!</h3>` and the two-line tagline.
2. The four shields badges, unchanged except badge `alt` text.
3. `\`\`\`bash` — `npm install -g @bitkyc08/opencodex` / `ocx start`.
4. Hero `<table>`: four rows, each with `### <product>, running any model` and its gif.
   Products: Claude Code, Codex, Claude Desktop, Grok Build. Locale files reference the gifs
   as `../assets/<name>.gif`.
5. Language nav line: English links `../README.md`, the six siblings link `README.<code>.md`,
   the file itself is `<b>...</b>`, and the docs link points at `https://opencodex.me/<docsPath>/`.
6. Intro paragraph: what the proxy translates, which clients, and the ChatGPT account pool.
7. `## Quick start`
   - `### Personal install` — bash fence, `ocx service` note, dashboard paragraph, account-pool
     paragraph including quota routing, thread affinity and the selection-order sentence.
   - `### Sponsors` — the SPONSORS.md pointer, the `<!-- sponsors:main -->` and
     `<!-- sponsors:standard -->` markers verbatim, and the two-row sponsor table. The PackyCode
     row keeps its Simplified Chinese `<sub>` block in every locale.
   - `---`
   - `<details>` Docker Compose, `<details>` install from source (bash + powershell),
     `<details>` for agents (bash + the agent-consent blockquote).
8. `## Supported platforms` — three-row table, Node 18+ paragraph.
9. `## Highlights` — the bullet list including the `<!-- sponsors:main-first-mention -->` marker,
   the provider-policy blockquote, and the memory-ownership `<details>` block.
10. `## Model routing` — bash fence, prefix-omission paragraph.
11. `## Providers & adapters` — the second `<!-- sponsors:main-first-mention -->` marker and the
    provider prose.
12. `## CLI` — bash fence, port note, then `### Health and readiness` (with the exit-code table),
    `### Autostart: service vs shim`, `### Uninstall`.
13. `## Remote access`, `## Documentation`, `## Development`, `## Disclaimer`, `## License`.

## What must be byte-identical

- Every command line inside a `bash`/`powershell` fence. Only the trailing `# comment` is translated.
- Every HTML comment marker, sponsor URL, badge URL and asset filename.
- Every absolute URL except `opencodex.me`, which takes the locale prefix, and except the three
  hero gifs, which locale files reference as `../assets/<name>.gif` instead of the English
  `raw.githubusercontent.com` form.
- Repository links are rewritten one level up, because locale files live in `readme/`:
  `./SPONSORS.md` -> `../SPONSORS.md`, and the same for `./AGENTS_INSTALL.md`, `./docs-site`,
  `./structure`, `./CONTRIBUTING.md`, `./SECURITY.md`, `./CREDITS.md`. A copied `./` link is a
  404 on GitHub.
- Product, provider, model and CLI identifiers: `ocx`, `opencodex`, `Codex`, `Claude Code`,
  `Claude Desktop`, `Grok Build`, `/healthz`, `/readyz`, `x-opencodex-api-key`.

## Delegation packet (one agent per locale)

Model `xai/grok-4.6`, seven agents dispatched in one round, disjoint write sets: agent *N* owns
exactly `readme/README.<code>.md` and nothing else. Each packet carries the full English
`README.md`, this outline, the byte-identical list, the file's existing translation for
terminology continuity, and the locale's `docsPath`.

Standing instruction in every packet: translate for a reader of that language, not word by
word. Keep the English file's register — direct, technical, unhedged. Do not add sections,
do not drop sections, do not add marketing.

## Korean

`README.ko.md` gets the `cxc-kwrite` four-pass revision in the main session after the draft
lands: register consistency end to end, translationese and AI idioms removed
(`~에 대해`, `~를 통해`, `~함으로써`, `결론적으로`, `기대된다`), no `첫째/둘째` enumeration, no stacked
sentence-initial connectives, and concrete endings rather than abstract ones. Meaning stays
frozen: the pass edits detected spans only.

## Integration

Drafts are checked against the wp2 guard, not read for vibes. A locale that fails the token
stream is repaired against the reported index; a locale that fails the command check is
repaired against the English fence. `sourceSha256` is refreshed for all seven only once every
structural check is green.

## Outcome

Five locales — fr, ko, ru, zh-CN, zh-TW — came from the parallel `xai/grok-4.6` round and passed
the guard on their own. The ja and tr agents died mid-run and were finished in the main session.

The delegation had a cost worth recording. Two of the agents wrote their file by passing the
document through a double-quoted `python3 -c` string. The README contains inline code spans such
as `` `ocx service` ``, `` `ocx stop` `` and `` `ocx service uninstall` ``, and inside a
double-quoted shell string a backtick is command substitution — so those commands ran, against the
user's live proxy, repeatedly. A translation task took down a running service four times before
anyone connected the two. Any future agent writing these files must use a file-editing tool, never
a shell string; a quoted heredoc is the only safe shell form, and even that is worse than not
going through a shell at all.

## Documentation anchors are locale-owned

The first draft of this spec said to translate `https://opencodex.me/<path>` by inserting the
locale prefix and otherwise copying the URL. That produced fourteen dead links: Starlight derives
a heading id from the heading text, and the localized pages translate their headings, so
`#docker-compose` exists only on the English Remote Hub page — the French one is
`## Docker, retour arrière et dépannage`, the Korean one is `## Docker`. The locale files now link
the localized page without a fragment, and the guard compares the page rather than the fragment.
