# 010 — WP2: README compact rewrite

Work-phase: `wp2-readme`. Depends on: nothing. Execute as one full PABCD cycle.

## File change map

| Path | Action |
|------|--------|
| `README.md` | MODIFY — full rewrite per `003` target outline |
| `readme/README.{ko,zh-CN,ru,ja}.md` | OUT of this phase (synced in `050`) |

## Content spec (section by section)

1. **Hero** — keep the existing badges row, tagline, and ONE demo block (keep the
   2x2 gif table; drop the mermaid diagram and the inline architecture PNG, which
   duplicate `getting-started/how-it-works`). Keep the language selector line and
   the opencodex.me docs link.
2. **Quick start** — the centerpiece, two explicit paths:
   - *For humans*: `npm install -g @bitkyc08/opencodex` → `ocx start` (or
     `ocx service` for background autostart) → open `http://localhost:10100` and
     add providers/configure in the dashboard. Mention `ocx gui` opens it.
   - *For agents*: `npm install -g @bitkyc08/opencodex` → `ocx start` (or
     `ocx service`) → `ocx init` for interactive setup; note headless commands
     (`ocx provider add`, `ocx combo set`) talk to the live proxy and exit nonzero
     when it is unreachable.
   - *Star prompt notice* (verbatim intent from `003`, 3 sentences): the one-time
     GitHub star prompt can appear on interactive `ocx start` / `ocx service
     install`; agents must never answer it or call the star API — ask the user
     once, act only on explicit yes, never re-ask.
3. **Supported platforms** — keep the 3-OS table + Node 18+/bundled Bun lines.
4. **Supported clients & providers** — one compact paragraph + provider family
   list (Anthropic, Google, xAI, Kimi, Ollama, Groq, OpenRouter, Azure, DeepSeek,
   GLM, OpenAI itself); link to `guides/providers` and `reference/adapters`.
5. **Model routing** — `provider/model` syntax, ONE example, default-provider
   note, combos teaser linking to `guides/combos`. No version-pinned model
   metadata.
6. **Essential CLI** — table of ~10 core commands (`init`, `start`, `stop`,
   `service install|start|stop|status|uninstall|remove` — include `remove`, fixing
   README.md:324, `gui`, `status`, `doctor`, `combo`, `provider`, `account`,
   `v2`); link `reference/cli`.
7. **Autostart** — 3 lines: `ocx service` for always-on, `ocx codex-shim` for
   on-demand; removal commands.
8. **Remote access safety** — the non-loopback-bind-requires-token rule in 2
   sentences + link.
9. **Documentation** — link block only (docs site, `structure/`, `CONTRIBUTING.md`,
   `SECURITY.md` private advisory).
10. **Development** — Bun + `bun install`, `bun run typecheck`, `bun run test`.
11. **Disclaimer / License** — keep as-is.

## Acceptance criteria

- `rg -n "localhost:10100" README.md` hits inside the quick start (human path).
- `rg -n "ocx init" README.md` hits inside the agent path.
- `rg -n "star" README.md` hits the consent note with "ask the user" semantics.
- `wc -l README.md` ≤ 250 (baseline 573).
- `rg -n "service.*remove" README.md` — service synopsis includes `remove`.
- No "v2.7.x" pins, no per-model context-size tables remain.
- All relative links resolve (assets/, readme/, structure/, CONTRIBUTING.md,
  SECURITY.md).

## Verification

`rg` checks above + manual read-through. Docs gates do not read README.md; the
`060` cycle runs repo gates regardless.
