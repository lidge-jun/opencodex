<h3 align="center">make codex open!</h3>
<p align="center"><b>Universal provider proxy for OpenAI Codex, Claude Code, Claude Desktop &amp; Grok Build</b><br>
Two commands, and every one of them runs any LLM you point it at.</p>

<p align="center">
  <a href="https://x.com/claudeebum"><img src="https://img.shields.io/badge/%40claudeebum-000000?logo=x&logoColor=white" alt="Follow @claudeebum on X"></a>
  <a href="https://www.npmjs.com/package/@bitkyc08/opencodex"><img src="https://img.shields.io/npm/v/@bitkyc08/opencodex?color=cb3837&label=npm&logo=npm" alt="npm version"></a>
  <a href="https://github.com/lidge-jun/opencodex/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@bitkyc08/opencodex?color=blue" alt="license"></a>
  <img src="https://img.shields.io/node/v/@bitkyc08/opencodex?logo=node.js&label=node" alt="node version">
</p>

```bash
npm install -g @bitkyc08/opencodex
ocx start        # proxy + dashboard on localhost:10100
```

<table align="center">
  <tr>
    <td width="50%" align="center">
      <img src="assets/claude-code-models.gif" alt="Claude Code running a routed model through opencodex — the status bar shows gpt-5.6-luna-medium as the active model" width="410"><br>
      <sub><b>Claude Code, running any model.</b><br>The picker is stock Claude Code. The brain behind it isn't.</sub>
    </td>
    <td width="50%" align="center">
      <img src="assets/demo.gif" alt="opencodex demo — running a task in the Codex app on a routed non-OpenAI model" width="410"><br>
      <sub><b>Codex, running any model.</b><br>Pick a provider and go — same workflow, different brain.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="assets/claude-desktop-subagent.gif" alt="Claude Desktop answering as Claude Opus 4.8, then dispatching a GPT-5.6 Sol subagent through opencodex" width="410"><br>
      <sub><b>Claude Desktop, running any model.</b><br>Opus answers, then hands the task to a GPT-5.6 Sol subagent.</sub>
    </td>
    <td width="50%" align="center">
      <img src="assets/grok-build-subagent.gif" alt="Grok Build running GPT-5.6 Sol through opencodex and calling a Kimi K3 subagent" width="410"><br>
      <sub><b>Grok Build, running any model.</b><br>Sol drives the session and calls a Kimi K3 subagent.</sub>
    </td>
  </tr>
</table>

<p align="center">
  <a href="README.md">English</a> · <a href="readme/README.fr.md">Français</a> · <a href="readme/README.ko.md">한국어</a> · <a href="readme/README.zh-CN.md">简体中文</a> · <a href="readme/README.zh-TW.md">繁體中文</a> · <a href="readme/README.ru.md">Русский</a> · <a href="readme/README.ja.md">日本語</a> · <a href="readme/README.tr.md">Türkçe</a> · 📖 <a href="https://opencodex.me/"><b>Full documentation →</b></a>
</p>

opencodex is a lightweight local proxy that translates Codex's Responses API into whatever your
provider speaks — streaming, tool calls, reasoning tokens, images, in both directions. Use Claude,
Gemini, Grok, GLM, DeepSeek, Kimi, Qwen, Ollama, or any other LLM with Codex, Claude Code, Claude
Desktop, and Grok Build. It can also manage a **ChatGPT account pool** for Codex auth: add accounts,
refresh their quotas in the dashboard, and let new sessions auto-route to the lowest-usage healthy
account while existing threads stay pinned to the account that started them.

## Quick start

### For humans

```bash
npm install -g @bitkyc08/opencodex   # Node 18+; the Bun runtime is bundled automatically
ocx start                            # or `ocx service` to run it in the background
```

<details>
<summary>Install from source (latest dev, Bun canary)</summary>

**macOS / Linux:**

```bash
curl -fsSL https://bun.sh/install | bash && ~/.bun/bin/bun upgrade --canary
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex && ~/.bun/bin/bun install
~/.bun/bin/bun run src/cli/index.ts start
```

**Windows (PowerShell):**

```powershell
irm bun.sh/install.ps1 | iex; bun upgrade --canary
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex; bun install
bun run src/cli/index.ts start
```

Source install runs the latest `dev` branch with Bun canary. Memory ownership
patches, runtime GC improvements, and unreleased fixes are available here before
they reach the npm package.

</details>

Open **http://localhost:10100** and configure everything in the web dashboard — add providers
(40+ built-ins, or any OpenAI-compatible endpoint), pick models, manage accounts. `ocx gui`
re-opens the dashboard at any time.
It can also manage a **ChatGPT account pool** for Codex auth. Add multiple ChatGPT / Codex accounts,
refresh their 5h / weekly / 30d quota in the dashboard. Under quota routing, new sessions can use
the lowest-usage healthy account; round-robin and fill-first use their own policies. Existing Codex
threads normally retain affinity to the account that started them, so long SSH, tmux, or
mobile-connected sessions do not jump accounts mid-conversation — but quota re-evaluation, failover,
account exclusion, affinity expiry, or 401/403 and 429 recovery can rebind them. Give the accounts a
selection order when one of them — usually your Codex Desktop login — should only be reached for
once the others are drained.

### For agents

```bash
npm install -g @bitkyc08/opencodex
ocx start     # or `ocx service`
ocx init      # interactive setup: writes ~/.opencodex/config.json and wires Codex
```

`ocx init` never starts the proxy; start it first (or after — either order works, but headless
commands like `ocx provider add` and `ocx combo set` talk to the **live** proxy and exit nonzero
when it is unreachable). `ocx status` / `ocx doctor` / `ocx health` report the running state.

> **Agents installing or running opencodex:** read
> [`AGENTS_INSTALL.md`](./AGENTS_INSTALL.md). An interactive `ocx start` may ask once whether to
> star this repository — that is the user's decision, never an agent's. The CLI suppresses the
> prompt for agent-driven runs and the API refuses them with `403 agent_consent_required`.

## Supported platforms

| OS | Status | Service manager |
|---|---|---|
| macOS (arm64 / x64) | Fully supported | launchd |
| Linux (x64 / arm64) | Fully supported | systemd (user unit) |
| Windows (x64) | Fully supported | Task Scheduler (hidden) / opt-in native service (`--native`, WinSW) |

Requires [Node](https://nodejs.org) 18+. The Bun runtime is bundled on `npm install` — no separate
Bun install needed, no WSL needed on Windows. If npm blocked the bundled runtime's install scripts,
see the [installation docs](https://opencodex.me/getting-started/installation/).

## Highlights

- **Use any LLM with Codex, Claude Code, Claude Desktop, and Grok Build** — 40+ providers out of
  the box, each keeping its own native UI.
- **Pool ChatGPT accounts** — thread affinity, quota-aware auto-switching, cooldown and
  fail-closed auth handling.

  > **Provider-policy note:** Account pooling is for routing and operational resilience only; it does
  > not guarantee protection from provider rate limits, enforcement, suspension, or other account
  > actions. OpenCodex does not endorse using additional accounts to circumvent provider limits or
  > sharing account credentials between people. You are responsible for complying with each
  > provider's current terms. See the
  > [Codex Auth account-pool guidance](https://opencodex.me/guides/web-dashboard/#codex-auth-and-account-pools)
  > and [OpenAI's current Terms of Use](https://openai.com/policies/terms-of-use/).
- **Combos** — one virtual model id with failover or weighted round-robin across providers. See
  the [combo guide](https://opencodex.me/guides/combos/).
- **Sub-agents on any model** — feature routed models in Codex's sub-agent picker, with v1/v2
  surface control and fallback chains. See the
  [sub-agent guide](https://opencodex.me/guides/sub-agent-surface/).
- **Log in once, skip the API key** — OAuth for xAI, Anthropic, and Kimi; or forward
  `codex login`, paste a key, or use `${ENV_VAR}` references.
- **Web search & vision sidecars** — non-OpenAI models get real web search and image understanding
  through a sidecar over your ChatGPT login.
- **See what's happening** — the dashboard shows providers, OAuth status, model selection, and a
  live request log with cache token counts.
- **Clean exit, zero residue** — `ocx stop` restores Codex to its original configuration.
- **Bounded memory ownership** — every long-lived cache, ring buffer, and protocol-translation
  store has a finite cap, byte budget, or active reconciliation. No unbounded `Map` or `Set`
  survives a config reload.

<details>
<summary>Memory ownership details</summary>

OpenCodex tracks 36 categories of process-retained state. Each has a documented bound:

- **12 retained stores** (request log, debug rings, image cache, model cache, vision
  descriptions, cursor blobs, responses continuation, etc.) are byte-accounted and
  evicted by the app-owned memory budget (default 256 MiB).
- **4 observed buffers** (translator accumulators, image/OAuth/Grok tails) are
  monitored for in-flight byte pressure without eviction.
- **24 state-store registrations** handle expiry sweeps (60 s interval) and
  config-generation reconciliation so stale provider/account keys are removed.
- **Path and fingerprint memos** (workspace metadata, hardened identities, installation
  salts, mode-hint capabilities) use insertion-order LRU caps (8–128 entries).
- **Model-cache generation tombstones** are deleted after reconciliation; a global
  generation increment prevents stale in-flight discoveries from repopulating removed
  providers.
- **Lab event-id deduplication** runs under a ledger lock from disk, with no
  process-level RAM index.

Run `GET /api/system/memory` (with the admin token) to inspect live retained bytes,
eviction counters, and watchdog samples.

</details>

## Model routing

Target any configured provider and model with the `provider/model` syntax:

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "google/gemini-3-pro" "Write unit tests for auth.ts"
codex -m "ollama/llama3" "Refactor this function"
```

Omit the `provider/` prefix to use the default provider or auto-match by model name pattern.
Provider model ids containing `/` are exposed with inner slashes aliased to `-`; the raw
full-slash form keeps working too. Details: [model routing docs](https://opencodex.me/guides/model-routing/).

## Providers & adapters

OpenAI (ChatGPT login or API key), Anthropic, Google Gemini, xAI, Kimi, Azure OpenAI, Ollama
(local + Cloud), Cursor (experimental), and every OpenAI-compatible endpoint — plus DeepSeek,
Groq, OpenRouter, Together, Fireworks, Cerebras, Mistral, Hugging Face, NVIDIA NIM, MiniMax,
Qwen Cloud, SiliconFlow, and more. Full list: `ocx init` or the
[provider docs](https://opencodex.me/guides/providers/).

## CLI

```bash
ocx init                       # interactive setup (writes config, wires Codex, offers the shim)
ocx start [--port 10100]       # start the proxy in the foreground
ocx stop                       # stop + restore native Codex
ocx service [install|start|stop|status|uninstall|remove]  # background service
ocx codex-shim install         # start the proxy on demand whenever `codex` launches
ocx health [--json]            # check immediate proxy liveness
ocx ready [--json] [--wait [--timeout <seconds>]]  # check post-sync readiness
ocx status                     # is the proxy running?
ocx gui                        # open the web dashboard
ocx provider <...>             # manage providers (list/add/edit/test/remove)
ocx account <...>              # manage ChatGPT accounts & API-key pools
ocx combo <...>                # manage failover / round-robin combos
ocx v2 <...>                   # multi-agent v1/v2 surface controls
ocx update [--tag preview]     # update opencodex
```

Unpinned starts may pick another free port if the preferred one is busy; an explicit `--port`
never hops. Full reference: [CLI docs](https://opencodex.me/reference/cli/).

### Health and readiness

`GET /healthz` reports immediate proxy liveness. The unauthenticated `GET /readyz` endpoint reports
post-sync readiness with the sanitized JSON identity `{service, version, uptime, pid, port, status}`.
It returns `200` when `status` is `ready`; `pending` and terminal `failed` return `503` with
`Retry-After: 1`.

`ocx ready [--json] [--wait [--timeout <seconds>]]` performs one probe by default. `--wait` polls
for up to 45 seconds by default, but exits immediately when it observes terminal `failed`;
`--timeout <seconds>` sets a 1–300 second limit, requires `--wait`, and accepts only positive integers. CLI `--json` output is
`{ready, status, pid, port}`, where `status` is `ready`, `pending`, `failed`, or `unreachable`.

| Exit | Result |
| --- | --- |
| `0` | Ready |
| `1` | Not ready: pending, failed, timeout, or unreachable |
| `64` | Invalid arguments |

An older proxy without `/readyz` fails closed as `unreachable` with exit 1, while `ocx health`
remains compatible.

### Autostart: service vs shim

Use the **service** (`ocx service`) for an always-on proxy that restarts on crash. Use the
**shim** (`ocx codex-shim install`) for lightweight, on-demand startup without a background
daemon. Remove them with `ocx service uninstall` / `ocx codex-shim uninstall`.

### Uninstall

```bash
ocx uninstall                  # stop, remove service/shim, restore native Codex, clean up state
npm uninstall -g @bitkyc08/opencodex
```

## Remote access

By default opencodex binds to `127.0.0.1` and needs no extra authentication. Binding beyond
loopback (`"hostname": "0.0.0.0"`) **requires** a bearer token — the proxy refuses to start
without `OPENCODEX_API_AUTH_TOKEN`, and every client request must carry it as
`x-opencodex-api-key`. Details: [configuration reference](https://opencodex.me/reference/configuration/).

## Documentation

The public docs — install, providers, routing, combos, sub-agents, sidecars, integrations, and
the CLI/config/management-API references — are built from [`docs-site/`](./docs-site) and
published to **[opencodex.me](https://opencodex.me/)**.

Maintainer source-of-truth notes live under [`structure/`](./structure), contributor setup in
[`CONTRIBUTING.md`](./CONTRIBUTING.md), and security reporting in [`SECURITY.md`](./SECURITY.md).
Report undisclosed vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/lidge-jun/opencodex/security/advisories/new),
not a public issue.

## Development

Source development requires the `bun` CLI on your `PATH`. This is separate from the published npm
package's bundled Bun runtime, which is used only by installed `ocx` commands.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run typecheck
bun run test
```

See **[Contributing](./CONTRIBUTING.md)**.

## Disclaimer

opencodex is an independent, community-maintained project and is **not affiliated with or endorsed by OpenAI, Anthropic, or any other provider**.

Some providers — notably Anthropic (Claude) — may suspend or restrict accounts that route API traffic through third-party proxies. **Use at your own risk (UAYOR).** Before connecting a provider, review its Terms of Service to confirm that proxy-based access is permitted. The opencodex maintainers are not responsible for any account actions taken by upstream providers.

## License

MIT
