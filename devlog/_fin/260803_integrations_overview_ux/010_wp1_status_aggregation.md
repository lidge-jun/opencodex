# WP1 — one status model for eleven clients

## The problem this solves

Five of the eleven integrations on this page answer a different route with a
different shape. Rendering them in one grid needs one model, and that model has
to be honest about the difference between "not applied" and "we do not know
yet".

## IN

1. `gui/src/pages/integrations/overview-clients.ts` — new: the row model, the
   catalog, and the pure mappers from each route payload to a row.
2. `gui/src/pages/integrations/integration-api.ts` — add the four loaders for
   the non-file routes. Nothing existing changes.

OUT: the server, the file-client writer path, the six file clients' semantics.

## The row model

```ts
export type OverviewClientId =
  | "codex" | "keys" | "claude" | "claudeDesktop" | "grok"
  | FileIntegrationClientId;

export interface OverviewRow {
  id: OverviewClientId;
  /** Which tab the card opens. Claude Desktop opens Claude's nested route. */
  hash: string;
  labelKey: TKey;
  /** Badge state, already collapsed to the visual vocabulary. */
  state: VisualIntegrationState | "unknown";
  /** Detected-on-this-machine, for the summary's 감지됨 count. */
  installed: boolean;
  /** Counted by 적용 중. */
  applied: boolean;
  /** One line under the title: config path for file clients, else a short fact. */
  detail: string | null;
  /** Only file clients carry an inline switch. */
  toggle: FileIntegrationClientId | null;
}
```

`state: "unknown"` is new and load-bearing. The four extra routes are fetched
independently, and a failed or in-flight one must not render as `absent` —
that is the exact lie this work-phase exists to remove. A row whose source has
not settled shows a muted "확인 중" badge and is counted in neither summary
number.

## Mapping, route by route

### Codex CLI — `GET /api/startup-health`

`routingInjected` is the only field that answers "is opencodex in Codex's
path right now". `status` (`native` / `at-risk` / `protected` / `error`) is
about surviving a reboot, which is a different question and belongs to the
Startup page, not here.

| Payload | Row |
|---|---|
| `routingInjected: true`, `status !== "error"` | `current`, applied, installed |
| `routingInjected: true`, `status === "error"` | `stale`, applied, installed |
| `routingInjected: false` | `absent`, not applied, installed |
| request failed | `unknown` |

`installed` is always true for Codex: the proxy answering at all means Codex
CLI is the client this product exists for. Detail line: the recommended
command when not injected, otherwise nothing.

### API keys — `GET /api/keys`

A key list is not an "integration applied to a config file", so it maps to the
two states it actually has:

| Payload | Row |
|---|---|
| `keys.length > 0` | `current`, applied, detail = `{n}개 발급됨` |
| `keys: []` | `absent`, not applied, detail = null |
| failed | `unknown` |

`installed: true` always — the surface exists regardless.

### Claude Code — `GET /api/claude-code`

`enabled` is the connection switch that used to live in the sidebar.

| Payload | Row |
|---|---|
| `enabled: true` | `current`, applied |
| `enabled: false` | `absent` |
| failed | `unknown` |

Detail: the resolved `authMode`, translated — that is the one fact a user
checks before wondering why a request was refused.

### Claude Desktop — `GET /api/claude-desktop/status`

This route already carries a drift signal, and it maps cleanly onto the
vocabulary the file clients use:

| Payload | Row |
|---|---|
| `applied: true`, `stale: true` | `stale` |
| `applied: true`, `activeProfile === false` | `stale` |
| `applied: true`, otherwise | `current` |
| `applied: false` | `absent` |
| failed | `unknown` |

`activeProfile === false` is a real "applied but not in effect" state: the
profile exists in the config library but Desktop is serving a different one.
Folding it into `stale` reuses the amber badge the user already knows, without
claiming a green connection Desktop is not honoring. `activeProfile === null`
is undeterminable and does not downgrade a `current`.

Detail: applied timestamp when present.

### Grok Build — `GET /api/grok`

| Payload | Row |
|---|---|
| `present: true` | `current`, applied, detail = `{n}개 모델` |
| `present: false` | `absent` |
| failed | `unknown` |

`installed` follows `present || configPath exists` — the route answers
`present: false` both when Grok is missing and when it is installed without a
fence, and the payload cannot tell them apart. Treat it as installed only when
the fence is present, and say "미설치" otherwise; a false "미설치" for an
unfenced install is the safer error, since the card's action still works.

## Loaders

Four thin functions in `integration-api.ts`, each returning the raw payload
shape it needs and nothing more. They do **not** throw on a non-OK response —
they resolve `null`, and `null` maps to `unknown`. The existing
`readResponse`/`IntegrationApiError` path stays exactly as it is for the file
clients, whose refusal envelopes carry recovery information a null would drop.

```ts
export async function loadCodexRoutingStatus(apiBase, signal): Promise<CodexRoutingPayload | null>
export async function loadApiKeyCount(apiBase, signal): Promise<number | null>
export async function loadClaudeCodeStatus(apiBase, signal): Promise<ClaudeCodePayload | null>
export async function loadClaudeDesktopStatus(apiBase, signal): Promise<ClaudeDesktopPayload | null>
export async function loadGrokStatus(apiBase, signal): Promise<GrokPayload | null>
```

Each parses only the fields listed above. `/api/claude-code` returns a large
payload including every context window and alias; reading two booleans out of
it and discarding the rest keeps the overview from depending on a shape it does
not own.

## Acceptance

- [ ] `buildOverviewRows` is pure: given the six file statuses plus the five
      payloads (any of them `null`), it returns eleven rows in catalog order.
- [ ] A `null` payload produces `state: "unknown"` and is counted in neither
      `installed` nor `applied`.
- [ ] Claude Desktop with `stale: true` and with `activeProfile: false` both
      produce `stale`; `activeProfile: null` does not.
- [ ] Codex with `routingInjected: false` is `absent` even when
      `status: "protected"`.
- [ ] `bun run typecheck` clean.
