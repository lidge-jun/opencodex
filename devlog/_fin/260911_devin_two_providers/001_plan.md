# 001 — Devin/Cognition as two providers

Objective: opencodex gains two Devin-family providers.

- `devin` — cloud-direct. Connect-RPC to Cognition's `exa.api_server_pb.ApiServerService`,
  carried from PR #4078 (author @wtfsayo) onto current `dev` and hardened.
- `devin-cli` — local. Spawns the Devin CLI and speaks Agent Client Protocol
  (newline-delimited JSON-RPC on stdio), modeled on the user-supplied working
  `server.mjs` proxy and the reference executor in `.tmp/openproxy-ref`.

`.tmp/openproxy-ref` (quangdang46/openproxy) is read-only reference. No code or
license-bearing text from it enters this repository.

## Work phases

| id | outcome |
|---|---|
| wp1 | Carry + harden the cloud-direct `devin` adapter on current `dev` |
| wp2 | Live Cognition evidence (free signup + client download via aside), fold verified constants in |
| wp3 | Second provider `devin-cli` over ACP stdio |
| wp4 | Docs/locale parity, full gates, PR, merge into `dev` |

## wp1 — what changes and why

The carry itself is done: `git merge --squash pr4078` applied cleanly onto
`9ea5759226`, the root-level test moved to its layout domain
(`tests/providers/devin-adapter.test.ts`) with `scripts/test-layout/layout.json`
and `tests/fixtures/test-layout-expected.json` updated, and the focused suites pass
(36/36). Four independent reviewers audited the result. Their findings define wp1's
diff:

### 1. Tenant api-server routing (major, real runtime failure)

`src/oauth/devin.ts` stores RegisterUser's `api_server_url` on the credential, but
`src/adapters/devin.ts` always posts GetUserJwt / GetCascadeModelConfigs /
GetChatMessage to `provider.baseUrl`, which `src/providers/registry.ts` hardcodes to
`https://server.codeium.com`. EU and FedStart tenants return a different host
(`eu.windsurf.com/_route/api_server`, `windsurf.fedstart.com/_route/api_server`), so
those accounts log in and then send every call to the wrong server. GitHub Copilot
already threads `credential.apiBaseUrl` through; Devin must do the same, falling back
to the default host only when RegisterUser returned nothing.

### 2. Portal/register override (major, real runtime failure)

Login always signs in against `DEFAULT_REGION`. `src/oauth/devin/types.ts` documents
a `--portal-url` override that nothing wires, so a non-US tenant never reaches its
matching RegisterUser host. Honor the override and persist it next to the api-server
URL on the credential.

### 3. Model-id normalization (minor, degraded path)

`src/adapters/devin.ts` has no dotted-to-hyphen map. With the live catalog missing we
append `-medium` to the raw id, turning `swe-1.6` into `swe-1.6-medium`, which
Cognition answers with an opaque `permission_denied`. Normalize `.` to `-` before
lookup and suffix only ids that actually carry an effort segment.

### 4. Docs/locale parity (major, deferred to wp4)

English `providers.md` and `reference/adapters.md` gained `devin`; the seven locales
(`ko ja zh-cn zh-tw fr ru tr`) still jump from `cursor` to `github-copilot` and from
`cursor` to `azure-openai`. No test compares them, but AGENTS.md forbids a locale
contradicting the English source. Both providers land in every locale in wp4, once
the final surface is known.

### 5. Auth and streaming findings

Two reviewers (credential handling; streaming terminal/abort semantics) are still
running. Their blockers and majors fold into this same wp1 diff before A closes.

## Boundaries

- No change to `src/router.ts`, `src/server/lifecycle.ts`, or
  `src/server/responses/core.ts` reaching `src/lab/`.
- No new CLI command, so `skills/ocx/` and `src/cli/capabilities.ts` stay as they are.
- `devin` keeps `dashboardPreset: false` and stays out of the featured lists.
- Security notes stay in `.tmp/`, never in `devlog/`.
