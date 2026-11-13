/** Device-local intent controller. All client mutations go through the existing writers. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { routeClientIntentDigest, routeIntentDigest, ROUTE_CLIENT_IDS, type RouteClientId, type RouteClientIntent } from "../link/route-intent";
import { isIntegrationClientId, type IntegrationClientId } from "./registry";
import { readIntegrationState } from "./state";
import { createIntegrationStateStore } from "./store";
import { applyIntegrationCoordinated, disableIntegrationCoordinated, overwriteIntegrationCoordinated, refreshIntegrationCoordinated,
  type IntegrationWriteInput, type WriteOutcome } from "./writer";
import { createAsideProfileContext, asideProfileScope, asideWriteInput, asideRootStore, listAsideProfileStores } from "./aside-profile-context";
import { asideHomeDir } from "../clients/config-export";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import type { RouteClientOutcome, RouteIntentApplyInput, RouteIntentReceipt } from "./route-intent-contract";
import { effectiveRouteIntent, readRouteIntentReceipt, routeIntentStatePath, writeRouteIntentReceipt } from "./route-intent-state";
export { clearRouteIntentReceipt, effectiveRouteIntent, readLocalRouteIntentOff, readRouteIntentReceipt, readRouteIntentReceiptStrict, routeIntentStatePath, setLocalRouteIntentOff } from "./route-intent-state";
export type { RouteClientOutcome, RouteIntentApplyInput, RouteIntentReceipt } from "./route-intent-contract";

const flights = new Set<string>();

function project(client: RouteClientId, result: WriteOutcome, target: string): RouteClientOutcome {
  return { client, target, outcome: result.ok ? "current" : result.reason === "not_installed" ? "not_installed"
    : result.state === "conflict" ? "conflict" : "failed", message: result.message };
}

async function writeClient(input: RouteIntentApplyInput, bound: IntegrationWriteInput, intent: RouteClientIntent): Promise<RouteClientOutcome> {
  const state = readIntegrationState(bound);
  // An off intent never adopts an unowned block, including foreign blocks.
  if (!intent.enabled && !bound.store?.readRecords()[bound.clientId]) {
    return { client: bound.clientId, outcome: "current", target: state.configPath };
  }
  if (!intent.enabled && input.recoverConflicts && state.state === "conflict") {
    // A durable record is mandatory above; this cannot adopt an unowned foreign block.
    // Overwrite snapshots the edited preimage through the existing private journal. Unsafe
    // paths, blocked containers and unrepresentable contributions retain their ordinary refusal.
    const recovered = await overwriteIntegrationCoordinated(bound, { guard: () => { input.beforeWrite?.(); return null; } });
    if (!recovered.ok) return project(bound.clientId, recovered, state.configPath);
  }
  const operation = !intent.enabled ? disableIntegrationCoordinated
    : input.overwriteConflict ? overwriteIntegrationCoordinated
    : state.state === "absent" ? applyIntegrationCoordinated : refreshIntegrationCoordinated;
  const result = await operation(bound, { guard: () => { input.beforeWrite?.(); return null; } });
  // A refresh of a deleted owned block returns absent. Intent is still on, so that is stale.
  const outcome = project(bound.clientId, result, state.configPath);
  if (intent.enabled && result.ok && result.state === "absent") outcome.outcome = "stale";
  return outcome;
}

function manifestText(root: string): string {
  return readBoundedRegularFileSync(join(root, "accounts.json"), 4 * 1024 * 1024).toString("utf8");
}

async function applyAside(input: RouteIntentApplyInput, intent: RouteClientIntent): Promise<RouteClientOutcome> {
  const root = asideHomeDir(input.env ?? process.env, input.home ?? homedir());
  const ownershipInput = { ...input, port: input.config.port };
  const rootStore = asideRootStore(ownershipInput);
  const legacy = rootStore.readRecordsStrict().aside;
  const owners = listAsideProfileStores(rootStore).flatMap(child => {
    const records = child.store.readRecordsStrict();
    if (Object.keys(records).some(id => id !== "aside")) throw new Error("Aside profile storage names another client");
    return records.aside ? [{ profileId: child.profileId, record: records.aside }] : [];
  });
  const owned = Boolean(legacy) || owners.length > 0;
  // No owned route means off is already proved, even without a usable account manifest.
  if (!intent.enabled && !owned) return { client: "aside", outcome: "current" };
  if (!existsSync(root)) {
    if (owned) throw new Error("Aside installation is missing with retained route ownership");
    return { client: "aside", outcome: "not_installed" };
  }
  const manifest = manifestText(root);
  const ctx = createAsideProfileContext(ownershipInput);
  // A removed manifest entry is not evidence that its owned file was cleaned up.
  if ((legacy && !ctx.profiles.some(profile => profile.configPath === legacy.configPath))
    || owners.some(owner => !ctx.profiles.some(profile => profile.id === owner.profileId && profile.configPath === owner.record.configPath))) {
    throw new Error("Aside route ownership names a profile outside the account manifest");
  }
  if (manifestText(root) !== manifest) throw new Error("Aside account manifest changed during enumeration");
  const raw: unknown = JSON.parse(manifest);
  // Enumeration intentionally hides userIds. Prove that its entire profile roster was
  // derived from the manifest snapshot whose userIds this operation selects.
  const snapshot = raw as { currentAccountId: number; accounts?: Array<{ id: number; name?: string }> };
  const roster = snapshot.accounts ?? [{ id: snapshot.currentAccountId }];
  if (roster.length !== ctx.profiles.length || ctx.profiles.some((profile, index) => {
    const account = roster[index];
    return !account || account.id !== profile.id || (account.id === snapshot.currentAccountId) !== profile.current
      || (typeof account.name === "string" ? account.name : undefined) !== profile.name;
  })) throw new Error("Aside profile enumeration does not match the account identity snapshot");
  const ids = new Map<number, string>();
  if (raw && typeof raw === "object" && "accounts" in raw && Array.isArray(raw.accounts)) {
    for (const account of raw.accounts) {
      if (account && typeof account === "object" && Number.isSafeInteger(account.id) && typeof account.userId === "string") {
        ids.set(account.id, account.userId);
      }
    }
  }
  const accounts = intent.accounts ?? "all";
  const selected = ctx.profiles.filter(profile => accounts === "all" || (Array.isArray(accounts) && accounts.includes(ids.get(profile.id) ?? "")));
  const results: RouteClientOutcome[] = [];
  for (const profile of ctx.profiles) {
    const scope = asideProfileScope(ctx, profile);
    const enabled = intent.enabled && selected.includes(profile) && accounts !== "none";
    if (!enabled && !scope.store.readRecords().aside) continue;
    const bound = await asideWriteInput(ctx, scope);
    results.push(await writeClient({ ...input, beforeWrite: () => {
      input.beforeWrite?.(); scope.assertBoundary();
      if (manifestText(root) !== manifest) throw new Error("Aside account identity changed during route apply");
    } }, bound, { ...intent, enabled }));
  }
  const failure = results.find(row => row.outcome === "failed") ?? results.find(row => row.outcome === "conflict")
    ?? results.find(row => row.outcome !== "current");
  if (failure) return { ...failure, client: "aside" };
  if (intent.enabled && accounts !== "none" && selected.length === 0) {
    return { client: "aside", outcome: "not_installed", message: "No local Aside profile matches the requested userIds" };
  }
  // `--accounts none` (or an off intent) selects no profile: an empty slot list is no target at
  // all, and the receipt and Home record outcome schemas reject an empty one.
  const target = selected.map(profile => `u${profile.id}`).join(",");
  return { client: "aside", outcome: "current", ...(target ? { target } : {}) };
}

async function applyClient(input: RouteIntentApplyInput, client: RouteClientId, intent: RouteClientIntent): Promise<RouteClientOutcome> {
  if (client === "aside") return input.withFileWrites ? input.withFileWrites(() => applyAside(input, intent)) : applyAside(input, intent);
  if (isIntegrationClientId(client)) {
    const write = () => writeClient(input, { clientId: client, config: input.config, port: input.config.port, models: input.models,
      env: input.env, home: input.home, store: input.store, modelNames: intent.modelNames }, intent);
    return input.withFileWrites ? input.withFileWrites(write) : write();
  }
  if (input.applyNative) { input.beforeWrite?.(); return input.applyNative(client, intent); }
  const previous = readRouteIntentReceipt(input.statePath);
  return !intent.enabled && !previous?.clients[client]?.enabled
    ? { client, outcome: "current" }
    : { client, outcome: "failed", message: "This native client needs its existing local ownership adapter" };
}

/** Home and Child share the same local materializer; absent intent never calls this function. */
export async function materializeRouteIntent(input: RouteIntentApplyInput): Promise<RouteIntentReceipt> {
  const path = input.statePath ?? routeIntentStatePath();
  if (flights.has(path)) throw new Error("Local route intent apply is already running");
  flights.add(path);
  try {
    input = { ...input, document: structuredClone(input.document), config: structuredClone(input.config), models: structuredClone([...input.models]),
      store: input.store ?? createIntegrationStateStore() };
    const effective = effectiveRouteIntent(input.document, path, input.localOff);
    const previous = input.retainSkippedOutcomes ? readRouteIntentReceipt(path) : null;
    const receipt: RouteIntentReceipt = { version: 1, models: input.models, ...(input.linkId ? { linkId: input.linkId } : {}), document: structuredClone(input.document), ...effective,
      outcomes: ROUTE_CLIENT_IDS.map(client => ({ client, outcome: "stale" })),
      appliedRouteIntentDigest: null, appliedAt: (input.now ?? (() => new Date()))().toISOString() };
    // Withdraw the previous digest before any client can change, including a failed/aborted write.
    const saveReceipt = () => input.withReceiptWrite
      ? input.withReceiptWrite(() => writeRouteIntentReceipt(receipt, path)) : writeRouteIntentReceipt(receipt, path);
    saveReceipt();
    for (const client of ROUTE_CLIENT_IDS) {
      if (input.onlyClients && !input.onlyClients.includes(client)) {
        const kept = previous?.linkId === input.linkId
          ? previous?.outcomes.find(row => row.client === client && row.intentDigest === routeClientIntentDigest(input.document, client)) : undefined;
        if (kept) receipt.outcomes[ROUTE_CLIENT_IDS.indexOf(client)] = kept;
        continue;
      }
      input.beforeWrite?.();
      try {
        receipt.outcomes[ROUTE_CLIENT_IDS.indexOf(client)] = { ...await applyClient({ ...input, overwriteConflict: input.overwriteConflict === true && (input.overwriteClient === undefined || input.overwriteClient === client) }, client, effective.clients[client]),
          intentDigest: routeClientIntentDigest(input.document, client),
          ...(effective.sources[client] === "local" ? { source: "local" as const } : {}) };
      } catch {
        input.beforeWrite?.(); // Ownership loss propagates instead of looking like a disk failure.
        receipt.outcomes[ROUTE_CLIENT_IDS.indexOf(client)] = { client, outcome: "failed", intentDigest: routeClientIntentDigest(input.document, client),
          ...(effective.sources[client] === "local" ? { source: "local" as const } : {}), message: "Local client could not be reconciled safely" };
      }
    }
    input.beforeWrite?.();
    // A local opt-out intentionally differs from the Home document; do not claim its digest.
    const locallyChanged = ROUTE_CLIENT_IDS.some(id => effective.sources[id] === "local" && input.document.clients[id].enabled);
    if (!locallyChanged && receipt.outcomes.every(row => row.outcome === "current")) receipt.appliedRouteIntentDigest = routeIntentDigest(input.document);
    saveReceipt();
    return receipt;
  } finally { flights.delete(path); }
}

/**
 * Put a standalone integration back: one still owned, or one the person changed (their own block),
 * is kept as is; one the link disabled is applied again. An uninstalled client has nothing to do.
 */
async function restoreStandaloneClient(input: RouteIntentApplyInput, client: IntegrationClientId, modelNames?: "alias" | "routed"): Promise<RouteClientOutcome> {
  const bound: IntegrationWriteInput = { clientId: client, config: input.config, port: input.config.port, models: input.models,
    env: input.env, home: input.home, store: input.store, modelNames };
  const state = readIntegrationState(bound);
  if (input.store?.readRecords()[client] || state.state !== "absent") return { client, outcome: "current", target: state.configPath };
  const result = await applyIntegrationCoordinated(bound, { guard: () => { input.beforeWrite?.(); return null; } });
  return result.ok || result.reason === "not_installed" ? { client, outcome: "current", target: state.configPath } : project(client, result, state.configPath);
}

/**
 * Disconnect calls this while it holds its lifecycle fence, before clearing intent receipts.
 * `standalone` names file clients the Child owned before linking; they are restored, not removed.
 */
export async function cleanupRouteIntent(input: RouteIntentApplyInput,
  standalone: Partial<Record<RouteClientId, { modelNames?: "alias" | "routed" }>> = {}): Promise<RouteClientOutcome[]> {
  const receipt = readRouteIntentReceipt(input.statePath);
  if (!receipt) return [];
  const document = structuredClone(receipt.document);
  for (const id of ROUTE_CLIENT_IDS) document.clients[id].enabled = false;
  const kept = ROUTE_CLIENT_IDS.filter((id): id is IntegrationClientId => isIntegrationClientId(id) && id !== "aside" && Object.hasOwn(standalone, id));
  const outcomes = (await materializeRouteIntent({ ...input, document, overwriteConflict: false,
    onlyClients: ROUTE_CLIENT_IDS.filter(id => isIntegrationClientId(id) && !(kept as readonly string[]).includes(id)) }))
    .outcomes.filter(row => isIntegrationClientId(row.client) && !(kept as readonly string[]).includes(row.client));
  const store = input.store ?? createIntegrationStateStore();
  for (const client of kept) {
    const restore = () => restoreStandaloneClient({ ...input, store }, client, standalone[client]?.modelNames);
    outcomes.push(input.withFileWrites ? await input.withFileWrites(restore) : await restore());
  }
  return outcomes;
}
