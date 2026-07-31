# 040 — Phase 4: GUI detail pane, auth matrix, rename, model test

First user-visible phase. It consumes phase 1's rename route and phase 3's
attribution/auth payload, then replaces the two places where the API tab currently
claims more than it proves: the repeated key detail and the protocol-agnostic model
test (`001` W2, W3, W7, W11, W12).

Dependency position: after `030_attribution_telemetry.md`. Phase 5 deliberately
follows this phase because it removes scroll constraints around markup rewritten
here (`000_plan.md` §Work-phase map).

## Phase-P contract gate

This document plans against the following `GET /api/keys` payload. It is the
contract `030` plans to ship, not evidence that it has shipped:

```ts
type ApiKeyUsage =
  | { ambiguous: true }
  | { ambiguous?: false; requests7d: number; totalRequests: number; lastUsedAt?: string };

interface ApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  /** Always present once `030` lands; zeroes mean "attributed nothing", which is
   *  different from "attribution unavailable" — see `attributionSince`. */
  usage: ApiKeyUsage;
}

type ApiAuthDisposition = "required" | "accepted" | "rejected";

interface ApiAuthMatrixRow {
  endpoint: string;
  bearer: ApiAuthDisposition;
  dedicated: ApiAuthDisposition;
  xApiKey: ApiAuthDisposition;
}

interface KeysResponse {
  // existing endpoint fields omitted
  keys?: ApiKeyEntry[];
  /** Earliest usage row carrying a recognized admission kind. Describes the DATA
   *  SET, not a key, so it is top-level and singular. Absent means nothing is
   *  attributable yet. */
  attributionSince?: string;
  authMatrix: ApiAuthMatrixRow[];
}
```

At this phase's P gate, read the code and tests that `030` actually shipped and
reconcile this shape before editing GUI code. In particular, verify field names,
whether `usage` is absent for an unattributable key or present with zeroes, the
meaning of `attributionSince`, endpoint ordering, and the three disposition values.
Do not add a frontend compatibility adapter merely to preserve this draft shape.
The server is the source of truth (`003_ux_direction.md` §3).

### Resolved: where `attributionSince` lives

This document was first drafted against a per-key optional `usage` carrying its own
`attributionSince`, which contradicted `030`. The conflict is settled in favour of
`030` — see its `### src/server/management/api-key-usage.ts (NEW)` section, where
`attributionSince` sits on `ApiKeyUsageSnapshot` beside the rollup map rather than
inside a per-key object. The shape above is the reconciled one. Two reasons, both about what the field actually means:

- `attributionSince` is a property of the usage **data set** — the earliest row
  carrying a recognized admission kind. Repeating one global value on every row
  invites the reading that attribution started at different times for different
  keys, which is false.
- With `usage` always present, `requests7d: 0` means "this key was attributed
  nothing", and top-level `attributionSince === undefined` means "nothing is
  attributable at all". A per-key optional `usage` collapses those two states into
  one absent object, and they need different copy (`003_ux_direction.md` §6).

So: `CachedKeysShape` carries top-level `attributionSince`; unavailable-vs-zero copy
keys on that field and never on `usage === undefined`. No compatibility union
supporting both shapes. If `030` ships differently from the block above, the server
still wins and these examples are revised at P.

### Rail decision is a build gate, not runtime inference

The chosen design keeps the rail only if phase 3 supplies attribution
(`003_ux_direction.md` §2). If `030` did not land the rollup, phase 4 must delete
the rail and render active keys as a flat overview table. It must not decide at
runtime that attribution is unavailable because every current row lacks `usage`:
an empty key list, an old key with no attributable requests, and a pre-feature
server can all produce that observation. The P gate chooses one implementation
branch from the shipped contract.

The diffs below describe the selected branch: attribution exists and the rail earns
its place. If the fallback branch activates, revise this document before B and
remove the rail/detail CSS and tests rather than shipping the repeated pane.

Every `usage`/`attributionSince` code block below is therefore conditional on the
supplied contract winning that P-gate reconciliation. The auth-matrix portion already
matches the four-row `AUTH_MATRIX` in `030`'s `### AUTH_MATRIX` section.

## Scope

IN

- Consume per-key attribution from `GET /api/keys`; never derive it from the model
  catalog or a client-side request count.
- Consume phase 1's `PATCH /api/keys` rename.
- Redesign the rail as name · seven-day requests · last used; move prefix to detail.
- Rebuild detail around attribution and a pessimistic inline rename.
- Keep the selected detail visible until DELETE succeeds.
- Replace the closed authentication prose with a server-driven, always-visible
  matrix.
- Test the protocol the user chose, send `x-opencodex-api-key`, and attach state to
  that protocol chip.
- Correct the blanket bearer claim in the existing configuration reference.

OUT

- No expiry, scopes, allowlists, rotation, soft revocation, or retroactive
  attribution (`000_plan.md` §Scope boundary, OUT).
- No forwarded-header/public-origin work (`000_plan.md` §Scope boundary, OUT).
- No admission-rule change. This phase renders `authMatrix`; it does not choose its
  values.
- No endpoint, adapter, catalog, routing, or provider-registry change.
- No panel addition, removal, or reorder in `awi-overview-left`. Manage, Endpoints,
  Usage stay in their current order (`ApiKeysWorkspace.tsx:224-247`), leaving the
  client-config unit's insertion point untouched (`000_plan.md` §Coordination).
- No model-test management endpoint. The browser sends the same data-plane request
  an external client would send.

## Mutation decisions

### Rename is pessimistic

Keep the form open and its draft intact while PATCH is pending. Disable Save during
the request; close edit mode only after a 2xx response, then refresh keys. On failure,
keep the input and render `api.key.renameFailed` beside it.

This is intentionally pessimistic. The current resource layer exposes refresh but
no cache mutation API (`gui/src/data-surface.ts:34-37`,
`gui/src/client-resource.ts:382-391`). An optimistic rename would require a second
overlay store and rollback rules for a low-frequency settings action. The existing
CRUD convention says optimistic updates only where the repository already uses them;
it does not here. A pending button is cheaper and tells the truth.

### Delete resolves before navigation

`handleConfirmDelete` currently calls a void callback and clears confirmation and
selection immediately (`ApiKeysWorkspace.tsx:110-115`), while the request settles
in the parent later (`ApiKeys.tsx:182-198`). Change `onDelete` to
`(id: string) => Promise<boolean>`. The detail disables destructive controls while
awaiting it and returns to Overview only on `true`. A rejected request returns
`false`, leaves the selected key and confirm context visible, and keeps the user
beside the failure. This fixes W12 without weakening the 300 ms double-click guard
at `ApiKeysWorkspace.tsx:97-103`.

## File change map

| Path | Action |
|------|--------|
| `gui/src/api-access-models.ts` | MODIFY — named inbound-protocol union |
| `gui/src/pages/api-keys-utils.ts` | MODIFY — usage/auth contracts, matrix guard, model-test helper, `API_KEY_NAME_MAX_LENGTH` |
| `gui/src/pages/ApiKeys.tsx` | MODIFY — consume v2 key payload, PATCH, honest DELETE promise, protocol request + auth header, awaited clipboard |
| `gui/src/pages/api-keys-panels.tsx` | MODIFY — open auth matrix, interactive protocol chips with live results, create-input `maxLength` |
| `gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx` | MODIFY — attribution rail/detail, rename state, awaited delete |
| `gui/src/styles-apikeys-workspace.css` | MODIFY — matrix, attribution, rename, protocol-chip styles only; phase 5 owns scroll geometry |
| `gui/src/i18n/{en,ko,ja,zh,de,ru}.ts` | MODIFY — namespaced copy below in all six locales |
| `docs-site/src/content/docs/reference/configuration.md` | MODIFY — endpoint-specific auth statement |
| `docs-site/src/content/docs/{ko,ja,ru}/reference/configuration.md` | MODIFY — translated endpoint-specific auth statement |
| `gui/tests/api-access-models.test.ts` | MODIFY — protocol union/list remains exact |
| `gui/tests/apikeys-layout.test.ts` | MODIFY — matrix is open/server-driven; left panel order unchanged |
| `gui/tests/apikeys-workspace.test.tsx` | MODIFY — attribution, rename, pending delete, failure retention |
| `gui/tests/apikeys-refresh-preserve.test.tsx` | MODIFY — v2 fixtures include usage + matrix; failed post-mutation refresh remains last-good |
| `gui/tests/apikeys-actions.test.tsx` | NEW — PATCH and per-protocol authenticated request integration |

There are no German or Chinese `reference/configuration.md` files in this checkout;
do not invent them in this phase. The GUI locale requirement is separate and still
updates all six TypeScript dictionaries (`gui/AGENTS.md:12-18`).

## Diffs

### `gui/src/api-access-models.ts:10-15` — make protocol selection typed

Before:

```ts
/** Inbound gateway protocols — not inferred from provider type. */
export function gatewayInboundProtocols(claudeCodeEnabled: boolean): string[] {
  return claudeCodeEnabled
    ? ["responses", "chat", "messages"]
    : ["responses", "chat"];
}
```

After:

```ts
export type GatewayInboundProtocol = "responses" | "chat" | "messages";

/** Inbound gateway protocols — not inferred from provider type. */
export function gatewayInboundProtocols(
  claudeCodeEnabled: boolean,
): GatewayInboundProtocol[] {
  return claudeCodeEnabled
    ? ["responses", "chat", "messages"]
    : ["responses", "chat"];
}
```

The model panel already gets its chip list from this helper
(`api-keys-panels.tsx:391-403`). Typing that existing owner is preferable to a
parallel protocol list in `ApiKeys.tsx`.

### `gui/src/pages/api-keys-utils.ts:1-16` — wire contracts and test identity

Before:

```ts
export interface ApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}

export type ModelTestState = "idle" | "testing" | "ok" | "error";
```

After:

```ts
import type { GatewayInboundProtocol } from "../api-access-models";

export type ApiKeyUsage =
  | { ambiguous: true }
  | { ambiguous?: false; requests7d: number; totalRequests: number; lastUsedAt?: string };

export interface ApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  /** Always present from the server; zeroes are a real answer. Dataset-level
   *  availability is the top-level `attributionSince`, not this object. */
  usage: ApiKeyUsage;
}

export type ApiAuthDisposition = "required" | "accepted" | "rejected";

export interface ApiAuthMatrixRow {
  endpoint: string;
  bearer: ApiAuthDisposition;
  dedicated: ApiAuthDisposition;
  xApiKey: ApiAuthDisposition;
}

export type ModelTestState = "idle" | "testing" | "ok" | "error";
export interface ModelTestResult { state: ModelTestState; detail?: string }
export type ModelTests = Record<
  string,
  Partial<Record<GatewayInboundProtocol, ModelTestResult>>
>;
```

Add a strict matrix boundary beside these declarations:

```ts
const AUTH_DISPOSITIONS = new Set<ApiAuthDisposition>(["required", "accepted", "rejected"]);

export function isApiAuthMatrix(value: unknown): value is ApiAuthMatrixRow[] {
  return Array.isArray(value) && value.every(row => (
    typeof row === "object" && row !== null
    && typeof (row as ApiAuthMatrixRow).endpoint === "string"
    && AUTH_DISPOSITIONS.has((row as ApiAuthMatrixRow).bearer)
    && AUTH_DISPOSITIONS.has((row as ApiAuthMatrixRow).dedicated)
    && AUTH_DISPOSITIONS.has((row as ApiAuthMatrixRow).xApiKey)
  ));
}
```

Do not silently filter malformed rows: a partial matrix is another false auth claim.
The keys fetch fails and preserves last-good data instead.

Add a request helper below `DEFAULT_ENDPOINTS` (`api-keys-utils.ts:18-24`):

```ts
export function modelTestRequest(
  endpoints: ApiEndpointInfo,
  protocol: GatewayInboundProtocol,
  model: string,
): { url: string; body: Record<string, unknown> } {
  if (protocol === "responses") {
    return {
      url: endpoints.responses,
      body: { model, input: "ping", max_output_tokens: 1, stream: false },
    };
  }
  if (protocol === "messages") {
    return {
      url: endpoints.messages,
      body: { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    };
  }
  return {
    url: endpoints.chatCompletions,
    body: { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false },
  };
}
```

The protocol-specific body is necessary: today's function always sends Chat
Completions JSON to `endpoints.chatCompletions` (`ApiKeys.tsx:231-253`). The helper
is pure so the action test can assert exact URL and JSON without source matching.

### `gui/src/pages/ApiKeys.tsx:22-41,61-94` — require and cache server truth

Before:

```ts
interface KeysResponse {
  keys?: ApiKeyEntry[];
  endpoint?: string;
  // endpoint fields omitted
}

type CachedKeysShape = {
  keys: ApiKeyEntry[];
  endpoints: ApiEndpointInfo;
  claudeCodeEnabled: boolean;
};

const keysCacheKey = `ocx.apikeys.list.v1:${apiBase}`;
```

After:

```ts
interface KeysResponse {
  keys?: ApiKeyEntry[];
  attributionSince?: string;
  authMatrix?: unknown;
  endpoint?: string;
  // existing endpoint fields stay unchanged
}

type CachedKeysShape = {
  keys: ApiKeyEntry[];
  endpoints: ApiEndpointInfo;
  claudeCodeEnabled: boolean;
  /** Dataset-level, from the response root. Drives unavailable-vs-zero copy;
   *  never read off a key. */
  attributionSince?: string;
  authMatrix: ApiAuthMatrixRow[];
};

const keysCacheKey = `ocx.apikeys.list.v2:${apiBase}`;
```

and in `fetchKeys`:

```ts
const data = await readJsonIfOk<KeysResponse>(res);
if (!data || !isApiAuthMatrix(data.authMatrix)) {
  throw new Error(t("api.keysLoadFailed"));
}
const derived = deriveApiEndpoints(data.endpoint ?? "");
const next: CachedKeysShape = {
  keys: data.keys ?? [],
  endpoints: { /* current endpoint derivation stays byte-for-byte */ },
  claudeCodeEnabled: data.claudeCodeEnabled !== false,
  attributionSince: data.attributionSince,
  authMatrix: data.authMatrix,
};
```

`attributionSince` is copied here and nowhere else. It then reaches the workspace
the same way every other server value does:

```ts
// in the ApiKeys render body, beside `const keys = keysData?.keys ?? []`
const attributionSince = keysData?.attributionSince;

<ApiKeysWorkspace
  keys={keys}
  attributionSince={attributionSince}
  /* … */
/>
```

Both the fresh-fetch and session-cache paths carry it, because both go through
`CachedKeysShape` — a test asserts the cached reload still renders attribution
rather than falling back to unavailable.

The cache key bumps because a v1 session entry has no matrix. Defaulting that cache
to `[]` would turn stale client state into an apparently authoritative empty auth
table. The cache still contains prefixes/usage only, never the secret
(`ApiKeys.tsx:91-92`).

### Moved from phase 5: clipboard, name limit, live region

These three fixes moved here from phase 5 during the roadmap audit. They were
originally grouped into a later "hardening" pass, which was effort-bucketing:
each one edits markup this phase is already rewriting, so shipping them later
would mean touching the same handler, the same input and the same badge twice
(`000_plan.md` §Where the small correctness fixes go).

### `gui/src/pages/ApiKeys.tsx:200-206` — clipboard success follows the promise

Before:

```ts
const copyKey = () => {
  if (newKey) {
    navigator.clipboard.writeText(newKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
};
```

After:

```ts
const copyKey = async () => {
  if (!newKey) return;
  setActionError(null);
  try {
    await navigator.clipboard.writeText(newKey);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  } catch {
    setCopied(false);
    setActionError(t("api.key.copyFailed"));
  }
};
```

Pass `onCopyKey={() => { void copyKey(); }}`. Do not dismiss or clear `newKey` on
failure: the user must still be able to select the visible one-time value manually.
This deliberately differs from `copyModelId`, whose failure is low consequence and
currently stays silent (`ApiKeys.tsx:208-216`).

### `gui/src/pages/api-keys-utils.ts` — one GUI name limit

Phase 1 establishes `64` as the server maximum at the POST/PATCH **write
boundary** — deliberately not in the config read schema, which stays permissive so
an existing long name cannot make a config unloadable
(`010_key_identity_and_crud.md` §Validation belongs at the write boundary). Add:

```ts
export const API_KEY_NAME_MAX_LENGTH = 64;
```

This constant owns both GUI inputs. It does not replace server validation and does
not cross-import backend code into the Vite bundle.

### `gui/src/pages/api-keys-panels.tsx:265-280` — create name limit

Before:

```tsx
<input
  id="api-key-name"
  type="text"
  placeholder={t("api.keyNamePlaceholder")}
  aria-label={t("api.keyNamePlaceholder")}
  value={newName}
  onChange={e => onNewNameChange(e.target.value)}
  className="input"
/>
```

After:

```tsx
<input
  id="api-key-name"
  type="text"
  placeholder={t("api.keyNamePlaceholder")}
  aria-label={t("api.keyNamePlaceholder")}
  value={newName}
  maxLength={API_KEY_NAME_MAX_LENGTH}
  onChange={e => onNewNameChange(e.target.value)}
  className="input"
/>
```

Apply the same `maxLength={API_KEY_NAME_MAX_LENGTH}` to the inline rename input
this phase adds to `ApiKeysWorkspace` (see the detail-pane diff below). The server
remains authoritative for crafted requests; the attribute prevents the normal GUI
from accepting a value it knows PATCH will reject (W15).

In each protocol chip this phase builds, the dynamic result wrapper is an
announcement owned by that result transition rather than a plain span:

```tsx
{result && result.state !== "idle" && (
  <span
    className={`api-test-note api-test-note--${result.state}`}
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    {result.state === "testing"
      ? t("api.auth.testing")
      : result.state === "ok"
        ? t("api.auth.testSucceeded")
        : t("api.auth.testFailed")}
  </span>
)}
```

The error detail remains visible text associated with the same protocol control.
Only the chosen protocol result mounts/changes, so a completed Responses test is not
re-announced when Messages starts. This closes W14 on the same badge this phase
attaches to the chip — which is exactly why it is not a later pass.

### `gui/src/pages/ApiKeys.tsx:68,182-198` — rename and awaited delete

Before DELETE:

```ts
const handleDelete = async (id: string) => {
  setActionError(null);
  try {
    const res = await fetch(`${apiBase}/api/keys`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      setActionError(t("api.deleteFailed"));
      return;
    }
    refreshKeys();
  } catch {
    setActionError(t("api.deleteFailed"));
  }
};
```

After, with PATCH immediately above DELETE:

```ts
const handleRename = async (id: string, name: string): Promise<boolean> => {
  try {
    const res = await fetch(`${apiBase}/api/keys`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name }),
    });
    if (!res.ok) return false;
    refreshKeys();
    return true;
  } catch {
    return false;
  }
};

const handleDelete = async (id: string): Promise<boolean> => {
  setActionError(null);
  try {
    const res = await fetch(`${apiBase}/api/keys`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      setActionError(t("api.deleteFailed"));
      return false;
    }
    refreshKeys();
    return true;
  } catch {
    setActionError(t("api.deleteFailed"));
    return false;
  }
};
```

Do not clear `newKey` after rename or delete; it is the only secret available to an
authenticated browser-side model test.

### `gui/src/pages/ApiKeys.tsx:225-260` — protocol-specific authenticated test

Before:

```ts
const testModel = async (model: ExternalModelRow) => {
  const modelId = externalModelId(model);
  setModelTests(current => ({ ...current, [modelId]: { state: "testing" } }));
  try {
    const res = await fetch(endpoints.chatCompletions, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
    });
    // result stored once per model
  }
};
```

After:

```ts
const [modelTests, setModelTests] = useState<ModelTests>({});

const setModelTest = (
  modelId: string,
  protocol: GatewayInboundProtocol,
  result: ModelTestResult,
) => setModelTests(current => ({
  ...current,
  [modelId]: { ...current[modelId], [protocol]: result },
}));

const testModel = async (
  model: ExternalModelRow,
  protocol: GatewayInboundProtocol,
) => {
  if (!newKey) return;
  const modelId = externalModelId(model);
  const request = modelTestRequest(endpoints, protocol, modelId);
  setModelTest(modelId, protocol, { state: "testing" });
  try {
    const res = await fetch(request.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencodex-api-key": newKey,
      },
      body: JSON.stringify(request.body),
    });
    if (!res.ok) {
      const detail = await res.text();
      setModelTest(modelId, protocol, {
        state: "error",
        detail: detail.slice(0, 160) || String(res.status),
      });
      return;
    }
    setModelTest(modelId, protocol, { state: "ok" });
  } catch (error) {
    setModelTest(modelId, protocol, {
      state: "error",
      detail: error instanceof Error ? error.message : t("api.auth.testFailed"),
    });
  }
};
```

`newKey`, held at `ApiKeys.tsx:71`, is the only secret the GUI owns. GET returns a
prefix by design (`001_surface_inventory.md` §2), so existing/dismissed keys
cannot be reconstructed for a test. Pass `canTestModels={newKey !== null}` and
`onTestModel={testModel}` to the workspace. If false, show
`api.auth.testNeedsFreshKey` once above the table and disable protocol test chips.
Do not send a prefix, management token, or header-less loopback request.

Also pass `authMatrix={keysData?.authMatrix ?? []}` and
`onRename={handleRename}`. The empty fallback is reachable only while no key data is
available; `fetchKeys` rejects a settled payload without a valid matrix.

### `gui/src/pages/ApiKeys.tsx:262-276` — stop restating a blanket header rule

Before:

```tsx
const subtitleParts = t("api.subtitle").split(/\{authHeader\}|\{altHeader\}/);

<p className="page-sub">
  {subtitleParts[0]}
  <code>Authorization: Bearer ocx_...</code>
  {subtitleParts[1]}
  <code>x-opencodex-api-key</code>
  {subtitleParts[2]}
</p>
```

After:

```tsx
<p className="page-sub">{t("api.subtitle")}</p>
```

The matrix owns header truth. Keeping the subtitle's “or” claim would preserve W1
above a correct table.

### `gui/src/pages/api-keys-panels.tsx:155-205` — replace `<details>` with matrix

Before:

```tsx
<p className="muted small">{t("api.endpointNote")}</p>
<details className="awi-inline-fold">
  <summary>{t("api.authTitle")}</summary>
  <div className="awi-inline-fold-body">
    <ul className="api-auth-list muted small">
      <li>{t("api.authChatCompletions")}</li>
      <li>{t("api.authResponses")}</li>
      {claudeCodeEnabled && <li>{t("api.authMessages")}</li>}
      <li>{t("api.authLoopback")}</li>
    </ul>
    <p className="muted small">{t("api.authBaseUrlNote")}</p>
  </div>
</details>
```

After, using an internal `ApiAuthMatrix` component in the same file:

```tsx
function ApiAuthMatrix({ rows }: { rows: ApiAuthMatrixRow[] }) {
  const { t } = useI18n();
  const disposition = (value: ApiAuthDisposition) => {
    if (value === "required") return t("api.auth.required");
    if (value === "accepted") return t("api.auth.accepted");
    return t("api.auth.rejected");
  };
  return (
    <section className="api-auth-matrix" aria-labelledby="api-auth-matrix-title">
      <h4 id="api-auth-matrix-title" className="api-auth-matrix-title">
        {t("api.auth.title")}
      </h4>
      <div className="tbl-wrap api-auth-matrix-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t("api.auth.endpoint")}</th>
              <th><code>Authorization: Bearer</code></th>
              <th><code>x-opencodex-api-key</code></th>
              <th><code>x-api-key</code></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.endpoint}>
                <td><code>{row.endpoint}</code></td>
                <td>{disposition(row.bearer)}</td>
                <td>{disposition(row.dedicated)}</td>
                <td>{disposition(row.xApiKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">{t("api.auth.loopback")}</p>
    </section>
  );
}

// inside ApiKeysEndpointsPanel, after endpointNote
<ApiAuthMatrix rows={authMatrix} />
```

Header names and endpoint paths are technical machine text and stay literal under
`gui/AGENTS.md:19-27`; status words and explanatory copy are translated. Rows render
in server order. There is no frontend `claudeCodeEnabled` filter and no hardcoded
matrix fallback.

### `gui/src/pages/api-keys-panels.tsx:328-426` — chips become the test target

Before:

```tsx
<td>{gatewayInboundProtocols(claudeCodeEnabled).map(protocolLabel).join(", ")}</td>
<td>
  <div className="api-model-actions">
    <button /* copy */>...</button>
    <button onClick={() => { onTestModel(model); }}>
      {testState === "testing" ? t("api.testingModel") : t("api.testModel")}
    </button>
  </div>
  {testState === "ok" && <p className="api-test-note api-test-note--ok">...</p>}
</td>
```

After:

```tsx
<td>
  <div className="api-protocol-tests">
    {gatewayInboundProtocols(claudeCodeEnabled).map(protocol => {
      const result = modelTests[modelId]?.[protocol];
      return (
        <button
          key={protocol}
          type="button"
          className="api-protocol-chip"
          disabled={!canTestModels || result?.state === "testing"}
          aria-label={t("api.auth.testProtocol", { protocol: protocolLabel(protocol) })}
          onClick={() => onTestModel(model, protocol)}
        >
          <span>{protocolLabel(protocol)}</span>
          {result?.state === "testing" && <span>{t("api.auth.testing")}</span>}
          {result?.state === "ok" && <span className="api-test-note--ok">{t("api.auth.testSucceeded")}</span>}
          {result?.state === "error" && <span className="api-test-note--error">{t("api.auth.testFailed")}</span>}
        </button>
      );
    })}
  </div>
</td>
<td>
  <button type="button" className="btn btn-sm btn-ghost" onClick={() => onCopyModelId(modelId)}>
    {copiedModelId === modelId ? t("api.modelCopied") : t("api.copyModelId")}
  </button>
</td>
```

Render the selected protocol's error detail immediately below its chip group, keyed
by protocol, so one failed Messages test does not overwrite a successful Responses
badge, with the live-region semantics from the moved-fixes section above (W14).

### `gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx:22-49` — async contracts

Before:

```ts
modelTests: Record<string, { state: ModelTestState; detail?: string }>;
onDelete: (id: string) => void;
onTestModel: (model: ExternalModelRow) => void;
protocolLabel: (protocol: string) => string;
```

After:

```ts
authMatrix: ApiAuthMatrixRow[];
/** Dataset-level; absent means nothing is attributable yet. Drives the
 *  unavailable-vs-zero branch in the rail and the detail pane. */
attributionSince?: string;
modelTests: ModelTests;
canTestModels: boolean;
onRename: (id: string, name: string) => Promise<boolean>;
onDelete: (id: string) => Promise<boolean>;
onTestModel: (model: ExternalModelRow, protocol: GatewayInboundProtocol) => void;
protocolLabel: (protocol: GatewayInboundProtocol) => string;
```

`attributionSince` is destructured in the component signature alongside `keys`;
the rail and detail blocks below both branch on it, so omitting it from the props
would leave those blocks referencing an undefined binding.

Forward `authMatrix` to `ApiKeysEndpointsPanel` and the model-test props to
`ApiKeysModelsPanel`. Do not alter the component order at
`ApiKeysWorkspace.tsx:224-263`.

### `ApiKeysWorkspace.tsx:142-155` — comparative rail

Before:

```tsx
<span className="apikeys-workspace-rail-name">{k.name}</span>
<span className="apikeys-workspace-rail-meta">
  {k.prefix} · {formatCreatedDate(k.createdAt, localeTag)}
</span>
```

After:

```tsx
<span className="apikeys-workspace-rail-name">{k.name}</span>
<span className="apikeys-workspace-rail-meta">
  {attributionSince ? (
    k.usage.ambiguous ? (
      <span>{t("api.attribution.railAmbiguous")}</span>
    ) : (
    <>
      <span>{t("api.attribution.railRequests", {
        count: k.usage.requests7d.toLocaleString(localeTag),
      })}</span>
      <span aria-hidden="true"> · </span>
      <span>{k.usage.lastUsedAt
        ? t("api.attribution.railLastUsed", {
            date: new Date(k.usage.lastUsedAt).toLocaleString(localeTag),
          })
        : t("api.attribution.railNeverUsed")}</span>
    </>
    )
  ) : t("api.attribution.unavailable")}
</span>
```

Prefix leaves the rail completely. `usage` is always present, so zero requests
renders as zero with the never-used copy — that is a real answer, not a gap. The
dataset-level `attributionSince` is what distinguishes "attributed nothing" from
"the server cannot attribute anything yet", and only the latter suppresses the
numbers (`003_ux_direction.md` §6, and the contract gate above).

### `ApiKeysWorkspace.tsx:80-115,169-220` — rename, attributed detail, honest delete

Add local mutation state beside selection:

```ts
const [editingName, setEditingName] = useState(false);
const [renameDraft, setRenameDraft] = useState("");
const [renaming, setRenaming] = useState(false);
const [renameFailed, setRenameFailed] = useState(false);
const [deleting, setDeleting] = useState(false);

const beginRename = () => {
  if (!selected) return;
  setRenameDraft(selected.name);
  setRenameFailed(false);
  setEditingName(true);
};

const submitRename = async () => {
  if (!selected || !renameDraft.trim() || renaming) return;
  setRenaming(true);
  setRenameFailed(false);
  const ok = await onRename(selected.id, renameDraft.trim());
  setRenaming(false);
  if (ok) setEditingName(false);
  else setRenameFailed(true);
};

const handleConfirmDelete = async () => {
  if (!selected || !confirmArmed || deleting) return;
  setDeleting(true);
  const deleted = await onDelete(selected.id);
  setDeleting(false);
  if (!deleted) return;
  clearDeleteConfirm();
  setSelectedId(null);
};
```

Replace the repeated heading/KV body (`ApiKeysWorkspace.tsx:169-220`) with:

```tsx
<div className="awi-detail-head">
  {editingName ? (
    <form className="awi-key-rename" onSubmit={event => { event.preventDefault(); void submitRename(); }}>
      <label htmlFor="awi-key-name">{t("api.key.name")}</label>
      <input
        id="awi-key-name"
        className="input"
        value={renameDraft}
        onChange={event => setRenameDraft(event.target.value)}
        disabled={renaming}
      />
      <button className="btn btn-primary btn-sm" disabled={renaming || !renameDraft.trim()}>
        {renaming ? t("api.key.renaming") : t("api.key.saveName")}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingName(false)} disabled={renaming}>
        {t("common.cancel")}
      </button>
    </form>
  ) : (
    <>
      <h2 className="awi-detail-title">{selected.name}</h2>
      <button type="button" className="btn btn-ghost btn-sm" onClick={beginRename}>
        {t("api.key.rename")}
      </button>
    </>
  )}
  {/* existing guarded delete controls stay in this action row; disable while deleting */}
</div>
{renameFailed && (
  <p className="awi-rename-error" role="alert">{t("api.key.renameFailed")}</p>
)}

<div className="awi-section">
  <h3 className="awi-section-title">{t("api.key.details")}</h3>
  <dl className="awi-kv">
    <div className="awi-kv-row"><dt>{t("api.key.prefix")}</dt><dd><code>{selected.prefix}</code></dd></div>
    <div className="awi-kv-row"><dt>{t("api.colCreated")}</dt><dd>{formatCreatedDate(selected.createdAt, localeTag)}</dd></div>
  </dl>
</div>

<div className="awi-section">
  <h3 className="awi-section-title">{t("api.attribution.title")}</h3>
  {attributionSince ? (
    selected.usage.ambiguous ? (
      <p className="muted">{t("api.attribution.ambiguous")}</p>
    ) : (
    <dl className="awi-kv">
      <div className="awi-kv-row"><dt>{t("api.attribution.requests7d")}</dt><dd>{selected.usage.requests7d.toLocaleString(localeTag)}</dd></div>
      <div className="awi-kv-row"><dt>{t("api.attribution.totalRequests")}</dt><dd>{selected.usage.totalRequests.toLocaleString(localeTag)}</dd></div>
      <div className="awi-kv-row"><dt>{t("api.attribution.lastUsed")}</dt><dd>{selected.usage.lastUsedAt ? new Date(selected.usage.lastUsedAt).toLocaleString(localeTag) : t("api.attribution.neverUsed")}</dd></div>
      <div className="awi-kv-row"><dt>{t("api.attribution.since")}</dt><dd>{new Date(attributionSince).toLocaleString(localeTag)}</dd></div>
    </dl>
    )
  ) : (
    <p className="muted">{t("api.attribution.unavailableDetail")}</p>
  )}
</div>
```

The branch is on the top-level `attributionSince`, passed into the workspace beside
`keys`. That is the reconciliation from the contract gate above: a key with
`requests7d: 0` under a live dataset really was used zero times and shows zeroes,
while an absent `attributionSince` means the server has nothing attributable yet and
the pane says so instead of rendering a zero that reads as "never used"
(`003_ux_direction.md` §6). Branching on `usage` would merge those two states.

The inner `ambiguous` branch is not defensive coding: `usage` is a discriminated
union (`030` §`api-key-usage.ts`), so `requests7d` does not exist on the ambiguous
arm and TypeScript requires the narrowing. Two config entries sharing one id
cannot be given a per-key total, and printing one arbitrarily is the failure this
union exists to prevent.

Keep the existing confirm message and 300 ms arm. Change its submit label to
`deleting ? t("api.key.deleting") : t("api.confirm")`, and disable Confirm, Cancel,
Rename, and Back while DELETE is pending so selection cannot change underneath the
promise. The permanent-delete consequence remains visible throughout the request.

### `gui/src/styles-apikeys-workspace.css` — phase-4-only presentation

The current stylesheet gives fold-specific auth styles at
`styles-apikeys-workspace.css:281-366` and protocol text no chip owner. Replace only
the obsolete `.awi-inline-fold*` selectors and add:

```css
.api-auth-matrix {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}

.api-auth-matrix-title {
  margin: 0;
  font-size: var(--text-body);
  font-weight: var(--weight-semibold);
}

.api-auth-matrix-scroll {
  overflow-x: auto;
  overscroll-behavior-inline: auto;
}

.api-protocol-tests {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.api-protocol-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 28px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--raised);
  color: var(--text);
  font: inherit;
  font-size: var(--text-label);
  cursor: pointer;
}

.api-protocol-chip:focus-visible {
  outline: 2px solid var(--accent-ring);
  outline-offset: 1px;
}

.awi-key-rename {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
}

.awi-key-rename > .input {
  min-width: min(18rem, 100%);
}

.awi-rename-error {
  margin: 0 0 var(--space-3);
  color: var(--red);
  font-size: var(--text-sm);
}

.apikeys-workspace-rail-meta {
  font-family: inherit;
  font-variant-numeric: tabular-nums;
}
```

Do not touch `100dvh`, desktop overflow, model-table max height, or
`overscroll-behavior: contain` here. Those move together in phase 5 so the wheel
proof validates one coherent geometry change.

### `docs-site/.../reference/configuration.md` — endpoint-specific auth

The English reference currently says, without an endpoint qualifier, that bearer
“is also accepted” (`docs-site/src/content/docs/reference/configuration.md:246-257`).
That is false for Responses and Chat Completions.

Before:

```md
Clients must include the token in every request via the
`x-opencodex-api-key` header:

...

An `Authorization: Bearer …` header is also accepted. Dashboard-generated `apiKeys` may be used in
place of the environment token after startup...
```

After:

```md
Clients can use `x-opencodex-api-key` for every data-plane endpoint:

...

Header acceptance is endpoint-specific. `/v1/responses` and `/v1/chat/completions`
require `x-opencodex-api-key`; `/v1/models` and `/v1/messages` also accept
`Authorization: Bearer …` and `x-api-key`. Dashboard-generated `apiKeys` may be
used in place of the environment token after startup...
```

Apply the same semantic correction to the existing Korean
(`ko/reference/configuration.md:138-149`), Japanese (`ja/...:131-142`), and Russian
(`ru/...:161-172`) translations. Do not alter provider-side `apiKeyTransport`; that
table describes outbound adapter auth and is unrelated (`configuration.md:301-307`).

## i18n contract

English is the source of truth (`gui/src/i18n/en.ts:1255-1328`). Add the following
keys with these exact English strings, then translate them in `ko`, `ja`, `zh`,
`de`, and `ru` in the same patch:

| Key | English source |
|-----|----------------|
| `api.auth.title` | `Authentication by endpoint` |
| `api.auth.endpoint` | `Endpoint` |
| `api.auth.required` | `Required` |
| `api.auth.accepted` | `Accepted` |
| `api.auth.rejected` | `Not accepted` |
| `api.auth.loopback` | `Loopback binds (127.0.0.1 or ::1) bypass authentication.` |
| `api.auth.testProtocol` | `Test with {protocol}` |
| `api.auth.testing` | `Testing…` |
| `api.auth.testSucceeded` | `OK` |
| `api.auth.testFailed` | `Failed` |
| `api.auth.testNeedsFreshKey` | `Generate a new key and keep its one-time value visible to test authenticated requests.` |
| `api.key.details` | `Key details` |
| `api.key.name` | `Key name` |
| `api.key.prefix` | `Key prefix` |
| `api.key.rename` | `Rename` |
| `api.key.saveName` | `Save name` |
| `api.key.renaming` | `Saving…` |
| `api.key.renameFailed` | `Could not rename API key. Your draft was not discarded.` |
| `api.key.deleting` | `Deleting…` |
| `api.key.copyFailed` | `Could not copy the new API key. Select it and copy it manually before dismissing this panel.` |
| `api.attribution.title` | `Attributed usage` |
| `api.attribution.requests7d` | `Requests, last 7 days` |
| `api.attribution.totalRequests` | `Total attributed requests` |
| `api.attribution.lastUsed` | `Last used` |
| `api.attribution.since` | `Attribution available since` |
| `api.attribution.neverUsed` | `Not used since attribution began` |
| `api.attribution.unavailable` | `Usage unavailable` |
| `api.attribution.unavailableDetail` | `This key has no attribution data. Requests recorded before attribution began cannot be assigned retroactively.` |
| `api.attribution.railRequests` | `{count} requests / 7d` |
| `api.attribution.railLastUsed` | `Last used {date}` |
| `api.attribution.railNeverUsed` | `Not used since tracking began` |
| `api.attribution.ambiguous` | `Two keys share this ID, so usage cannot be attributed to one of them. Give each key a unique ID in the config file.` |
| `api.attribution.railAmbiguous` | `Usage ambiguous — duplicate ID` |

Modify existing `api.subtitle` from the two-placeholder blanket rule at
`en.ts:1256` to:

```text
Use generated API keys to access the opencodex proxy from external apps. Authentication requirements vary by endpoint.
```

Delete the now-unused prose keys from every locale after the JSX no longer refers to
them: `api.authTitle`, `api.authResponses`, `api.authChatCompletions`,
`api.authMessages`, `api.authLoopback`, and `api.authBaseUrlNote`. Also delete the
superseded unnamespaced model-result keys `api.testModel`, `api.testingModel`,
`api.testSucceeded`, and `api.testFailed`. Keep protocol labels and technical sample
strings. Phase 5's full-key parity test catches a six-locale omission.

## Tests

### `gui/tests/apikeys-actions.test.tsx` (NEW)

Mount the real `ApiKeys` page under `LanguageProvider`, following the happy-dom and
fetch-stub setup in `apikeys-refresh-preserve.test.tsx:65-103`. The GET fixture must
carry two keys with distinct usage and all four matrix rows. Capture every fetch
URL, method, headers, and parsed body.

| # | Activation scenario | Observable proof |
|---|---------------------|------------------|
| 1 | Click Rename, change the selected key name, submit PATCH | captured `PATCH /api/keys` body is `{id,name}`; input stays mounted/disabled until the deferred response resolves; next GET supplies the new heading |
| 2 | Reject PATCH with 500 | detail and typed draft remain; `api.key.renameFailed` renders; no key material appears in PATCH or error UI |
| 3 | Generate a key, click the Responses chip | fetch targets `endpoints.responses`, body has `input` + `max_output_tokens`, and header equals the one-time key |
| 4 | Click Chat Completions | fetch targets `endpoints.chatCompletions`, body has `messages` + `max_tokens`; only the Chat chip gets the pending/result badge |
| 5 | Click Messages | fetch targets `endpoints.messages`, body has Messages JSON; Responses/Chat state is unchanged |
| 6 | Render with existing masked keys but no visible `newKey` | every protocol test chip is disabled and the fresh-key explanation is visible; no data-plane fetch occurs |
| 7 | Return a malformed/missing `authMatrix` | keys resource enters its existing failed-cold/last-good path; no hardcoded auth rows render |
| 8 | `KEYS_OK` (zero usage, `attributionSince` present) vs `KEYS_NO_ATTRIBUTION` (zero usage, no `attributionSince`) | first renders a literal `0` and never-used copy; second renders `api.attribution.unavailable`. Proves the branch is on the dataset field, not on `usage` |
| 9 | A key row whose `usage` is `{ ambiguous: true }` | rail shows `api.attribution.railAmbiguous`, detail shows `api.attribution.ambiguous`, and **no** number is rendered for that key |
| 10 | Reload from the session cache (no network) | attribution still renders; `attributionSince` survived `CachedKeysShape`, so a cached load does not degrade to unavailable |
| 11 | Stub `navigator.clipboard.writeText` to reject, then click Copy on the one-time key | `api.key.copyFailed` renders, Copied never renders, and the full secret is still selectable in the DOM |
| 12 | Run a protocol test through testing → OK and testing → failure | the changing badge carries `role=status`, `aria-live=polite`, and belongs only to the chosen chip |
| 13 | Render the create form and open the rename form | both inputs expose `maxLength === 64` |

Scenarios 3–5 are the activation proof for W2/W3. A generic 200 fetch stub is not
enough: each test asserts protocol-specific URL, payload discriminator, and the
`x-opencodex-api-key` header.

Scenario 8 is the activation proof for the zero-vs-unavailable distinction — it
fails against any implementation that branches on `usage` being absent, since
`usage` is present in both fixtures. Scenario 9 is what stops `ambiguous` from
being a marker nobody reads, and 10 is what catches `attributionSince` being
copied into the fetch path but not into the cache shape.

### Existing test changes

- `apikeys-workspace.test.tsx:15-18` gives each fixture realistic `usage`; rail
  assertions prove prefix is absent there and present in detail.
- Replace the synchronous delete test at `apikeys-workspace.test.tsx:150-173` with
  a deferred promise. While unresolved, detail remains and Confirm is disabled;
  `false` retains detail/confirmation, `true` alone returns to Overview. This is the
  activation scenario for W12.
- Add a rename failure test that asserts draft preservation, not merely callback
  invocation.
- Update `apikeys-refresh-preserve.test.tsx:47-63` to v2 fixtures with `usage` and
  `authMatrix`; preserve its last-good assertions after create/delete.
- Replace auth-fold source assertions at `apikeys-layout.test.ts:55-75` with checks
  for `ApiAuthMatrix`, absence of `<details className="awi-inline-fold">`, and exact
  Manage → Endpoints → Usage source order. That order guard protects coordination
  with `260731_client_config_export`.
- Keep `api-access-models.test.ts:49-53` exact-list assertions and import the named
  protocol type in a compile-visible assignment.

Exact anchors for those MODIFY sites:

`gui/tests/api-access-models.test.ts:49-53`, before:

```ts
describe("gatewayInboundProtocols", () => {
  test("lists gateway protocols and hides Messages when Claude inbound is off", () => {
    expect(gatewayInboundProtocols(true)).toEqual(["responses", "chat", "messages"]);
    expect(gatewayInboundProtocols(false)).toEqual(["responses", "chat"]);
  });
});
```

After:

```ts
describe("gatewayInboundProtocols", () => {
  test("lists typed gateway protocols and hides Messages when Claude inbound is off", () => {
    const all: GatewayInboundProtocol[] = gatewayInboundProtocols(true);
    expect(all).toEqual(["responses", "chat", "messages"]);
    expect(gatewayInboundProtocols(false)).toEqual(["responses", "chat"]);
  });
});
```

`gui/tests/apikeys-layout.test.ts:68-75`, before:

```ts
expect(src).toContain('awi-usage-fold');
expect(src).toContain('t("api.workspace.usageExamples")');
// Auth lives folded under Endpoints — not a separate overview card.
expect(workspace).not.toContain("api-auth-list");
expect(src).toContain('awi-inline-fold');
expect(src).toContain('t("api.authTitle")');
expect(src).toContain('t("api.authChatCompletions")');
```

After:

```ts
expect(src).toContain('awi-usage-fold'); // phase 5 opens usage, not this phase
expect(src).toContain('t("api.workspace.usageExamples")');
expect(src).toContain("ApiAuthMatrix");
expect(src).toContain('t("api.auth.title")');
expect(src).not.toContain('className="awi-inline-fold"');
expect(src).not.toContain('t("api.authChatCompletions")');

const manage = workspace.indexOf("<ApiKeysManagePanel");
const endpoints = workspace.indexOf("<ApiKeysEndpointsPanel");
const usage = workspace.indexOf("<ApiKeysUsagePanel");
expect(manage).toBeLessThan(endpoints);
expect(endpoints).toBeLessThan(usage);
```

`gui/tests/apikeys-workspace.test.tsx:150-173`, before:

```ts
const deleted: string[] = [];
const { root, container } = await mountWorkspace({
  onDelete: (id) => { deleted.push(id); },
});
// select, arm, click Confirm
expect(deleted).toEqual(["k2"]);
expect(container.textContent).toContain("Generate key");
expect(container.textContent).not.toContain("Key details");
```

After uses a controllable promise, not a synchronous spy:

```ts
let resolveDelete!: (value: boolean) => void;
const onDelete = () => new Promise<boolean>(resolve => { resolveDelete = resolve; });
const { root, container } = await mountWorkspace({ onDelete });
// select, arm, click Confirm
expect(container.textContent).toContain("Key details");
expect(confirmButton(container).disabled).toBe(true);

await act(async () => resolveDelete(false));
expect(container.textContent).toContain("Key details");

// re-arm, defer again, then resolve true
await act(async () => resolveDelete(true));
expect(container.textContent).toContain("Generate key");
expect(container.textContent).not.toContain("Key details");
```

Split false and true into separate tests if one resolver per test is clearer; the
required observations are pending retention, false retention, and true navigation.

`gui/tests/apikeys-refresh-preserve.test.tsx:47-63`, before:

```ts
const EXISTING_KEY = {
  id: "key-1",
  name: "existing-key",
  prefix: "ocx_exist",
  createdAt: "2026-01-15T12:00:00.000Z",
};

const KEYS_OK = {
  keys: [EXISTING_KEY],
  // endpoint fields
  claudeCodeEnabled: true,
};
```

After:

```ts
const EXISTING_KEY = {
  id: "key-1",
  name: "existing-key",
  prefix: "ocx_data_12345678...",
  createdAt: "2026-01-15T12:00:00.000Z",
  usage: {
    requests7d: 3,
    totalRequests: 8,
    lastUsedAt: "2026-07-30T12:00:00.000Z",
  },
};

const KEYS_OK = {
  keys: [EXISTING_KEY],
  // Dataset-level, not per key.
  attributionSince: "2026-07-20T00:00:00.000Z",
  // unchanged endpoint fields
  claudeCodeEnabled: true,
  authMatrix: AUTH_MATRIX,
};
```

A second fixture, `KEYS_NO_ATTRIBUTION`, carries the same keys with
`usage: { requests7d: 0, totalRequests: 0 }` and **no** top-level
`attributionSince`. That pair is what separates "used zero times" from "nothing
is attributable yet"; criterion 3 drives both.

Define `AUTH_MATRIX` once in the test with all four endpoints and mixed values. Do
not hide missing fixture updates by making `authMatrix` optional in production.

## Accept criteria

1. The phase begins by reconciling this assumed payload with the actual `030`
   implementation. **Activation:** review the shipped route type and direct route
   fixture; observable is one GUI type matching its exact names/semantics, with no
   compatibility mapping.
2. The rail compares keys by name, seven-day requests, and last used; prefix exists
   only in detail. **Activation:** render two fixture keys with different counters
   and dates; observable is distinct rail text and prefix absence from both rail
   buttons.
3. Zero usage and unavailable attribution render differently. **Activation:**
   render `KEYS_OK` (a key with `requests7d: 0` under a present
   `attributionSince`) and `KEYS_NO_ATTRIBUTION` (same zeroes, no
   `attributionSince`); observable is a literal zero plus never-used copy in the
   first, and `api.attribution.unavailable` plus the retroactivity explanation in
   the second. `usage` is always present in both, so a test that branches on its
   absence proves nothing.
4. Rename is pessimistic and failure-preserving. **Activation:** deferred PATCH then
   500 scenarios above; observable is disabled pending form followed by the same
   draft and selected key after failure.
5. Delete never navigates before the request resolves. **Activation:** defer DELETE;
   observable is selected detail while pending, retained detail on `false`, and
   Overview only after `true`.
6. The auth matrix is open, server-ordered, and server-valued. **Activation:** return
   a deliberately non-default row order and mixed dispositions; observable DOM rows
   match the fixture exactly and contain no `<details>` ancestor.
7. Every protocol test sends the one-time key in `x-opencodex-api-key`, targets the
   selected endpoint with that protocol's body, and updates only the chosen chip.
   **Activation:** scenarios 3–5; observable is captured request plus chip-local
   badge.
8. A masked existing key cannot trigger a fake auth test. **Activation:** scenario 6;
   observable is disabled chips, explanatory text, and zero data-plane calls.
9. The GUI and docs no longer claim bearer works on Responses or Chat Completions.
   **Activation:** source assertions over the six GUI locales and four existing
   configuration references; observable is endpoint-qualified wording and absence
   of the old blanket sentences.
10. All new visible strings exist in `en`, `ko`, `ja`, `zh`, `de`, and `ru`.
    **Activation:** TypeScript plus phase 5's full `api.*` key parity test; observable
    is identical key sets.
11. Duplicate-id usage renders as ambiguity, never as a number. **Activation:**
    scenario 9; observable is the ambiguous copy in rail and detail and the absence
    of any request count for that key.
12. Clipboard rejection never reports success and never destroys the one-time key.
    **Activation:** scenario 11; observable is the failure copy, no Copied state,
    and the secret still selectable.
13. A finished protocol test announces itself from its own chip. **Activation:**
    scenario 12; observable is chip-local `role=status`/`aria-live=polite` with no
    row-global result stealing another protocol's state.
14. Neither key-name input accepts more than the server's 64-character maximum.
    **Activation:** scenario 13; observable is `maxLength === 64` on both.
15. C-RENDER-GROUNDING-01 at **1280x720**: run the GUI against a fixture with four
    keys (used, never-used, unattributable, long German name), all matrix rows, and
    at least one model. Open each detail, edit a name, and run one protocol test.
    Capture and read back screenshots of Overview, attributed detail, unavailable
    detail, rename pending, and protocol result. Observable proof: no clipped matrix
    columns or action labels, prefix is detail-only, badge touches the selected chip,
    focus is visible, and no horizontal page overflow. Record screenshot paths in
    the phase evidence; static JSX/CSS inspection does not satisfy this criterion.
16. Focused gates are green: `cd gui && bun test tests/apikeys-actions.test.tsx
    tests/apikeys-workspace.test.tsx tests/apikeys-refresh-preserve.test.tsx
    tests/apikeys-layout.test.ts tests/api-access-models.test.ts`, then
    `bun run lint`, `bun run lint:i18n`, and `bun run build`. Run the docs build or
    its existing focused content gate for the four configuration edits. Do not call
    the repository-wide suite completion evidence for this GUI phase.

## Risk

The privacy boundary is the main implementation trap. The model test needs a real
secret, but GET intentionally returns only a prefix. Using `newKey` limits testing to
the one-time reveal window; that is less convenient than testing any row, but every
alternative either sends a non-secret prefix, exposes stored key material, or adds a
new privileged endpoint. None is acceptable in this unit.

The second risk is an apparently harmless matrix default. An empty or hardcoded
fallback would make the GUI render cleanly while server truth is absent—the same
failure class this phase exists to remove. Invalid/missing matrix data therefore
uses the existing retryable resource failure path.
