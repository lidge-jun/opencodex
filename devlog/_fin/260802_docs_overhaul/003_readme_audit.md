# 003 — README audit (research, no diffs)

Read-only audit of `README.md` (573 lines, about 4,000 words in headed sections),
branch `dev`, 2026-08-02. Ground truth from `src/cli/**` + `AGENTS.md`.

## Per-section verdicts

| Section | Lines | Verdict |
|---|---|---|
| Intro (unheaded) | 1-82 | compress — keep positioning + install/start + language/docs links + ONE demo block; drop duplicated account-pool prose and one of two diagrams; "Two commands" is inaccurate (init is recommended) |
| Supported platforms | 83-92 | compress — keep 3-OS table + Node 18+ / bundled Bun |
| Quick start | 93-140 | compress — install → init → start; collapse npm recovery details into a docs link; needs the human/agent split and star-prompt note (user requirement) |
| Add a provider | 141-159 | compress — dashboard-first; numbered UI walkthrough moves to docs |
| Model routing | 160-207 | compress — keep `provider/model` + one example + default-provider note; drop volatile effort ladders/model metadata |
| OpenAI provider account modes | 208-235 | move-to-docs-site (providers/configuration own it) |
| Pool account behavior | 236-255 | move-to-docs-site |
| Highlights | 256-273 | compress — 654 words repeating other sections → 5-7 bullets |
| Providers & adapters | 274-305 | compress — protocol families + short sample; matrix lives in docs |
| CLI | 306-327 | compress — core commands + link; FIX: `ocx service` synopsis missing `remove` (README.md:324 vs src/cli/help.ts:46-52) |
| Claude Desktop profile | 328-354 | move-to-docs-site |
| GitHub star prompt | 355-378 | compress — replace 256-word walkthrough with the 3-sentence agent note (below); keep consent boundary |
| Autostart: service vs shim | 379-401 | compress — keep distinction + removal commands |
| Uninstall | 402-413 | compress — fix overclaim "deletes ~/.opencodex" (ownership metadata controls cleanup, src/cli/help.ts:30-43) |
| Configuration | 414-490 | move-to-docs-site (duplicates reference/configuration) |
| Remote access | 491-528 | compress — keep the security rule (non-loopback bind requires token); details to docs |
| Documentation | 529-539 | compress — tight link block (docs site, structure/, CONTRIBUTING, SECURITY/private advisory) |
| Development | 540-564 | compress — Bun + canonical commands only |
| Disclaimer / License | 565-573 | keep-as-is |

## Stale/incorrect findings

1. `ocx service` omits the `remove` alias (README.md:324).
2. "Falls back to a free port if busy" needs qualification: unpinned starts may
   hop; explicit `--port` is hard-pinned and never hops (README.md:310 vs
   src/cli/index.ts:122-164).
3. Uninstall overclaims `~/.opencodex` deletion (README.md:411-412).
4. High-churn model names/context sizes/preview tiers in body text
   (README.md:171-202, 224-230, 259, 267) — replace with stable prose + docs link.
5. No dead links found (all relative targets + external links resolve).

## CLI ground truth for the quick start

- `ocx init` (= `setup`): interactive provider/credential/model selection, port
  prompt defaults 10100, writes `~/.opencodex/config.json`, optionally injects
  Codex config + installs shim; does NOT start the proxy (src/cli/init.ts:101-212;
  src/cli/index.ts:726-731).
- `ocx start`: blocking foreground server; port = `--port` → configured → 10100
  (src/cli/index.ts:122-125,168-226).
- `ocx service`: `install|start|stop|status|uninstall|remove`; bare `ocx service`
  installs/updates and starts the background service (src/cli/help.ts:46-52,
  274-276).
- Default dashboard: `http://localhost:10100`.

## Star-prompt note (text the rewrite must carry, 3 sentences)

> If you are an agent, never answer the GitHub star prompt or call `gh`, GitHub's
> star API, or `POST /api/github/star` on the user's behalf; starring spends the
> user's identity and requires separate explicit consent. In an agent-driven run
> the CLI suppresses the prompt and leaves `.star-prompted` unwritten, while the
> management API returns `403 agent_consent_required` — do not bypass either
> guard. Ask the user once, star only after an explicit yes, and if they say no or
> do not answer, do nothing and never ask again.

## Target outline (compact)

Hero/positioning → Quick start (human path / agent path / star-prompt note) →
Supported platforms → Supported clients & providers → Model routing (minimal) →
Essential CLI → Autostart → Remote-access safety → Documentation → Development →
Disclaimer → License. Target: 250 lines or fewer (baseline 573).

Translated READMEs `readme/README.{ko,zh-CN,ru,ja}.md` mirror the English one;
only the quick-start sections changed by `010` get synced (in `050`).
