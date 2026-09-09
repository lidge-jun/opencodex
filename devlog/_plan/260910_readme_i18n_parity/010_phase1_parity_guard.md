# wp2 — parity guard (diff level)

## NEW `readme/i18n-manifest.json`

```json
{
  "source": "README.md",
  "note": "sourceSha256 is the LF-normalized SHA-256 of README.md that each locale was last resynced against. Update it in the same commit that resyncs the locale file.",
  "locales": {
    "fr":    { "file": "readme/README.fr.md",    "label": "Français",  "docsPath": "fr",    "sourceSha256": "<sha>" },
    "ko":    { "file": "readme/README.ko.md",    "label": "한국어",     "docsPath": "ko",    "sourceSha256": "<sha>" },
    "zh-CN": { "file": "readme/README.zh-CN.md", "label": "简体中文",   "docsPath": "zh-cn", "sourceSha256": "<sha>" },
    "zh-TW": { "file": "readme/README.zh-TW.md", "label": "繁體中文",   "docsPath": "zh-tw", "sourceSha256": "<sha>" },
    "ru":    { "file": "readme/README.ru.md",    "label": "Русский",   "docsPath": "ru",    "sourceSha256": "<sha>" },
    "ja":    { "file": "readme/README.ja.md",    "label": "日本語",     "docsPath": "ja",    "sourceSha256": "<sha>" },
    "tr":    { "file": "readme/README.tr.md",    "label": "Türkçe",    "docsPath": "tr",    "sourceSha256": "<sha>" }
  }
}
```

`docsPath` matches the Starlight locale directory in `docs-site/astro.config.mjs`
(`fr`, `ko`, `zh-cn`, `zh-tw`, `ru`, `ja`, `tr`), which is what `opencodex.me` serves.
Locale order is the order of the language nav line in `README.md`.

## NEW `tests/ci-workflows/docs-readme-translation-parity.test.ts`

Imports `repoPath` from `../helpers/repo-root`, reads with `node:fs`, hashes with
`node:crypto`. All content is LF-normalized before parsing or hashing, so a CRLF checkout
cannot flip a hash on Windows CI.

### Structural token stream

`tokens(markdown)` walks the file line by line and emits, in order:

| Line shape | Token |
|---|---|
| `## ` heading | `h2` |
| `### ` heading | `h3` |
| `<details>` | `details` |
| `</details>` | `/details` |
| opening fence `\`\`\`lang` | `fence:lang` (bare fence -> `fence:`) |

Heading text is deliberately ignored: it is translated. Fence bodies are skipped so a
`#`-commented shell line is never mistaken for a heading. The English stream is 38 tokens
beginning `fence:bash, h3, h3, h3, h3, h2, h3, fence:bash, h3, details, ...`; each locale
must produce the identical stream, and the failure message prints the first differing index
with both tokens.

### Checks

1. **Registry integrity** — the set of `readme/README.*.md` files on disk equals the manifest
   locale set. A new locale file with no manifest entry fails here, not silently later.
2. **Freshness** — `sha256(README.md)` equals every `sourceSha256`. The failure names the stale
   locales and prints the current hash to paste after resyncing.
3. **Skeleton** — token stream equality against `README.md`.
4. **Commands** — for each `bash`/`powershell` fence, the command part of every line (text
   before an inline ` #` comment, trailing whitespace trimmed) matches the English fence at the
   same index, line for line. Comments stay translatable; commands do not drift.
   A double-quoted argument containing a space collapses to a placeholder first: the three
   example prompts in the model-routing block (`"Explain this stack trace"` and friends) are
   sentences a translator is supposed to translate, and every existing locale already did.
   A quoted argument without a space stays exact, so `"anthropic/claude-opus-5"` is still
   frozen. This was an audit FAIL: without it the guard would have rejected every correct
   translation.
   Non-ASCII content counts as prose on the same footing. Japanese and Chinese do not put
   spaces between words, so the whitespace-only version of this rule read
   `"このスタックトレースを説明して"` as an identifier and demanded it equal the English sentence.
   Every token that must stay frozen in these fences is ASCII, so the widening costs nothing.
   Found by running the guard against the finished Japanese file, not by review.
5. **Assets** — every asset path referenced in `README.md` (`assets/...`, including the raw
   `githubusercontent` forms) appears in each locale by its repository-relative suffix, so
   `assets/demo.gif` and `../assets/demo.gif` both satisfy it.
6. **Sponsor markers** — the ordered list of `<!-- sponsors:<key>` markers matches English, and
   every sponsor destination URL in the English sponsor table appears in each locale.
7. **Doc links** — every `https://opencodex.me/<path>` in English appears in the locale either
   verbatim or with its `docsPath` prefix inserted. Every other absolute URL in English must
   appear verbatim, **except** URLs whose path contains `/assets/`: English serves three hero
   gifs from `raw.githubusercontent.com` while locale files use `../assets/<name>.gif`, so
   asset references are owned by check 5 and excluded here. Trailing markdown punctuation
   (`*`, `.`, `,`, `)`, `]`) is stripped before comparison — English contains
   `http://localhost:10100**` inside a bold span.
9. **Repo-relative links** — every `./<path>` link target in `README.md` (`./SPONSORS.md`,
   `./AGENTS_INSTALL.md`, `./docs-site`, `./structure`, `./CONTRIBUTING.md`, `./SECURITY.md`,
   `./CREDITS.md`) must appear in the locale as `../<path>`. The locale files live one directory
   down, so a copied `./SPONSORS.md` is a 404 on GitHub and nothing else would catch it.
8. **Nav line** — the locale file links `../README.md` for English, links all six sibling
   locales by filename, and marks itself with `<b>`, never as a link to itself.

### Non-vacuity

Each check is driven red once against a mutated in-memory copy before the unit closes, and the
observed failure text is recorded in `030`. A guard nobody has seen fail is a guard nobody
knows works.

## MODIFY `scripts/test-layout/layout.json`

Add to `explicit`, in sorted position among the other `docs-` entries:
`"docs-readme-translation-parity.test.ts": "ci-workflows"`. The `docs-` regex seed for
`ci-workflows` would already place the file, so this entry is belt-and-braces rather than
strictly required; it keeps the file's domain pinned if the seed regex is ever narrowed.

## MODIFY `tests/fixtures/test-layout-expected.json`

Add the same key/value pair in sorted position.
