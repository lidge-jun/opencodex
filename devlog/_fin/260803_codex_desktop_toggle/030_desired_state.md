# WP4 — Codex desired state and ownership-safe convergence

Research: `003_durable_desired_state.md`. Re-scope authority:
`006_audit_synthesis_r2.md`. This document replaces the failed ten-client
version of WP4.

The failure to prevent is concrete: a user persists Codex OFF, the process dies
before native restore finishes, and the next `ocx start` writes OpenCodex routing
back because `syncModelsToCodex` is unconditional (`src/cli/index.ts:318-320`,
`src/codex/sync.ts:49-110`). The first repair made that worse: startup
reconciliation called the native remover without checking service ownership, so
a start from a different `OPENCODEX_HOME` could strip Codex state used by the
installed service (`006_audit_synthesis_r2.md`, round 2 #2).

Audit round 4 found the same incident still possible in the proposed fix
(`007_audit_synthesis_wp4.md`, #1-#3). A fresh authority read was only a check,
not a lock: OFF could commit through the separate config lock after an apply read
ON and before `atomicWriteFile`. Startup also repaired the journal before proving
ownership, and the proposed lock created a file inside the foreign `CODEX_HOME`
before that proof. Finally, restore omitted `models_cache.json`, so a reported OFF
could still advertise routed slugs. This revision replaces those mechanisms
plainly; it does not describe the prior re-read design as sufficient.

That incident decides the scope. The two phases that shipped cleanly each changed
one thing at one boundary (`010_modality_boundary.md`, `020_api_keys_row.md`). WP4
therefore changes desired state for **Codex only**. It does not establish a
cross-client contract.

## What exists, and what WP4 adds

Already present:

- `mutatePersistedConfig` clones and rebases a callback under the config mutation
  lock, then returns `committed | unchanged | unavailable`; callers do not need a
  second persistence mechanism (`src/config.ts:1957`).
- `syncModelsToCodex` owns the normal catalog-plus-injection path
  (`src/codex/sync.ts:49-129`), while provider/model/combo routes bypass it through
  `refreshCodexCatalogBestEffort` (`src/server/management-api.ts:105-112`).
- `restoreNativeCodex` is the idempotent Codex remover
  (`src/codex/inject.ts:820`), and `assertNativeTeardownOwned` is the shipped
  foreign-home preflight (`src/integrations/native/ownership-preflight.ts:19-35`).
- crash-journal reconciliation already repairs an abandoned injection
  (`src/codex/journal.ts:148-162`).

WP4 adds one persisted Codex flag and takes its per-`CODEX_HOME` linearization from
WP12's public N acquisition API (`src/codex/codex-write-lock.ts`), which covers both
desired-state commits and bounded native commit sections. **It does not build a
second lock** — see the supersession note below. Provider model gathering stays
outside the lock. Ownership is tri-state and is resolved
before journal repair or lock creation, then rechecked inside the lock. OFF
reconciliation restores config, profile, catalog, cache, and history at start and
ensure. WP5 adds the management route and GUI switch that call the writer; WP4
defines the writer failures WP5 must map but not WP5's full response schema.

## IN / OUT

| Path | Change | Why it is in WP4 |
|---|---|---|
| `src/types.ts` | MODIFY | Adds a one-key `OcxClientIntegrationsConfig` and its optional `OcxConfig.clientIntegrations` home. |
| `src/config.ts` | MODIFY | Parses the Codex key, resolves absent as ON, and mutates only that field through `mutatePersistedConfig`; documents its thrown lock branch. |
| `src/codex/desired-state.ts` | NEW | Owns test seams, the tri-state ownership gate, the owned restore wrapper, observed-state inspection, and OFF reconciliation. **Not** the linearization lock: that is WP12's public N API. |
| `src/codex/sync.ts` | MODIFY | Separates model gathering from the bounded apply commit and returns `ok:false` plus `skippedReason` for every no-write result. |
| `src/codex/refresh.ts` | MODIFY | Splits gathered catalog data from the bounded catalog/cache commit used outside `syncModelsToCodex`. |
| `src/codex/catalog/sync.ts` | MODIFY | Commits catalog/cache only while holding the shared linearization lock; restores or invalidates `models_cache.json` during native removal. |
| `src/codex/catalog/bundled.ts` | MODIFY | Moves fallback materialization into the bounded native commit section. |
| `src/codex/catalog/parsing.ts` | MODIFY | Stops replacing the shared legacy backup after a target-hashed backup exists. |
| `src/codex/inject.ts` | MODIFY | Moves every config/profile/journal/history write into one bounded commit callback and makes the unchecked remover internal to the owned wrapper. |
| `src/server/management-api.ts` | MODIFY | Gives provider/model/combo refreshes their own Codex gate and routes `/api/stop` through the owned remover. |
| `src/server/management/config-routes.ts` | MODIFY | Makes `POST /api/sync` report an intentional desired-OFF skip instead of false success. |
| `src/cli/index.ts` | MODIFY | Resolves ownership before journal repair, reconciles OFF, refuses explicit sync while OFF, makes `restore back` an explicit enable, and routes every remover through the owned lock. |
| `src/cli/init.ts` | MODIFY | May establish ON after its separate injection prompt, then uses the same linearized apply operation. |
| `src/cli/provider.ts`, `src/cli/models.ts` | MODIFY | Inspect typed sync skips so provider/model mutations do not claim Codex refresh success while OFF. |
| `src/service.ts` | MODIFY | Exposes tri-state ownership diagnostics and routes service stop/uninstall removers through the same per-home lock without changing desired state. |
| `tests/codex-desired-state.test.ts` | NEW | Pins schema defaulting, field-scoped persistence, auth-sentinel isolation, and unavailable/conflict behavior. |
| `tests/codex-desired-state-race.test.ts` | NEW | Pins post-approval OFF, crash-point convergence, linearization, and foreign/unknown refusal. |
| `tests/codex-sync-api.test.ts` | MODIFY | Pins sync and `POST /api/sync` OFF semantics. |
| `tests/codex-inject-integration.test.ts` | MODIFY | Pins locked commit boundaries and the owned native remover. |
| `tests/codex-journal.test.ts` | MODIFY | Proves journal repair still runs while desired Codex state is OFF. |
| `tests/codex-catalog-restore.test.ts`, `tests/codex-models-cache-invalidate.test.ts` | MODIFY | Pin cache cleanup and two-home backup isolation. |
| `tests/cli-restore-back.test.ts`, `tests/cli-provider.test.ts`, `tests/startup-prompt.test.ts` | MODIFY | Pin every CLI caller's OFF or explicit-enable meaning. |
| `tests/cli-models-desired-state.test.ts` | NEW | Pins custom-model save plus honest Codex-refresh skip while OFF. |
| `tests/cli-init-desired-state.test.ts` | NEW | Pins fresh init plus affirmative/negative injection prompt semantics. |
| `tests/service.test.ts`, `tests/uninstall.test.ts` | MODIFY | Proves owned teardown remains unconditional with respect to desired ON/OFF. |
| `tests/server-auth.test.ts` | MODIFY | Proves Codex OFF does not gate the shared `/v1/responses` transport. |
| `docs-site/src/content/docs/reference/cli/lifecycle.md` | MODIFY | Documents start/ensure/sync OFF behavior and `restore back` as explicit enable. |
| `docs-site/src/content/docs/reference/configuration.md` | MODIFY | Documents `clientIntegrations.codex`, absent-means-ON, and desired versus observed state. |

OUT, deliberately:

| Path / surface | Disposition |
|---|---|
| `src/server/claude-messages.ts`, `src/server/index.ts`, `src/cli/claude.ts`, `src/claude/agents-inject.ts`, `src/server/system-env.ts` | **Dropped from WP4.** Round 1 #1 established `claudeCode.enabled` as the shipped Claude Code kill switch. WP4 neither changes it nor routes it through a helper. |
| `src/integrations/state.ts`, `src/integrations/writer.ts`, `src/server/management/integration-routes.ts`, `src/cli/opencode.ts` | **Moved out.** The six file clients are `FOLLOWUP-FILECLIENT-01`; this removes the old gates, writer changes, mutating GET, and migration claims rejected by round 2 #4/#5. |
| `src/grok/**`, Grok routes | **Moved to WP6.** Grok will add its own key and prove its own callers after the Codex shape passes. |
| `src/claude/desktop-3p.ts`, Desktop routes | **Moved to WP7.** Desktop keeps its separate ownership/profile questions. |
| `src/server/management/native-integration-routes.ts`, `gui/` | **Moved to WP5.** WP5 owns the Codex route, GUI parser, and UI contract. WP4 does not define a `codex | claude | claude-desktop | grok` union or `desiredEnabled` response schema. |
| desired-OFF refusal in `ocx init` | **Not added. INFERRED:** init writes a fresh config and asks separately before injection, so accepting that prompt may establish Codex ON. It still participates in the same linearization lock. |
| `/v1/responses` | Never gated. It is a shared transport used by clients other than native Codex. |
| releases, publishing, deploys, tags, repository starring | No delivery or identity action belongs in this phase. |

English lifecycle and configuration pages are canonical (`docs-site/AGENTS.md:5-10`).
The corresponding `ko`, `ja`, `zh-cn`, and `ru` pages must be updated in the same
implementation phase or left without a contradictory promise; unconditional
start/ensure/sync/restore-back wording may not survive in a translated locale.

## The flag: one key in an extension-safe object

Use a map-shaped object with **one key today**, not a top-level `codexEnabled`
field and not the prior ten-key union. A top-level field would force WP6 and WP7
to invent unrelated names and helpers; a ten-key type would recreate the coupling
that failed two audits. A one-key object preserves the upgrade-safe extension
point while making WP4 incapable of claiming ownership over another client.

MODIFY `src/types.ts` immediately before `OcxConfig` (current
`src/types.ts:521-533`) and place the field beside `claudeCode`
(`src/types.ts:533-545`):

```diff
 export interface OcxApiKeyEntry {
   id: string;
   name: string;
   key: string;
   createdAt: string;
 }

+export interface OcxClientIntegrationsConfig {
+  /** Durable desired state for native Codex. Missing means ON. */
+  codex?: boolean;
+}

 export interface OcxConfig {
```

```diff
   /** Claude Code inbound + launcher settings. */
   claudeCode?: OcxClaudeCodeConfig;
+  /** Per-client durable intent. WP4 owns only `codex`; later phases extend one key at a time. */
+  clientIntegrations?: OcxClientIntegrationsConfig;
```

MODIFY `src/config.ts` after `apiKeyEntrySchema`
(`src/config.ts:909-918`). The nested schema stays `.passthrough()` so a binary
from WP4 does not erase a later WP6/WP7 key during a field-scoped mutation.

```diff
   name: z.string().catch(""),
   createdAt: z.string().catch(""),
 }).passthrough();

+const clientIntegrationsSchema = z.object({
+  codex: z.boolean().optional().catch(undefined),
+}).passthrough();

 const configSchema = z.object({
```

```diff
   googleAntigravityStaticCatalogVersion: z.literal(1).optional().catch(undefined),
+  clientIntegrations: clientIntegrationsSchema.optional().catch(undefined),
   providerContextCaps: z.record(z.string(), z.number().int().positive()).optional(),
```

Effective state is `config.clientIntegrations?.codex !== false`. Missing object,
missing key, and explicit `true` all mean ON. A malformed hand edit such as
`{ "codex": "false", "future-client": false }` degrades only `codex` to absent/ON
and preserves the unknown future key; it does not invalidate providers or create
another client's block.

## Field-scoped persistence and the auth sentinel

The real primitive is synchronous and callback-based
(`src/config.ts:1854-1856`):

```ts
export function mutatePersistedConfig<T>(
  mutate: (config: OcxConfig) => PersistedConfigMutation<T>,
): PersistedConfigMutationOutcome<T>;
```

Build the Codex writer directly on it after `websocketsEnabled`
(`src/config.ts:1909-1911`):

```diff
 export function websocketsEnabled(config: Pick<OcxConfig, "websockets">): boolean {
   return config.websockets === true;
 }

+export function codexDesiredEnabled(
+  config: Pick<OcxConfig, "clientIntegrations">,
+): boolean {
+  return config.clientIntegrations?.codex !== false;
+}
+
+export interface CodexDesiredMutationValue {
+  config: OcxConfig;
+  desiredEnabled: boolean;
+}
+
+export function mutateCodexDesiredEnabledUnlocked(
+  enabled: boolean,
+): PersistedConfigMutationOutcome<CodexDesiredMutationValue> {
+  return mutatePersistedConfig(config => {
+    if (config.clientIntegrations?.codex === enabled) {
+      return { changed: false, value: { config, desiredEnabled: enabled } };
+    }
+    config.clientIntegrations = { ...config.clientIntegrations, codex: enabled };
+    return { changed: true, value: { config, desiredEnabled: enabled } };
+  });
+}
```

The `Unlocked` suffix is deliberate: only `src/codex/desired-state.ts` may import
this primitive, and a source-shape assertion enforces that ownership. All
production callers use the locked setter below. Exporting a friendly-looking raw
setter would let the next caller recreate the separate-lock race this audit found.

Only the callback-local clone is mutated. A future WP5 route must use
`outcome.value.config` after `committed | unchanged`; it must never patch the
long-lived management `config` before persistence succeeds. `missing`, `invalid`,
and `conflict` leave both disk and the supplied live object unchanged.

The prior draft listed only the return union. That was insufficient because
`withConfigMutationLockSync` throws `ConfigMutationLockError` when SQLite lock
acquisition fails (`src/config.ts:1768-1793`); `unavailable` is the later
missing/invalid/rebase-exhaustion result (`src/config.ts:1830-1834,1859-1906`),
not contention. The Codex setter and every route/CLI caller handle four paths:

| Mutation result | Contract |
|---|---|
| `committed` | Copy `outcome.value.config` into the live object and continue. |
| `unchanged` | Copy the freshly loaded `outcome.value.config` into the live object and continue without a second native write. |
| `unavailable` | Non-retryable desired-state refusal (`missing`, `invalid`, or `conflict`); disk and live object stay unchanged. |
| thrown `ConfigMutationLockError` with `cause.code === "SQLITE_BUSY"` | Retryable busy: HTTP 409 `config_busy` (503 is also acceptable at a service boundary); CLI exits nonzero and says retry. |
| thrown `ConfigMutationLockError` with any other cause | Non-retryable `write_failed`; HTTP 500 and CLI exits nonzero. |

This follows the existing distinction at
`src/server/management/native-integration-routes.ts:144-161`, where mapping the
whole exception class to retryable would lie about an unopenable database.

Round 2 #1 is **unreachable for this Codex-only shape**. The mutation above writes
only the sibling `clientIntegrations` object. It never reads, spreads, creates, or
assigns `config.claudeCode`. `runClaudeAuthModeMigration` returns immediately when
that block is absent (`src/claude/auth-mode-migration.ts:16-20`) and is invoked on
startup only afterward (`src/server/index.ts:290-294`). Therefore a Codex flag
write cannot create the pre-upgrade sentinel condition. The test still runs the
real migration after OFF and ON mutations and asserts: no `claudeCode` block,
`runClaudeAuthModeMigration(...) === false`, and no persisted `authMode` or
`authModeMigratedAt`.

## One per-home linearization lock — a check is not a lock

> **SUPERSEDED (2026-08-05): do not build this lock. Consume WP12's N instead.**
>
> This section was written on 2026-08-04, before the write-substrate unit landed
> `src/codex/user-identity.ts` (`554b3919e`, 2026-08-05). Its diagnosis is right and
> its remedy is now a duplicate — a second, weaker per-home lock beside the one the
> other unit already owns:
>
> | This section proposes | What WP4 consumes instead |
> |---|---|
> | `withCodexHomeLinearizationLockSync` in a NEW `desired-state.ts` | the **public N acquisition API** in `src/codex/codex-write-lock.ts` (WP12). Not `openCodexCoordinatorTransaction` directly — that is N's lower layer, and calling it straight would bypass N's admission comparison, lock ordering, and refusal taxonomy. |
> | `join(tmpdir(), "opencodex-native-locks", sha256(home) + ".sqlite")` | `resolveCodexCoordinatorDatabasePath`, `src/codex/user-identity.ts:165`, which keys on the effective **uid/SID** as well as the canonical home |
> | `inspectNativeCodexOwnership()` here | `AdmissionSnapshot.ownership`, owned by WP12's admission producer |
>
> Hashing the home ALONE is the specific defect `005_contract.md` §7 exists to
> prevent, and the honest statement of it is that the outcome is **undetermined**,
> not that it splits or that it collides. The lock path would carry no proof of
> effective-user authority, so what actually happens depends on the temp root: a
> shared `/tmp` puts two OS users on one lock file (collision, or an access failure
> on the other's mode-0600 database), while a per-user or environment-controlled
> temp root splits one home across two lock files (no exclusion at all, silently).
> `os.homedir()` is environment-controlled under Bun 1.3.14 besides. WP12's
> resolver removes the ambiguity by encoding uid/SID directly.
>
> **Consequence for sequencing:** WP4 depends on WP12's lock, so it runs after it,
> not beside it. WP4 keeps everything below that is genuinely its own — the
> persisted flag, the gate at `src/cli/index.ts:319`, OFF reconciliation, and the
> startup ownership order — and takes its linearization from N. The analysis below
> is retained because it is *why* a lock is required at all; only the "NEW
> `src/codex/desired-state.ts` owns one linearization boundary" answer is withdrawn.

The previous design's bare re-read was insufficient. `syncModelsToCodex` can pause
in provider model gathering (`src/codex/sync.ts:83-108`), and even a re-read after
that pause leaves a check/write gap: another process can commit OFF through the
separate config mutation transaction before the apply reaches
`atomicWriteFile`. The several config/profile/journal/history writes at
`src/codex/inject.ts:524-603` have the same defect.

NEW `src/codex/desired-state.ts` owns the desired-state surface below. It does NOT
own the linearization boundary — that comes from WP12's public N acquisition API in
`src/codex/codex-write-lock.ts`, whose callback is already synchronous and already
holds `N -> C`. Everything from here to the end of this section is the ORIGINAL
2026-08-04 design, retained for its diagnosis; read the lock parts as history:

```ts
export type NativeCodexOwnership =
  | { state: "owned" }
  | { state: "foreign"; message: string }
  | { state: "unknown"; message: string };

export type CodexNativeWriteBoundary =
  | "journal" | "config" | "profile" | "journal-injected" | "history"
  | "catalog-backup" | "catalog" | "models-cache" | "remove";

export type CodexDesiredMutationResult =
  | { ok: true; status: "committed" | "unchanged"; config: OcxConfig }
  | { ok: false; reason: "missing" | "invalid" | "conflict" | "config_busy" | "write_failed";
      retryable: boolean; message: string };

export interface CodexReconcileResult {
  trigger: "startup" | "ensure";
  desiredEnabled: boolean;
  observedState: "absent" | "applied" | "conflict" | "unavailable";
  resolved: boolean;
  reason?: "home_mismatch" | "ownership_unknown" | "history_locked"
    | "write_failed" | "codex_write_busy";
  message: string;
}

export function inspectNativeCodexOwnership(): NativeCodexOwnership;
// SUPERSEDED — WP4 does not declare this. Linearization comes from WP12's public
// N acquisition API in `src/codex/codex-write-lock.ts`, whose callback is already
// synchronous and already holds N -> C. Declaring a second per-home lock here
// would key on sha256(home) without the uid/SID, so the lock path would carry no
// proof of which account it belongs to and the failure would be environment-
// dependent: a shared temp root collides, a per-user one splits one home across
// two locks that serialize with nothing. `005_contract.md` §7 exists to remove
// exactly that ambiguity.
// export function withCodexHomeLinearizationLockSync<T>(operation: () => T): T;
export function setCodexDesiredEnabled(enabled: boolean): CodexDesiredMutationResult;
export function setCodexBeforeNativeWriteForTests(
  hook: ((boundary: CodexNativeWriteBoundary) => void) | null,
): void;
export function restoreNativeCodexOwned(): { success: boolean; message: string };
export function reconcileCodexDesiredState(
  trigger: "startup" | "ensure",
): CodexReconcileResult;
```

> **SUPERSEDED — do not implement this paragraph.** It read: canonicalize the
> effective `CODEX_HOME`, hash it with SHA-256, and store the SQLite lock at
> `join(tmpdir(), "opencodex-native-locks", <hash> + ".sqlite")`. Keying on the home
> alone omits the effective uid/SID, so the lock path carries no proof of which
> account it belongs to. The failure it produces is **environment-dependent**, which
> is worse than a fixed one: a shared temp root puts two OS users on one lock file,
> while a per-user or environment-controlled temp root splits one home across two
> and they serialize with nothing. `os.homedir()` is environment-controlled under
> Bun 1.3.14 besides. `005_contract.md` §7 exists to remove exactly this ambiguity.
>
> WP4 calls WP12's public N acquisition API instead. The path resolution belongs to
> `resolveCodexCoordinatorDatabasePath` (`src/codex/user-identity.ts:165`), which
> keys on uid/SID **and** the canonical home. What the withdrawn paragraph got right
> is retained by N anyway: the lock lives outside `CODEX_HOME`, process exit
> releases the transaction, and the callback is synchronous and bounded — no
> provider fetch, model discovery, sleep, or other `await` while it is held.

The ordering invariant is:

1. Inspect ownership **before** journal repair and before resolving/creating the
   lock path. `foreign` and `unknown` fail closed for startup/ensure and create no
   lock file. No installed service is `owned`; an installed service with no valid
   mirror is `unknown`.
2. Gather provider models and calculate candidate bytes outside the lock.
3. Acquire the per-home lock, inspect ownership again inside it, then fresh-read
   desired intent. A changed/invalid intent aborts with no native write.
4. Perform the bounded native commit while still holding the lock. Every desired
   ON/OFF setter acquires this **same lock before committing intent**, so OFF
   cannot linearize between authority approval and a native write.
5. Release the lock before logging, app-server handling, or any network work.

`inspectNativeCodexOwnership` replaces the automatic route's use of
`assertNativeTeardownOwned`. The existing helper fails open on unrelated errors
(`src/integrations/native/ownership-preflight.ts:21-35`), while
`readServiceInstallState` returns one `null` for corrupt, unreadable, and absent
mirrors (`src/service.ts:165-175`). MODIFY `src/service.ts` to expose a diagnostic
read that distinguishes: no installed service (`owned`), valid same-home state
(`owned`), valid different-home state (`foreign`), and an installed service whose
state is corrupt, unreadable, or missing (`unknown`). Interactive teardown may
retain its current human-facing policy; unattended convergence may not.

The authority check is once per locked commit, not a series of unlocked checks.
The test seam fires **after** ownership and desired-state approval and immediately
before every irreversible write below, while the same lock is still held:

| Boundary | Current write | WP4 locked commit |
|---|---|---|
| bundled fallback | `materializeBundledCodexCatalog` at `src/codex/catalog/bundled.ts:213-219` | candidate resolution outside; materialization inside lock |
| pristine backup | `copyFileSync` / `atomicWriteFile` at `src/codex/catalog/parsing.ts:428-444` | each target-hashed backup write inside lock |
| catalog | `atomicWriteFile(catalogPath, ...)` at `src/codex/catalog/sync.ts:568` | gathered candidate committed inside lock |
| models cache | `replaceCodexModelsCache` at `src/codex/catalog/sync.ts:847`, whose atomic write is `src/codex/internal/catalog-writer.ts:202` | replacement/restoration inside lock |
| injection journal | `writeJournal(...)` at `src/codex/inject.ts:521-527` | inside lock |
| config/profile/marker | writes at `src/codex/inject.ts:593-597` | all inside the same lock |
| history mutation | callback at `src/codex/inject.ts:598-603` | the complete callback, including its hidden writes, inside lock |
| native remove | `restoreNativeCodex` body at `src/codex/inject.ts:820` | ownership and OFF rechecked, then complete remove inside lock |

At the deterministic seam, start an OFF setter in a second process and prove its
intent commit cannot complete until the held apply write exits. Then release the
seam, let apply linearize, let OFF linearize next and remove it, and assert the
final disk state is OFF. The existing “OFF during model fetch” case remains and
must still produce zero writes because OFF commits before lock admission. These
are different races; the old fetch-only test would pass while the check/write bug
was live.

`src/codex/inject.ts` renames the raw remover to
`restoreNativeCodexUnchecked`; only `src/codex/desired-state.ts` may import it.
Stop, uninstall, shutdown, and explicit `ocx restore` use the owned lock but do
not require desired OFF and never rewrite intent. `src/service.ts` dynamically
imports the wrapper in its async stop/uninstall branches to avoid the existing
`service -> desired-state -> ownership-preflight -> service` cycle
(`src/integrations/native/ownership-preflight.ts:14-17`).

## Automatic Codex gates

### Normal sync path and explicit CLI meanings

A skipped operation is not successful. MODIFY `src/codex/sync.ts:9-22,49-55` so
the entry gate avoids unnecessary fetches and every no-write result is typed:

```diff
 export interface CodexSyncResult {
   ok: boolean;
@@
+  skippedReason?: "desired-off" | "desired-state-unavailable" | "codex-write-busy";
 }
@@
 export async function syncModelsToCodex(
   port?: number,
   config: OcxConfig = loadConfig(),
   log: Pick<Console, "log" | "error"> | null = console,
   deps: CodexSyncDeps = defaultDeps,
 ): Promise<CodexSyncResult> {
+  if (!codexDesiredEnabled(config)) {
+    return { ok: false, added: 0, catalogPath: null, catalogExists: false,
+      catalogWritten: false, cacheSynced: false,
+      skippedReason: "desired-off", message: "Codex integration is OFF." };
+  }
   const p = port ?? config.port ?? 10100;
```

The function gathers the candidate model/catalog state outside the lock, then
calls the locked commit described above. Desired OFF, unavailable authority, and
lock timeout all return `ok:false` plus `skippedReason`; no caller may infer success
from a bare resolved Promise.

`ocx start` and both `ocx ensure` branches remain callers at
`src/cli/index.ts:318-320,358-411`; they inspect `skippedReason` and print
`Codex auto-apply skipped: desired state is OFF.` once. They do not stop the
proxy, alter its port, or skip another client's setup.

`POST /api/sync` at `src/server/management/config-routes.ts:261-268` returns a
409 `codex_desired_off` envelope with `ok:false` and the `skippedReason` when OFF.
It must not return the current success-shaped body for an operation that wrote
nothing. **INFERRED:** 409 distinguishes a valid request blocked by current intent
from a server fault; 200 preserves the false-green incident and 500 misclassifies
policy. Busy is retryable 409/503; non-contention write failure remains 500.

The command split is explicit, because the old design gated the shared backend
without defining its callers:

| Caller | Behavior while durably OFF |
|---|---|
| `ocx start`, both `ocx ensure` branches | Start/keep the proxy, print one auto-apply skip, write no Codex artifact. |
| `POST /api/sync` | 409 `codex_desired_off`, `ok:false`, `skippedReason:"desired-off"`. |
| `ocx sync` | Exit nonzero with `Codex integration is OFF. Enable it with 'ocx restore back' or the Codex integration switch.` |
| `ocx provider ... --sync`, custom-model add/remove | Preserve their primary config mutation, report Codex refresh skipped with the same actionable switch text, and perform no Codex write (`src/cli/provider.ts:235`, `src/cli/models.ts:105`). |
| `ocx restore back` / `ocx eject back` | **Explicit enable verb:** require a live proxy, gather models, acquire the shared lock, persist ON, then apply before releasing it. |
| `ocx init` | After writing a fresh config, an affirmative injection answer may establish ON and apply under the shared lock (`src/cli/init.ts:176-198`). |

“Atomically persists ON then applies” means one linearized operation, not rollback
of config intent if a later native file fails: ON commits first under the lock;
apply failure returns nonzero and the next convergence may retry. It never prints
the current success line at `src/cli/index.ts:762-763` unless both the ON commit
and bounded apply succeed.

### Provider/model/combo refresh bypass

The management helper currently calls `refreshCodexModelCatalog(config)` directly
(`src/server/management-api.ts:105-112`), so a gate only in
`syncModelsToCodex` is insufficient. Replace it with a separately gated entry:

```diff
   async function refreshCodexCatalogBestEffort(): Promise<void> {
-    if (deps.refreshCodexCatalog) return deps.refreshCodexCatalog();
     try {
-      const { refreshCodexModelCatalog } = await import("../codex/refresh");
-      await refreshCodexModelCatalog(config);
+      const { refreshCodexCatalogIfDesired } = await import("../codex/sync");
+      await refreshCodexCatalogIfDesired(async freshConfig => {
+        if (deps.refreshCodexCatalog) return deps.refreshCodexCatalog();
+        const { refreshCodexModelCatalog } = await import("../codex/refresh");
+        await refreshCodexModelCatalog(freshConfig);
+      });
     } catch {
       /* catalog absent */
     }
   }
```

`refreshCodexCatalogIfDesired` loads persisted state, gathers outside the shared
lock, and commits catalog/cache inside it after the locked ownership/intent check.
The injected test dependency is inside that gate, not an early-return bypass.
Provider/model/combo routes therefore cannot bypass OFF, but no Claude, Grok,
Desktop, or file-client reader changes.

### Target-keyed backups, not one shared legacy writer

Two processes can share `OPENCODEX_HOME` while targeting different
`CODEX_HOME`s. The target-hashed path is safe
(`src/codex/catalog/parsing.ts:40-44`); the legacy
`OPENCODEX_HOME/catalog-backup.json` is not (`:36-38,440-445`). The hash usually
masks the collision, which is why this needs an activated two-home test.

Stop writing the legacy path. Keep it as a read-only upgrade fallback at
`readCatalogBackup` (`src/codex/catalog/parsing.ts:419-422`), but every new
snapshot is target-hashed and an existing valid snapshot is never replaced:

```diff
 export function ensureCatalogBackup(catalogPath: string, catalog: RawCatalog): void {
   const dir = getConfigDir();
   if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
   writePristineCatalogBackup(catalogBackupPathFor(catalogPath), catalogPath, catalog);
-  if (isDefaultCatalogPath(catalogPath)) writePristineCatalogBackup(legacyCatalogBackupPath(), catalogPath, catalog);
 }
```

The two-home fixture uses one `OPENCODEX_HOME`, distinct canonical
`CODEX_HOME`s, and simultaneous first syncs. It asserts two different hashed
snapshots contain their own native slugs, a pre-seeded valid legacy file remains
byte-exact (and an absent one is not created), and each restore reads only its
target snapshot.

## Startup reconciliation: ownership before any target mutation

The prior ordering was wrong. `handleStart` currently calls `reconcileJournal`
before server setup (`src/cli/index.ts:169-176`), and journal repair can replace
config/profile bytes (`src/codex/journal.ts:121-134`). Automatic convergence must
resolve ownership before that repair and before any lock artifact exists:

```diff
 async function handleStart(options: { block?: boolean } = {}) {
@@
   const requestedPort = parsePortOption();
-  if (!currentExternalCodexModelProvider()) reconcileJournal();
+  const ownership = inspectNativeCodexOwnership();
+  if (ownership.state === "owned") {
+    reconcileCodexDesiredState("startup"); // lock -> recheck -> journal -> OFF remove
+  } else {
+    reportCodexConvergenceRefusal(ownership); // no repair and no lock path resolution
+  }
   const existingPid = readPid();
```

Apply the identical preflight to `handleEnsure` before its current journal call
(`src/cli/index.ts:358-365`). Reconciliation does exactly this:

1. Outside the lock, classify ownership. `foreign` and `unknown` return unresolved
   and create no lock file. The proxy lifecycle may continue, but automatic Codex
   journal/apply/remove writes are suppressed.
2. For `owned`, acquire the external per-home lock and classify ownership again.
   A changed answer aborts before journal repair.
3. Under that lock, run `reconcileJournal` unconditionally for the owned home, then
   fresh-read desired state.
4. ON ends reconciliation; later automatic sync gathers outside and re-enters the
   same lock. OFF calls `restoreNativeCodexUnchecked` before releasing the lock.
5. Inspect config, profile, catalog, **models cache**, journal, and routed history.
   Report resolved only when no OpenCodex routing or routed slug remains. A history
   lock or unreadable cache is explained unresolved; desired OFF stays persisted.

`foreign` means a valid install record names another canonical home. `unknown`
covers corrupt JSON, unreadable state, and an installed service with a missing
mirror. The tests drive all four cases plus a valid same-home record. The
valid-foreign and all unknown cases hash every native artifact before/after and
assert the external lock path does not exist; that is the byte-exact refusal claim
the prior startup ordering could not support.

### The remover owns `models_cache.json` too

`restoreNativeCodex` currently restores journal/config, catalog, and history at
`src/codex/inject.ts:820`, but apply writes routed models into
`models_cache.json` through `replaceCodexModelsCache` (`src/codex/catalog/sync.ts:847`). Reporting OFF while
that cache still advertises routed slugs repeats the WP2 incident: the test sees
only artifacts it already knew to assert.

Add `restoreCodexModelsCache` beside `restoreCodexCatalog`. After catalog restore,
rewrite the cache from the restored catalog with an expired wrapper; if the
catalog is unavailable, parse the existing cache and remove only routed slugs.
Missing cache is success. Unreadable or unwritable cache is failure, not the
current swallowed `false` from `invalidateCodexModelsCache` (`src/codex/catalog/sync.ts:833`):

```diff
   const cat = restoreCodexCatalog();
+  const cache = restoreCodexModelsCache();
@@
-  return { success: cfg.success, message: `${msg}${historyMsg}` };
+  return {
+    success: cfg.success && cache.success,
+    message: `${msg}${cache.message}${historyMsg}`,
+  };
```

Observed-state inspection parses both `readCodexCatalogPath()` and
`activeCodexModelsCachePath()` (`src/codex/catalog/parsing.ts:68-75`) and treats
any routed slug in either as `applied`/`conflict`, never `absent`. Crash fixtures
stop immediately after cache replacement and after each later write. Every rerun
asserts no routed slug remains in **either** catalog or cache.

The crash point is after `setCodexDesiredEnabled(false)` commits and before the
remover starts. Restarting from that fixture must execute steps 1-5 again. A GET
route is not used as a repair trigger; round 2 #5's mutating-GET design is dropped.

## Do not gate these paths

- `reconcileJournal` remains unconditional **after ownership is proved**, and runs
  under the shared lock before desired-state convergence chooses the final
  direction (`src/codex/journal.ts:148-162`).
- ownership and drift inspection always run. Automatic convergence fails closed
  on both `foreign` and `unknown`.
- stop, uninstall, shutdown, and explicit native restore always remove state they
  own, regardless of desired ON, and never persist OFF
  (`src/service.ts:2587-2594`).
- `/v1/responses` remains admitted. Codex OFF means “stop automatically writing
  native Codex configuration,” not “stop serving Responses.”
- no Claude Code, Grok, Desktop, or file-client path reads the Codex key.

## Test plan

### `tests/codex-desired-state.test.ts` (NEW)

| Case | Activation and assertion |
|---|---|
| Upgrade default | Load config with no `clientIntegrations`; Codex is ON and no bytes are rewritten. |
| One-key parser | `codex:false` loads OFF; malformed `codex:"false"` degrades to ON while a future unknown key survives a field mutation. |
| Field-scoped commit | Mutate OFF from a stale live object; unrelated providers, API keys, and unknown fields survive. The supplied live object changes only from `committed`/`unchanged` output. |
| Return-versus-throw matrix | Drive `committed`, `unchanged`, and `unavailable`; then hold a real config transaction for `SQLITE_BUSY` and inject a non-contention acquisition failure. Busy is retryable 409/503, broken lock is non-retryable write failure, and neither failure changes disk/live state. |
| Auth sentinel unreachable | Start with no `claudeCode`, mutate Codex OFF then ON, reload, run `runClaudeAuthModeMigration`; it returns false and never creates `authMode` or `authModeMigratedAt`. |

### `tests/codex-desired-state-race.test.ts` (NEW)

| Case | Activation and assertion |
|---|---|
| OFF during model fetch | Pause `gatherRoutedModels`, persist OFF through the real writer, release; catalog, cache, journal, config, profile, and history writer counts remain zero. |
| OFF at post-approval seam | Pause after locked ownership/ON approval and before each named write, start an OFF setter in another process, and prove OFF cannot commit until apply releases the shared lock. Then OFF commits/removes and final observed state is absent. |
| Direct refresh bypass | Invoke a real provider/model route while OFF; `refreshCodexCatalogBestEffort` performs no catalog/cache write. |
| Hidden history writes | Fire the post-approval seam before every write inside the history callback; no callback write overlaps an OFF intent commit. |
| Single linearization lock | Hold one commit, start second-process refresh, ON setter, OFF setter, and remove; no native commit or desired-state commit overlaps, and final state follows lock acquisition order. |
| Crash after persist/cache | Crash after OFF intent and immediately after cache replacement, then run startup and ensure independently. Every rerun removes routed slugs from both catalog and cache. |
| Ownership matrix | Valid same-home is `owned`; valid foreign is `foreign`; corrupt, unreadable, and installed-service-with-missing-mirror are `unknown`. Foreign/unknown preserve all bytes and create no external lock file. |
| Stop does not change intent | With desired ON, run owned stop/uninstall teardown; artifacts are removed and the flag remains ON. |

### Existing regressions

- `tests/codex-sync-api.test.ts`: every no-write result has `ok:false` and
  `skippedReason`; `POST /api/sync` is 409 `codex_desired_off`, not 200/500.
- `tests/cli-restore-back.test.ts`: `ocx sync` refuses OFF with the switch command;
  `restore/eject back` persists ON and applies under one lock, reports success only
  after apply, and leaves ON persisted if apply later fails.
- `tests/startup-prompt.test.ts`: start and both ensure branches continue the proxy
  while OFF and make no native write. `tests/cli-provider.test.ts` plus the model
  case in `tests/cli-models-desired-state.test.ts` prove provider/model callers
  report a skipped refresh rather than silently claiming Codex was updated.
  `tests/cli-init-desired-state.test.ts` proves an affirmative injection prompt
  may establish ON and a negative answer performs no Codex write.
- `tests/codex-inject-integration.test.ts`: every post-approval write seam is
  reachable (journal, config, profile, journal mark, each history write); only
  `src/codex/desired-state.ts` imports the unchecked remover.
- `tests/codex-catalog-restore.test.ts`: a shared `OPENCODEX_HOME` with two
  `CODEX_HOME`s creates two independent hashed snapshots and never replaces the
  legacy path. `tests/codex-models-cache-invalidate.test.ts` pins restore from
  catalog, fallback filtering, missing cache, and unreadable/unwritable refusal.
- `tests/codex-journal.test.ts`: seed a dead-PID journal while desired OFF; owned
  repair runs under the lock before OFF convergence. Foreign/unknown runs do not
  repair the journal or create the lock.
- `tests/service.test.ts` and `tests/uninstall.test.ts`: every production native
  remover passes through the owned lock; foreign/unknown automatic teardown writes
  nothing; explicit owned teardown never changes desired state.
- `tests/server-auth.test.ts`: add a live-server case with
  `clientIntegrations.codex=false`; `POST /v1/responses` reaches the same normal
  validation/routing response as ON, never a client-disabled response.

## Verification

All tests use temporary `OPENCODEX_HOME`, `CODEX_HOME`, config, catalog, profile,
journal, history, and service-install-state fixtures. Do not point any command at
the user's live proxy on port 10100.

```bash
bun test tests/codex-desired-state.test.ts
bun test tests/codex-desired-state-race.test.ts
bun test tests/codex-sync-api.test.ts tests/codex-inject-integration.test.ts tests/cli-restore-back.test.ts tests/cli-provider.test.ts tests/cli-models-desired-state.test.ts tests/cli-init-desired-state.test.ts tests/startup-prompt.test.ts
bun test tests/codex-catalog-restore.test.ts tests/codex-models-cache-invalidate.test.ts
bun test tests/codex-journal.test.ts tests/service.test.ts tests/uninstall.test.ts tests/server-auth.test.ts
bun run typecheck
bun run test
bun run privacy:scan
cd docs-site && bun install --frozen-lockfile && bun run build
```

Live proof is the subprocess case in `tests/codex-desired-state-race.test.ts`, not
the installed `ocx`: it launches the repository CLI with isolated homes and an
ephemeral non-10100 port and records PID and `/healthz`. First it commits OFF and
converges while the process stays alive. In a separate run it kills at the
post-persist/pre-remove seam and relaunches from the same isolated home. It proves:

1. `/healthz` returns from the same PID after the live OFF mutation; disabling
   native Codex did not stop or replace the proxy.
2. native Codex routing/profile/catalog/cache residue converges to absent after restart;
   neither catalog nor cache contains a routed slug after any crash-point rerun.
3. an invalid `/v1/responses` request reaches its normal validation response, not
   a desired-state gate.
4. repeating valid-foreign, corrupt, unreadable, and missing-mirror ownership cases
   leaves every Codex artifact byte-exact and creates no per-home lock file.

The test must print the isolated roots, chosen port, before/after hashes, and
reconciliation result so the C-phase evidence proves the live path rather than
only a mocked helper. It must tear down only its recorded subprocess and temp
directory.

## Accept criteria

| Roadmap criterion | WP4 closure |
|---|---|
| C2 — Codex stays disabled across restart, ensure, and `/api/sync` | OFF and every native commit share one per-home lock; startup/ensure converge catalog and cache residue; every skipped caller returns/reports failure honestly. |
| C3 — absent config changes nothing on upgrade | Missing object/key remains ON. The one-key parser and no-write upgrade test prove existing installs keep current behavior. |
| C4 — disabling Codex never stops proxy or closes `/v1/responses` | No lifecycle or transport gate is added. The isolated live proof keeps `/healthz` and the Responses route reachable while native Codex state is removed. |
| C7 — foreign-home startup touches nothing | Tri-state ownership is resolved before journal/lock creation and rechecked under the external lock; foreign and unknown fixtures prove byte-exact refusal and no new lock artifact. |
| Public contract stays synchronized | English lifecycle/configuration docs name OFF behavior and explicit-enable semantics; translated lifecycle/config pages contain no contradictory unconditional promise. |

WP4 is complete only when no native write can occur after OFF has linearized, an
OFF started at the post-approval seam is forced to wait and then wins by removing
the prior apply, cache and catalog are both clean after every crash rerun, and
foreign/unknown startup creates no artifact at all. A boolean plus an unlocked
re-read is the failed draft, not this design.
