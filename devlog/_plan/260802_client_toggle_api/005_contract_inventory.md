# 005 — Contract inventory (implementation baseline)

Research only. Captured 2026-08-02 against `dev` by two read-only research
lanes plus local probes. Every decade doc (010+) plans against THESE
signatures; a later cycle's P re-verifies them before building
(LOOP-CONTINUITY-01).

## 1. Export core — `src/clients/config-export.ts`

```ts
export type ExportClientId = "opencode" | "pi";

export interface ExportClientSpec {
  id: ExportClientId;
  filename: string;
  destination: (env: NodeJS.ProcessEnv) => string;
  apiKeyEnv: string;
  exportHint: string;
  build: (ctx: ExportContext) => unknown;
}

export interface ExportContext {
  baseUrl: string;
  models: readonly ExportModel[];
  config?: OcxConfig;
}

export interface ExportModel {
  namespaced: string; provider: string; id: string;
  native?: boolean; displayName?: string;
  contextWindow?: number; inputModalities?: string[];
}
```

Key facts that constrain WP1:

- The spec has **no** `format`, `mediaType`, or `serialize` field. `build`
  returns `unknown` and every consumer assumes JSON-serializable.
- `normalizeExportModels` dedupes by `namespaced` (first wins) then sorts
  ascending — the byte-stability guarantee.
- Constants: `OPENCODE_PROVIDER_ID = "opencodex"`, `OPENCODE_API_KEY_ENV`,
  `OPENCODE_API_KEY_ENV_REF = "{env:...}"`, `PI_API_KEY_ENV`,
  `PI_API_KEY_ENV_REF = "$..."`, `SCHEMA_REQUIRED_OUTPUT_BUDGET = 32_000`.

### Consumers that break if `build` stops returning JSON

| Consumer | Line | Assumption |
|---|---|---|
| `src/cli/export-command.ts` | :159, :167 | `JSON.stringify(clientConfig, null, 2)` is the canonical text |
| `src/server/management/model-routes.ts` | :267, :276 | document embeds directly in the JSON envelope |
| `summarizeExportedModels` | model-routes.ts:200 | two-client branch; **every non-OpenCode client is assumed to be Pi** |
| `gui/.../ClientConfigRow.tsx` | :80 | `JSON.stringify(data.config, null, 2)` |
| `gui/.../ClientConfigPanel.tsx` | :77 | download MIME hard-coded `application/json` |
| `gui/.../client-config-clients.ts` | :11 | `CLIENTS = ["opencode", "pi"]` hand-synced tuple |
| `tests/client-config-export.test.ts` | :223, :243, :283 | byte tests via `JSON.stringify`; exact-two-client registry assertion |

`src/cli/opencode.ts:44` re-exports the OpenCode constants/provider-block
builder; it never calls `buildClientConfig`. WP1 must not break that surface.

## 2. Serialization capability (local probe, Bun 1.3.14)

| Format | parse | stringify |
|---|---|---|
| JSON | native | native |
| YAML | `Bun.YAML.parse` | `Bun.YAML.stringify` |
| TOML | `Bun.TOML.parse` | **MISSING** |
| JSON5 | `Bun.JSON5.parse` | `Bun.JSON5.stringify` |

No `yaml`/`toml`/`json5` npm dependency exists and none is needed — **except
a TOML serializer**. This is the single hardest constraint in the roadmap and
it lands on Kimi Code (`config.toml`). Grok solves the same problem by
**hand-rendering** its TOML block (`buildGrokManagedBlock`), which is the
precedent WP1 follows: emit a narrow, hand-rendered TOML fragment for the
fields we own rather than round-tripping a whole document.

## 3. Writer precedents

### Managed fence — `src/grok/inject.ts`

- Private markers, duplicated verbatim in `src/grok/status.ts`:
  `# >>> opencodex managed block — do not edit (removed by \`ocx stop\`) >>>`
  / `# <<< opencodex managed block <<<`.
- `findManagedRegion` → `{ start, end, orphaned }`; begin-without-end is
  `orphaned: true` and **both inject and strip refuse to mutate**.
- Ownership signals for adopting a pre-fence table: plain table header,
  `api_key === "opencodex-loopback"`, loopback `base_url`.
- Backup is **backup-once** via `COPYFILE_EXCL` →
  `config.toml.bak-opencodex`.
- Non-loopback: strips any stale block, returns
  `{ ok: true, skippedReason: "non-loopback" }` — a policy skip, not an error.
- Reader (`readGrokStatus`) treats an orphaned begin marker as `present:false`,
  while the writer treats it as a refusal. **Asymmetry noted; the new
  ownership core must not copy it** (003 §3 `unsafe` state exists for this).

### Provenance sidecar — `src/claude/desktop-3p.ts`

- `_meta.json` with `appliedId` + `entries[]`, unknown fields preserved by
  spread; entry matched by `name === "opencodex"`.
- Fingerprint: `sha256(pretty JSON + "\n").slice(0, 16)`.
- `atomicReplaceDesktopConfig(path, content, writer = atomicWriteFile)` copies
  `${path}.bak` **on every replacement** (not once), then writes.
- Metadata-write failure restores `.bak`; a brand-new config with no backup has
  **no deletion rollback**.

### Atomic write — `src/config.ts`

```ts
export function atomicWriteFile(path: string, content: string, io?: AtomicWriteIO): void
export function renameAtomicFile(source: string, destination: string, io?): void
export async function atomicWriteFileAsync(path: string, content: string, io?): Promise<void>
export class AtomicWriteResidualTempError extends Error {}
export class AtomicWriteSecretResidualError extends Error {}
```

- Temp + `0600` + harden (Windows ACL) + atomic rename; Windows
  `EBUSY`/`EPERM`/`EACCES` retried at 25 ms then 50 ms, third throws.
- **Does not create the parent directory** — the integration writer must.
- Calls `recordOwnedConfigPath(resolveConfigDir(), path)`, which returns
  `false` for any path outside the opencodex config dir. Third-party client
  configs are therefore written atomically but never enter the uninstall
  manifest — correct, and the new writer must not try to change that.

## 4. Management API contract

- Router: `handleManagementAPI` (src/server/management-api.ts:84) dispatches a
  fixed `??` chain of `handleXRoutes(ctx)` (`:127`); a new module needs an
  import at `:60-68` and a slot in the chain. No auto-discovery.
- `ManagementContext = { req, url, config, deps, refreshCodexCatalogBestEffort,
  syncClaudeAgentDefsBestEffort }` (management/context.ts:24).
- Body: `readManagementJsonBody` (4 MiB) + `rethrowManagementBodyTooLarge`;
  the outer router rejects declared `Content-Length > 2 MiB` and maps
  decompressed overflow to 413.
- Auth happens **before** dispatch (src/server/index.ts:448). A mutating
  GUI-session request must carry the session token, `X-OpenCodex-GUI-Origin`,
  a matching browser `Origin`, and `X-OpenCodex-CSRF-Token`; admin-token
  callers skip CSRF. Route modules never call `requireManagementAuth`.
- Grok single-flight precedent: join < 120 s, `409 grok_apply_busy` up to
  10 min, then the stale flight is replaced. **Claude Desktop apply has no
  single-flight** — WP4 adopts the Grok pattern, not the Desktop gap.

## 5. GUI contract

- `Page` union + `VALID_PAGES` (gui/src/app-routing.ts:5-34);
  `readPageFromHash` takes the first hash segment.
- **Nested suffixes must be registered** in `hashBelongsToPage` (:52-66) or
  they are replaced away. Existing registered suffixes: `logs/debug`,
  `dashboard/providers`, `dashboard/models`, `dashboard/update`.
- `PAGE_TKEY: Record<Page, TKey>` (App.tsx:31) — adding a page is a
  compile-time obligation for a translation key.
- Passive rewrite `replaceHash` vs deliberate `navigateHash`
  (gui/src/hash-routing.ts:12, :24).
- `.page-tabs` **wraps** (`flex-wrap: wrap`, `overflow: visible`,
  styles.css:417) — confirms 004 §3.2's wrap-not-scroll decision.
- Logs tab mechanics: `readTabFromHash`/`selectLogsTab`
  (pages/logs-tab-keydown.ts:3-23), lazy mount, `active`-gated polls, full
  ARIA tablist. Claude uses local state + `preventScroll` focus, `.claude-tabs`.
- i18n: `TKey = keyof typeof en`; six locales (`en, de, ko, zh, ru, ja`) each
  `Record<TKey, string>` — a new key is a six-file obligation.
- Tests: `gui/tests` runs under `cd gui && bun test tests` and is **not** part
  of root `bun run test` (scripts/test.ts targets `./tests/`).
  `bun run lint:gui` = `cd gui && eslint .`, ignoring tests and `src/i18n/**`.

## 6. Test conventions

- `bun:test` imports; temp roots via `mkdtempSync(join(tmpdir(), "ocx-..."))`
  with `rmSync` cleanup in `afterEach`/`finally` (no shared helper).
- `tests/helpers/isolated-codex-home.ts` is the only related helper
  (`installIsolatedCodexHome`).
- Nearest suites to extend: `tests/client-config-export.test.ts`,
  `tests/grok-config-inject.test.ts`, `tests/desktop-3p.test.ts`,
  `tests/management-client-config-route.test.ts`,
  `tests/cli-export-command.test.ts`.

## 7. Decisions forced by this inventory

1. **Registry gains a format/serializer axis** rather than a second parallel
   registry (WP1). `summarizeExportedModels`' "non-OpenCode means Pi" branch
   must die in the same change.
2. **TOML output is hand-rendered**, Grok-style, scoped to our own fields.
   No TOML round-trip, no new dependency.
3. **Ownership is fingerprint-based** with its own journal (WP2/WP3), not the
   Grok fence-only model, because disable must distinguish `stale` from
   `conflict` (003 §3).
4. **The integration writer creates its parent directory** before
   `atomicWriteFile`, and never expects `recordOwnedConfigPath` to accept a
   third-party path.
5. **New route module adopts Grok single-flight** and the bounded-body helper
   (not the Desktop precedent, which lacks both).
6. **GUI sub-tab hashes are explicitly registered**; the strip wraps.
