# 050 — Phase 5: user-facing docs + hardening

Second work-phase of this unit, appended after the four implementation phases
closed (LOOP-UNIT-CHAIN-01). The feature ships; nothing tells a user it exists.

## Why this phase exists

`ocx export` and the GUI panel landed in `f7ac037e0`. A grep of `docs-site/`
finds:

- `reference/cli.md` — the command table lists `ocx access`, `ocx config`,
  `ocx observe`. There is no `ocx export` row and no subcommand section.
- `guides/opencode.md` — 106 lines about `ocx opencode`. It states "your own
  config is never modified", which is still true, but there is now a supported
  way to GET the block into your own config and the guide does not mention it.
- Pi — no guide, no mention anywhere in the repo.
- BYOK — the term appears nowhere in `src/`, `gui/`, or `docs-site/`.

A feature a user cannot discover is not shipped.

## The BYOK question

The user asked for "byok 같은 곳 설정하는 법". Read against the tree, BYOK here
is not a new subsystem — it is the **credential half** of the export story, and
it spans two different keys that are easy to confuse:

| Key | What it is | Where it goes |
|-----|-----------|---------------|
| Proxy admission (`ocx_…`) | opencodex's own key, generated on the API tab | the exported config's env reference |
| Provider key (`sk-…`, etc.) | your Anthropic/OpenAI/OpenRouter key | `providers.<name>.apiKey` in opencodex config |

The export flow only ever references the FIRST. The second is what "bring your
own key" normally means, is documented in `guides/providers.md` §Auth modes and
`reference/configuration.md` (`apiKey`, `apiKeyPool`, `${ENV_VAR}`), and is NOT
re-documented here — this phase links to it instead of forking a second
explanation that would drift.

What is genuinely missing is the seam: a reader who exports a config has no
page telling them which key the `{env:...}` reference wants, how to generate
it, or that a loopback proxy does not require one at all.

## Scope

IN
- MODIFY `docs-site/src/content/docs/reference/cli.md` — command table row +
  an `ocx export` subcommand section.
- MODIFY `docs-site/src/content/docs/guides/opencode.md` — a section on taking
  the provider block into your own config, pointing at `ocx export`.
- NEW `docs-site/src/content/docs/guides/pi.md` — the Pi guide, including the
  credential seam.
- Locale sync for any translated page whose English source changed, per
  AGENTS.md ("keep translated locales from contradicting the English source").

OUT
- No `src/` or `gui/` behavior change. This phase is docs + whatever hardening
  the docs review exposes, and a code change discovered here becomes its own
  amendment rather than a silent edit.
- No re-documentation of provider auth modes; link to `guides/providers.md`.
- No new BYOK subsystem. BYOK is an existing capability, not a feature to add.

## Hardening review (the docs pass doubles as an adversarial read)

Writing the docs forces every claim to be checked against the shipped code.
Four claims to verify while writing, each a real failure if wrong:

1. **The destination path we print is the one Pi/OpenCode actually reads.**
   `EXPORT_CLIENTS.*.destination` honors `XDG_CONFIG_HOME` for OpenCode.
   Pi's path is still UNVERIFIED against a real install (`001` §2) — the guide
   must say so rather than assert it.
2. **The env var name in the docs matches the one in the emitted config.**
   `OPENCODEX_OPENCODE_API_KEY` for OpenCode, `OPENCODEX_API_KEY` for Pi. Two
   different names; a doc that mixes them sends the reader in a circle.
3. **A loopback-only user needs no key at all.** `shouldInjectApiAuthHeader`
   decides this. If the docs tell every reader to generate a key, most readers
   do unnecessary work; if they tell nobody, non-loopback binds break.
4. **The merge warning is in the docs, not just the CLI.** The download and the
   `--out` refusal both exist because replacing an existing config destroys
   other providers. The docs must carry the same warning.

## Accept criteria

1. `ocx export` appears in the `reference/cli.md` command table AND has a
   subcommand section documenting `--client`, `--json`, `--out`, `--force`.
   **Activation:** grep the built page for `ocx export`.
2. The Pi guide states the exact destination path, the exact env var, and marks
   the Pi schema as unverified against a real install.
3. Every env var name in the new docs matches the string the code emits.
   **Activation:** grep `OPENCODEX_OPENCODE_API_KEY` / `OPENCODEX_API_KEY` in
   both `src/clients/config-export.ts` and the new docs; the sets must agree.
4. The docs state that loopback binds need no admission key, and that a config
   must be merged rather than used to replace an existing file.
5. `bun run privacy:scan` green — the new docs use `~/…`, never a real home path.
6. Docs build passes.
