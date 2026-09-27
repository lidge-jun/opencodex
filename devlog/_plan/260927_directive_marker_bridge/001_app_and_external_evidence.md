# Evidence: how the Codex App reads visualization references

## App bundle (primary)

Source: `/Applications/ChatGPT.app` (bundle `com.openai.codex`, 26.924.22138), `Contents/Resources/app.asar`
extracted read-only to `.tmp/asar/app`. Paths below are inside `webview/assets/`.

- `app-shared-36eae88777f2.js`, function `f2`: every span matching
  `/U+E200visualize U+E202([^U+E201]+)U+E201/g` outside markdown code tokens is rewritten to
  `::codex-inline-vis{path="<abs>" title="…" mode="wide"}` before rendering. Payload handling:
  - payload starting with `{` is `JSON.parse`d (failure keeps the span); otherwise it is `{path: payload}`;
  - schema `{path: string|null, title?: string, type?: "inline"|"live", mode?: "wide", wide?: boolean}`;
  - `path: null` becomes `::codex-live-vis{}` for `type:"live"` and is otherwise kept;
  - the span is kept when the path has a `..` segment, a double quote or CR/LF, when its basename does
    not match `/^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/`, or when it is not absolute and is either JSON or not a bare basename;
  - attribute is `path` for an absolute path and `file` for a bare basename;
  - `title` is emitted only without quotes or CR/LF; `mode="wide"` only for inline with `mode:"wide"`.
- Same file, function `Err`: a message is a visualization when it contains the private-use form OR the
  literal `::codex-inline-vis`, and parsing `f2(text)` yields a `codexDirective` named
  `codex-inline-vis`. The plain ASCII directive is therefore the app's canonical form.
- Same file, `sj` (absolute path): `/…` but not `//…`, `/^[A-Za-z]:[\\/]/`, `/^\\\\[^\\]+\\[^\\]+/`, `/^\/\/[^/]+\/[^/]+/`.
- `app-primary-cca0c1a58f0f.js`, `i3e`: registers `renderElement` for the inline directive and reads
  its `path` or `file` attribute; `o8e` attaches it whenever `renderInlineVisualizations` is set, which
  `conversation-blocks-1768e325fd75.js` (`qg`) sets for assistant message blocks.
- `app-primary-cca0c1a58f0f.js`, `a3e`: while streaming, a trailing partial `U+E200visualize U+E202` is
  hidden until it closes.

## External sources

| Claim | Source | Status |
|---|---|---|
| OpenAI documents the private-use citation grammar (`U+E200 cite U+E202 … U+E201`) | https://developers.openai.com/api/docs/guides/citation-formatting | primary |
| Claude Code strips BMP private-use characters (U+E000-U+F8FF) from tool input and output; supplementary PUA-A survives | https://github.com/anthropics/claude-code/issues/44525 (2026-04-07) | primary report |
| Same class reported earlier for U+E0A0 | https://github.com/anthropics/claude-code/issues/31849 (2026-03-07) | primary report |
| Streamed citation markers leak into third-party output | https://community.openai.com/t/streamed-web-search-citations-leaking-citation-markers-into-text-output/1390157 (2026-08-12) | lead |
| Codex desktop instructions use plain `::name{…}` directives (`::code-comment`, `::created-thread`) | Codex App system prompt in this session; community reproduction | primary (session) |

Luna lanes: Plato, Ampere, Avicenna (`gpt-5.6-luna`). Aside exec session `boOE2Tp2gdGCg2Do`,
report under `~/.aside/u/0/artifacts/ocx-directive-research/`.

## Conclusion

Converting the private-use reference into `::codex-inline-vis{…}` before the model sees it gives a model
that cannot see private-use characters an ASCII instruction it can read and repeat. The bundle parses that
form directly (`Err`, `f2`); the live render is confirmed in wp3.


## Session observation

A commentary message in this thread that contained `::codex-inline-vis{…}` reached the rollout only as a
`reasoning` summary, not as an assistant `message`, so the user saw plain text. Other commentary blocks
in the same thread show the same pattern. The render test therefore uses a final answer. How routed
Claude text becomes a reasoning item is outside this unit.
