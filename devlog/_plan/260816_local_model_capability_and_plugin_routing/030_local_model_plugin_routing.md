# 030 — Phase 3: durable browser-plugin routing guidance for local models

Diff-level implementation doc. Research: `002_local_model_plugin_failure.md`.
No dependency on Phases 1-2; it may land in any order.

> **Superseded placement (review correction).** This document originally
> selected `~/.codex/AGENTS.md`. That was wrong: an untracked host file cannot
> ship with the package or be reproduced from a clone, so it is not a
> deliverable. The guidance now lives in the tracked `AGENTS_INSTALL.md`,
> which `package.json` publishes and which `AGENTS.md` and `README.md` both
> point an installing or operating agent at. Every mention of the host path
> below is historical; treat `AGENTS_INSTALL.md` as the placement decision.
> The host copy remains only as local convenience and host-only verification.

## Goal

A weaker local model asked to browse should reach `mcp__node_repl__js` on its
first attempt instead of exhausting `osascript`, `find`, and a hand-written
Node script before declaring the tooling unavailable.

## The constraint that makes this a docs problem

Nothing in `src/` participates. The failure is host-side tool routing:

```console
$ node -e "import('.../chrome/scripts/browser-client.mjs').then(m => m.setupBrowserRuntime())"
RUNTIME FAIL: Browser use requires privileged node_repl capabilities
```

The bundle reads `globalThis.nodeRepl` and ships its own `process` shim, so
the privileged REPL tool is the only working host. Computer Use's `@oai/sky`
has no on-disk package at all. There is no code change that can make a shell
path work, and inventing one would be a fork of the plugin.

## Scope boundary

IN: a durable guidance surface a local model reads before acting.
OUT: editing the bundled plugin skills under
`~/.codex/plugins/cache/openai-bundled/` (vendor-owned, replaced on update),
any change to `src/`, and any claim that this is enforced.

## Placement decision

Candidates considered:

| Candidate | Verdict |
|-----------|---------|
| Bundled plugin `SKILL.md` | REJECTED — vendor-owned, overwritten on plugin update |
| Repository `AGENTS.md` | REJECTED — this is host tooling, not opencodex development guidance; loaded for every code change where it is noise |
| `~/.codex/AGENTS.md` (global) | SUPERSEDED — host-only, untracked, cannot ship or be reproduced from a clone |
| `AGENTS_INSTALL.md` (tracked, published) | **CHOSEN** — the file an installing or operating agent reads; shipped in the package |

Verified: `/Users/jun/.codex/AGENTS.md` exists and is 0 bytes, so the guidance
is additive with no merge risk.

## File change map

| Path | Action | What |
|------|--------|------|
| `AGENTS_INSTALL.md` | MODIFY (append) | Browser-plugin routing rule |

## Content to append

```markdown
## Browser and Computer Use plugins: entry point

The Chrome, Browser, and Computer Use plugins run ONLY through the
`mcp__node_repl__js` tool. Call it directly; if it is not listed, search the
available tools for `node_repl js` before concluding anything is unavailable.

These do not work and are not worth attempting:

- `node` / `node -e` importing `scripts/browser-client.mjs` — refuses with
  "Browser use requires privileged node_repl capabilities".
- Filesystem searches for `@oai/sky` — it is injected at runtime, never on disk.
- `osascript` / AppleScript / JXA as a substitute for the plugin API.

A failed shell attempt is evidence about the shell, not about plugin
availability.
```

## Accept criteria

1. The section is present in the tracked `AGENTS_INSTALL.md`.
2. The wording names the tool explicitly — the bundled skill's own instruction
   to avoid naming `node_repl` in user-facing prose is what confuses a weaker
   model, so this internal-guidance surface deliberately names it.
3. No claim of enforcement appears in the text.

## Verifier commands (PLAN-VERIFIER-REAL-01)

| Command | Reads this change? | Notes |
|---------|-------------------|-------|
| `cat ~/.codex/AGENTS.md` | Partially — proves bytes on disk, NOT that Codex loaded them | Human-read acceptance |
| `REPO=$(git rev-parse --show-toplevel); OCX_SHIM_BYPASS=1 codex -C "$REPO" debug prompt-input \| rg "mcp__node_repl__js"` | YES — renders the instructions the model actually receives | Round 7 note: the earlier form wrote `<repo>`, which a shell reads as input redirection (`no such file or directory: repo`), so it was never runnable as printed. Proven in audit round 2: an isolated `$CODEX_HOME/AGENTS.md` carrying this guidance appeared in the prompt, exit 0. No network needed |

Discovery caveats verified during audit (B7): global guidance resolves from
`$CODEX_HOME` when set (currently unset, so `~/.codex` applies), and
`AGENTS.override.md` takes precedence over `AGENTS.md` (currently absent).
The acceptance claim is therefore scoped to the default Codex home on this
host, and is human-verified rather than gated.

There is no repository gate for this change: `tsc`, `bun test`, and
`privacy:scan` never read `~/.codex/AGENTS.md`. This acceptance row is human
review, stated per PLAN-VERIFIER-REAL-01 rather than dressed up as a gate.

## Bypass record (PLAN-BYPASS-NAMED-01)

Tier: E1 (guidance). Executing surface: the model reading its instruction
file. Known bypass: a model may ignore instructions entirely — this is the
exact failure being addressed, so the mechanism cannot be self-guaranteeing.
Residual risk: guidance reduces but does not eliminate misrouting. Wording
downgrade: YES — this is an early warning, never enforcement. Final
enforcement layer: none.
