# 020 — Layer 2: docs guide "Cursor Private Inference" + stack publish

Branch: `codex/cursor-private-inference-guide` (base: `codex/cursor-local-models-schema`).
PR 2 of the stack, targets the layer-1 branch; retarget to `dev` after PR 1 lands.
Thesis: a connector guide so a user who already has the Private Inference build can point it
at OpenCodex on macOS, Windows and Linux, and understand the limits.

## File change map

| Path | Action |
|---|---|
| `docs-site/src/content/docs/guides/cursor-private-inference.md` | NEW |
| `docs-site/src/content/docs/guides/integrations.md` | MODIFY — add a short "Cursor Private Inference" pointer paragraph after the Aside paragraph (this client is configured inside Cursor, not by the Integrations tab; say so). |
| `docs-site/astro.config.mjs` | MODIFY — the Guides sidebar is an explicit list (L84-92); add `{ label: "Cursor Private Inference", slug: "guides/cursor-private-inference" }` after the Factory Droid Bridge entry (label translations optional; ko: "Cursor Private Inference"). |

Scope OUT: locales (fr/ja/ko/ru/tr/zh-*); they must not contradict, and absence is fine.

## Guide content (diff-level outline; final prose written at B)

Front matter: `title: Cursor Private Inference`, `description: Use OpenCodex-routed models inside Cursor's local-agent build without a tunnel.`

Sections, in order:

1. **What this is.** Cursor ships a second desktop build, "Cursor Private Inference", whose
   agent runs locally and calls an OpenAI-compatible gateway you configure. Regular Cursor
   cannot do this: its backend calls your endpoint, so loopback and LAN URLs are rejected and
   a public HTTPS tunnel is required (link the existing tunnel note in `reference/cli.md`).
   The Private Inference build is not documented by Cursor, may change or disappear, and
   OpenCodex does not distribute it — no download link. If you do not have it, use the
   community bridge (`npx ocx-cursor`) with a tunnel instead.
2. **What you give up.** Cursor sign-in still required; Cursor's own model catalog, Tab
   completion and cloud agents are unavailable in local mode; every turn carries Cursor's
   local system prompt (~23k tokens) — budget accordingly.
3. **Configure the gateway.** Two equivalent ways:
   - Settings → Models → Gateway → Base URL `http://127.0.0.1:10100/v1`, API Key: the
     value from `~/.opencodex/service-api-token` when the service uses API auth, otherwise
     any placeholder (loopback needs no key). Click "Refresh model list".
   - Environment: `CURSOR_LOCAL_AGENT_BASE_URL`, `CURSOR_LOCAL_AGENT_API_KEY`,
     optional `CURSOR_LOCAL_AGENT_HEADERS`.
   Per-OS env mechanics (the app is GUI-launched; interactive shell rc files are not read):
   - macOS: `launchctl setenv CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1` (session
     only) or a LaunchAgent `EnvironmentVariables`; or start from a terminal.
   - Windows: `setx CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1` (user scope; new
     processes only) or System Properties → Environment Variables.
   - Linux: `~/.profile` / `~/.pam_environment` or `systemctl --user set-environment`, then
     relaunch; AppImage launched from a terminal inherits the shell env.
   Base URL must include `/v1`; `http://` loopback is accepted, no TLS needed.
4. **Keep the two builds apart.** Same app id and data folder as regular Cursor
   (`~/Library/Application Support/Cursor`, `%APPDATA%\Cursor`, `~/.config/Cursor`). Launch
   with `--user-data-dir <dir>` to isolate, and disable "Import data from existing Cursor
   installation" on first run if you do not want it to copy your settings.
5. **Models and reasoning effort.** The picker lists OpenCodex's `/v1/models`. The effort
   control appears when OpenCodex advertises capabilities (v2.41+, layer 1) **and** the model
   id matches Cursor's built-in table. Table: GPT-5.6 Sol/Terra/Luna low..xhigh (Max/Ultra
   not exposed); Claude Opus 5 / Sonnet 5 low..max; Grok 4.x minimal..xhigh; Gemini
   minimal..high; Claude Fable 5.1, Kimi K3 and other ids get no control — set a default
   effort in OpenCodex instead (`modelDefaultReasoningEfforts`). Cursor matches on the part
   after the last `/`, so `anthropic/claude-opus-5` works.
6. **Verify.** `ocx observe logs` shows rows with `inboundProtocol: chat` and
   `admissionKind: loopback`. Troubleshooting: 401 → key mismatch with
   `OPENCODEX_API_AUTH_TOKEN`; empty picker → Refresh model list / check `ocx models`;
   no effort control → check the id against the table above and that `/v1/models` rows
   carry `api_types`.

Constraint: `rg -n 'downloads.cursor.com|cursor-local/' docs-site/src/content/docs/guides/cursor-private-inference.md` must return 0 hits.

## Stack publish steps (B of wp3)

1. On layer 1: `git push -u origin codex/cursor-local-models-schema` (hooks run; no `--no-verify`).
2. `gh pr create --base dev --head codex/cursor-local-models-schema` with the repo template
   (Summary / Verification / Checklist) and the DEV-STACK-03 map.
3. On layer 2: `git push -u origin codex/cursor-private-inference-guide`;
   `gh pr create --base codex/cursor-local-models-schema --head codex/cursor-private-inference-guide`.
4. Wait for CI on the exact head SHA of each PR (`gh pr view --json headRefOid,statusCheckRollup`);
   green rollup is the accept criterion. No merge.

## Accept criteria

- Guide renders in the docs build: `cd docs-site && bun run build` exit 0 (verifier — run at B;
  if the docs build is too slow locally, CI's docs job is the gate and this becomes human review).
- `bun run privacy:scan` exit 0.
- Both PRs open, correct bases, CI green on head SHA.

