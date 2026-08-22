/**
 * Toggle routes for the integrations that are NOT file-merged clients.
 *
 * The six file clients live in `integration-routes.ts` and go through
 * `src/integrations/writer.ts`, which merges config fragments and journals every
 * write. These do not: Claude Code is a flag in our own config, and Grok owns a
 * fenced region of a file we do not otherwise write. Neither has a merged
 * fragment to own, so neither needs a snapshot, a journal row, or a restore
 * route — turning them back on is the undo.
 *
 * That conclusion cost eleven audit rounds; the reasoning is in
 * devlog/_fin/260803_integrations_toggle_all/, and 007 records why Codex and
 * Claude Desktop are NOT here: their state spans several artifacts and a live
 * database, so they need a durable operation record this module deliberately
 * does not have.
 *
 * Design of record: devlog/_fin/260803_integrations_toggle_all/030 (routes),
 * 011 (Claude Code), 012 (Grok).
 */
import { loadConfig, readRuntimePort, saveConfigPreservingClaudeCode } from "../../config";
import { desktopVisibleNativeSlugs, filterCatalogVisibleModels, nativeContextLimits, nativeOpenAiContextWindow, visibleNativeSlugs } from "../../codex/catalog";
import { providerContextCap } from "../../providers/context-cap";
import { OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { inspectDesktop3pConfigLibrary, removeDesktop3pStandardPivot, writeDesktop3pConfig } from "../../claude/desktop-3p";
import { injectGrokConfig, stripGrokConfig, type GrokInjectModel } from "../../grok/inject";
import { inspectGrokConfig } from "../../grok/inspect";
import { grokConfigPath } from "../../grok/status";
import { assertNativeTeardownOwned } from "../../integrations/native/ownership-preflight";
import type { CodexNativeRestoreResult } from "../../codex/inject";
import type { OcxConfig } from "../../types";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";

export type NativeIntegrationClientId = "claude" | "grok" | "codex" | "claude-desktop";

/** Every reason this module can decline, in one place (audit r3 #6). */
export type NativeRefusalReason =
  | "not_installed"
  | "orphaned_marker"
  | "home_mismatch"
  | "config_busy"
  | "write_failed"
  | "metadata_unreadable"
  | "cleanup_incomplete"
  | "desired_state_changed";

export interface NativeStatus {
  clientId: NativeIntegrationClientId;
  state: "absent" | "current" | "unsafe";
  installed: boolean;
  configPath: string;
  desiredEnabled: boolean;
  /**
   * Set when a disable would be refused right now. ADVISORY: the file can
   * change before the PUT, which re-checks and whose answer is authoritative.
   * It exists so the GUI does not offer an action we already know is blocked.
   */
  disableBlocked: { reason: NativeRefusalReason; message: string } | null;
}

export interface NativeStatusListEnvelope {
  clients: NativeStatus[];
}

export interface NativeToggleEnvelope {
  ok: true;
  clientId: NativeIntegrationClientId;
  changed: boolean;
  state: NativeStatus["state"];
  message: string;
  desiredEnabled: boolean;
  /** Present when the outcome needs more than success/failure to be honest. */
  reason?: string;
  artifacts?: CodexNativeRestoreResult["artifacts"];
}

export interface NativeRefusalEnvelope {
  error: string;
  code: "native_integration_refused" | "native_integration_failed";
  clientId: NativeIntegrationClientId;
  reason: NativeRefusalReason;
  message: string;
  /** Present on every post-commit refusal; absent only for pre-commit refusals. */
  desiredEnabled?: boolean;
  residualPaths?: string[];
}

export type NativePostCommitRefusalEnvelope = Omit<NativeRefusalEnvelope, "desiredEnabled"> & {
  desiredEnabled: boolean;
};

function refusal(
  status: number,
  clientId: NativeIntegrationClientId,
  reason: NativeRefusalReason,
  message: string,
  extra: Pick<NativeRefusalEnvelope, "desiredEnabled" | "residualPaths"> = {},
): Response {
  return jsonResponse({
    error: status >= 500 ? "native integration change failed" : "native integration change refused",
    code: status >= 500 ? "native_integration_failed" : "native_integration_refused",
    clientId, reason, message, ...extra,
  } satisfies NativeRefusalEnvelope, status);
}

function postCommitRefusal(
  status: number,
  clientId: NativeIntegrationClientId,
  reason: NativeRefusalReason,
  message: string,
  extra: Pick<NativePostCommitRefusalEnvelope, "desiredEnabled" | "residualPaths">,
): Response {
  return jsonResponse({
    error: status >= 500 ? "native integration change failed" : "native integration change refused",
    code: status >= 500 ? "native_integration_failed" : "native_integration_refused",
    clientId, reason, message, ...extra,
  } satisfies NativePostCommitRefusalEnvelope, status);
}

function desktopStatus(config: ManagementContext["config"]): NativeStatus {
  const seen = inspectDesktop3pConfigLibrary({
    appliedFingerprint: config.claudeCode?.desktopProfile?.appliedFingerprint ?? null,
  });
  const state: NativeStatus["state"] = seen.kind === "gateway_ours"
    ? "current"
    : seen.kind === "unsafe" || seen.kind === "broken" ? "unsafe" : "absent";
  const disableBlocked = seen.kind === "unsafe" || seen.kind === "broken" || seen.kind === "foreign"
    ? {
        reason: seen.kind === "unsafe" && seen.reason === "metadata_unreadable" ? "metadata_unreadable" as const : "write_failed" as const,
        message: "Claude Desktop configuration cannot be changed safely.",
      }
    : null;
  return {
    clientId: "claude-desktop",
    state,
    installed: seen.kind !== "not_installed",
    configPath: seen.libraryPath,
    desiredEnabled: config.clientIntegrations?.["claude-desktop"] !== false,
    disableBlocked,
  };
}

/** Absent means ON: the six read sites all treat only an explicit `false` as off. */
export function claudeCodeEnabled(config: ManagementContext["config"]): boolean {
  return config.claudeCode?.enabled !== false;
}

function claudeStatus(config: ManagementContext["config"], configPath: string): NativeStatus {
  return {
    clientId: "claude",
    state: claudeCodeEnabled(config) ? "current" : "absent",
    // The surface exists wherever the proxy does; there is no separate install.
    installed: true,
    configPath,
    desiredEnabled: claudeCodeEnabled(config),
    // Nothing can refuse this disable: no external file, no shared teardown.
    disableBlocked: null,
  };
}

function codexStatus(config: ManagementContext["config"], configPath: string): NativeStatus {
  const desiredEnabled = config.clientIntegrations?.codex !== false;
  return {
    clientId: "codex",
    state: desiredEnabled ? "current" : "absent",
    installed: true,
    configPath,
    desiredEnabled,
    disableBlocked: null,
  };
}

/**
 * Grok's GET row (030 §field table). `disableBlocked` is ADVISORY — the file
 * can change before the PUT, which re-checks with the same inspector and whose
 * answer is authoritative.
 */
function grokStatus(config: ManagementContext["config"]): NativeStatus {
  const seen = inspectGrokConfig();
  let disableBlocked: NativeStatus["disableBlocked"] = null;
  if (seen.kind === "orphaned_marker") {
    disableBlocked = {
      reason: "orphaned_marker",
      message: "The managed block in the Grok config is ambiguous (a begin marker with no end marker), so opencodex cannot tell where it ends and will not touch it. Remove the opencodex markers by hand, then retry.",
    };
  } else {
    const owned = assertNativeTeardownOwned();
    if (!owned.ok) disableBlocked = { reason: "home_mismatch", message: owned.message };
  }
  // A switch with a `never` guard, not a ternary: a future fifth GrokInspection
  // kind must fail to COMPILE here, not silently read as `absent` (C-gate nit).
  let state: NativeStatus["state"];
  switch (seen.kind) {
    case "present": state = "current"; break;
    case "orphaned_marker": state = "unsafe"; break;
    case "absent": case "not_installed": state = "absent"; break;
    default: {
      const exhaustive: never = seen;
      throw new Error(`unhandled Grok inspection kind: ${JSON.stringify(exhaustive)}`);
    }
  }
  return {
    clientId: "grok",
    state,
    installed: seen.kind !== "not_installed",
    configPath: grokConfigPath(),
    desiredEnabled: config.clientIntegrations?.grok !== false,
    disableBlocked,
  };
}

/**
 * Genuine lock contention, as opposed to a lock we could not open at all.
 *
 * `ConfigMutationLockError` carries a constant `code` and wraps EVERY
 * acquisition failure — an unopenable database, an ACL that would not set, as
 * well as a real conflict. Only the cause distinguishes them, and mapping the
 * whole class to a retryable 409 would tell the user to retry a lock file they
 * cannot open, which fails identically forever (audit r8 #2).
 */
function isLockContention(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return cause?.code === "SQLITE_BUSY";
}

function isConfigLockError(error: unknown): boolean {
  return !!error && typeof error === "object"
    && (error as { code?: unknown }).code === "CONFIG_MUTATION_LOCK_UNAVAILABLE";
}

/*
 * Single-flight for the Grok toggle (030 §Concurrency): two overlapping strips
 * of the same file would race on bytes, so a second concurrent PUT is REFUSED
 * with 409 config_busy — nothing was written, and retrying is correct advice.
 * This deliberately does not share runGrokApplyFlight's JOIN semantics
 * (/api/grok/apply joins an identical in-flight operation); toggle-vs-apply
 * interleaving is covered not by exclusion but by the post-write inspection:
 * whatever the file holds afterwards, the reported state is the last read
 * (012 Rev 3 N3).
 */
let grokToggleFlight: Promise<Response> | null = null;

/**
 * Dynamic import, never static: management-api.ts statically imports THIS
 * module, so a static import of fetchAllModels back from it would close a
 * cycle. sync.ts:18-21 dodges the same cycle the same way.
 */
async function defaultFetchAllModels(config: OcxConfig) {
  const { fetchAllModels } = await import("../management-api");
  return fetchAllModels(config);
}

const ORPHANED_MARKER_MESSAGE =
  "The managed block in the Grok config is ambiguous (a begin marker with no end marker), "
  + "so opencodex cannot tell where it ends and will not touch it. "
  + "Remove the opencodex markers by hand, then retry.";

const NOT_INSTALLED_MESSAGE =
  "Grok home was not found, so there is nothing to change. Install Grok Build first.";

/**
 * One Codex change at a time, for the same reason Grok has this: the guard
 * stands BEFORE the first await, or two concurrent PUTs both pass it while their
 * bodies are still parsing.
 */
let codexToggleFlight: Promise<Response> | null = null;

/**
 * Turn native Codex routing on or off.
 *
 * THE PROXY STAYS UP. Turning Codex off is not `ocx stop`: other clients keep
 * routing through this process, `/healthz` keeps answering, and only Codex goes
 * back to its own path. That is the entire point of having a per-client switch
 * rather than a kill switch, and it is why this route restores rather than
 * stopping anything.
 *
 * Two writes, in this order:
 *   1. persist the desired state, so the decision survives the next `ocx start`;
 *   2. converge the artifacts to match it.
 *
 * Intent first is deliberate. If the process dies between them, the next start
 * reads the persisted intent and converges — whereas converging first and dying
 * would leave artifacts the next start silently undoes.
 */
async function handleCodexToggle(ctx: ManagementContext): Promise<Response> {
  const { req } = ctx;
  if (codexToggleFlight) {
    return refusal(409, "codex", "config_busy",
      "Another Codex change is already in flight. Nothing was written — try again in a moment.");
  }
  codexToggleFlight = (async (): Promise<Response> => {
    let body: { enabled?: unknown };
    try {
      body = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "enabled must be a boolean" }, 400);
    }
    const enabled = body.enabled;

    const { setCodexIntegrationEnabled } = await import("../../codex/desired-state");
    const persisted = setCodexIntegrationEnabled(enabled);
    /*
     * `missing` does not block the switch — see the Grok route for the reasoning.
     * A user with no config file yet still gets the artifact change; what they
     * lose is durability across a restart, and the envelope says so rather than
     * implying the switch failed.
     */
    if (!persisted.ok && persisted.reason !== "missing") {
      return refusal(
        persisted.retryable ? 409 : 500,
        "codex",
        persisted.retryable ? "config_busy" : "write_failed",
        persisted.message,
      );
    }
    const durable = persisted.ok;

    if (enabled) {
      // The port this process actually BOUND, not what config.json last recorded.
      // A stale config port would inject a base_url pointing at nothing — the
      // same trap `runGrokApplyFlight` documents below.
      const runtime = (ctx.deps.readRuntimePort ?? readRuntimePort)(process.pid);
      const port = runtime?.port ?? ctx.config.port;
      const { syncModelsToCodex } = await import("../../codex/sync");
      const applied = await syncModelsToCodex(port);
      if (applied.status === "skipped") {
        return jsonResponse({
          ok: true, clientId: "codex", changed: durable && persisted.status === "committed",
          state: "absent",
          desiredEnabled: enabled,
          message: "Codex integration is OFF; enable did not change Codex.",
          reason: "apply_incomplete",
        } satisfies NativeToggleEnvelope);
      }
      return jsonResponse({
        ok: true, clientId: "codex", changed: durable && persisted.status === "committed",
        state: applied.ok ? "current" : "absent",
        desiredEnabled: enabled,
        message: applied.ok
          ? "Codex now routes through opencodex"
          : `Codex intent saved, but applying it did not complete: ${applied.message}`,
        ...(applied.ok
          ? (durable ? {} : { reason: "not_durable" })
          : { reason: "apply_incomplete" }),
      } satisfies NativeToggleEnvelope);
    }

    // OFF. Restore the native path; the proxy keeps serving every other client.
    if (durable && persisted.status === "unchanged") {
      const { classifyNativeRoutedResidue } = await import("../../codex/native-residue");
      if (classifyNativeRoutedResidue().kind === "clean") {
        return jsonResponse({
          ok: true, clientId: "codex", changed: false, state: "absent", desiredEnabled: false,
          message: "Codex integration is already OFF and native; no Codex files changed.",
        } satisfies NativeToggleEnvelope);
      }
    }
    const { restoreNativeCodexAsync } = await import("../../codex/inject");
    const restored = await restoreNativeCodexAsync({ revalidateDesiredState: true });
    return jsonResponse({
      ok: true, clientId: "codex", changed: durable && persisted.status === "committed",
      state: restored.success ? "absent" : "unsafe",
      desiredEnabled: enabled,
      message: restored.success
        ? "Codex restored to its native path; the proxy is still serving other clients"
        : `Codex intent saved, but restoring the native path did not complete: ${restored.message}`,
      ...(restored.success
        ? (durable ? {} : { reason: "not_durable" })
        : { reason: "restore_incomplete" }),
      artifacts: restored.artifacts,
    } satisfies NativeToggleEnvelope);
  })();
  try {
    return await codexToggleFlight;
  } finally {
    codexToggleFlight = null;
  }
}

async function handleGrokToggle(ctx: ManagementContext): Promise<Response> {
  const { req, config, deps } = ctx;
  /*
   * The guard stands BEFORE the first await, or two concurrent PUTs could both
   * pass it while their bodies are still parsing — the race the guard exists
   * to close.
   */
  if (grokToggleFlight) {
    return refusal(409, "grok", "config_busy",
      "Another Grok change is already in flight. Nothing was written — try again in a moment.");
  }
  grokToggleFlight = (async (): Promise<Response> => {
    let body: { enabled?: unknown };
    try {
      body = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "enabled must be a boolean" }, 400);
    }
    const enabled = body.enabled;

    /*
     * The inspector runs BEFORE either delegate, in BOTH directions (012 §In
     * PUT it is the authoritative preflight): an ambiguous fence never reaches
     * the code path that would misreport it, and the refusal is identical
     * whichever direction the user was heading, because the reason is the same.
     */
    const seen = inspectGrokConfig();
    if (seen.kind === "not_installed") return refusal(404, "grok", "not_installed", NOT_INSTALLED_MESSAGE);
    if (seen.kind === "orphaned_marker") return refusal(409, "grok", "orphaned_marker", ORPHANED_MARKER_MESSAGE);

    /*
     * Persist the DECISION before touching the fence.
     *
     * This route shipped without it, which is the whole bug: stripping the fence
     * records nothing, so the next `ocx start` calls syncGrokConfig
     * unconditionally and writes it straight back. The switch worked and lasted
     * exactly one restart.
     *
     * Intent first, artifacts second, for the same reason as the Codex route: a
     * process that dies between them leaves a decision the next start can act
     * on, where the other order leaves artifacts the next start undoes.
     */
    const { setGrokIntegrationEnabled } = await import("../../codex/desired-state");
    const persisted = setGrokIntegrationEnabled(enabled);
    /*
     * `missing` does NOT block the toggle here.
     *
     * A config file that does not exist yet is a normal state for someone who
     * has never saved settings, and refusing their switch because of it would
     * make the button dead for exactly the users least able to diagnose why.
     * The fence change is still worth performing and still reports honestly;
     * what they lose is durability across a restart, which is what the reason
     * on the envelope says. `conflict` and `invalid` are different: another
     * writer won, or the file is malformed and must not be overwritten.
     */
    if (!persisted.ok && persisted.reason !== "missing") {
      return refusal(
        persisted.retryable ? 409 : 500,
        "grok",
        persisted.retryable ? "config_busy" : "write_failed",
        persisted.message,
      );
    }
    const durable = persisted.ok;
    const desiredEnabled = durable ? loadConfig().clientIntegrations?.grok !== false : enabled;

    if (!enabled) {
      /*
       * Disable only: a strip is a SHARED teardown — it must not run under a
       * service installed from another home (audit r1 #5). Enable is not
       * gated: writing our own fence tears nothing down.
       */
      const owned = assertNativeTeardownOwned();
      if (!owned.ok) return postCommitRefusal(409, "grok", "home_mismatch", owned.message, { desiredEnabled });

      const result = stripGrokConfig();
      if (result.skippedReason === "no-grok-home") {
        return postCommitRefusal(404, "grok", "not_installed", NOT_INSTALLED_MESSAGE, { desiredEnabled });
      }
      if (result.skippedReason === "orphaned-marker" || !result.ok) {
        // Orphaned can still arrive between the preflight and the strip; the
        // writer refuses it correctly and we map the refusal, never a retry lie.
        return result.skippedReason === "orphaned-marker"
          ? postCommitRefusal(409, "grok", "orphaned_marker", ORPHANED_MARKER_MESSAGE, { desiredEnabled })
          : postCommitRefusal(500, "grok", "write_failed", result.message, { desiredEnabled });
      }
      // The writer's own read IS the last read within this synchronous
      // operation (012 Rev 3 N4): strip removed the fence, so absent.
      return jsonResponse({
        ok: true, clientId: "grok", changed: result.changed,
        state: "absent",
        desiredEnabled,
        message: result.changed
          ? "Grok integration disabled — the opencodex block was removed. Re-enabling regenerates it from the current model list."
          : "Grok integration is already off",
      } satisfies NativeToggleEnvelope);
    }

    /*
     * Enable. The fence must name the host/port the RUNNING process bound, not
     * what config.json last recorded (Rev 3 N1; runGrokApplyFlight pattern):
     * a stale config.hostname picks the wrong loopback policy branch entirely.
     */
    const runtime = (deps.readRuntimePort ?? readRuntimePort)(process.pid);
    const port = runtime?.port ?? (Number(ctx.url.port) || config.port);
    const hostname = runtime?.hostname ?? config.hostname;

    /*
     * The catalog fetch is the ONLY await between check and write. Whatever
     * the file looked like before it means nothing after it — so the recheck
     * below runs after the fetch and immediately before the writer, which is
     * synchronous from entry (012 §One preflight is not enough).
     */
    const fetchModels = deps.fetchAllModels ?? defaultFetchAllModels;
    let models: GrokInjectModel[];
    try {
      const routed = filterCatalogVisibleModels(await fetchModels(config), config);
      models = [
        // Native slugs carry their context window: without it Grok falls back
        // to its own 200k default and understates a 372k model.
        ...visibleNativeSlugs(config).map(id => {
          const contextWindow = nativeOpenAiContextWindow(id, nativeContextLimits(config));
          return { id, ...(contextWindow !== undefined ? { contextWindow } : {}) };
        }),
        ...routed.map(m => ({
          id: m.alias ?? `${m.provider}/${m.id}`,
          ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
        })),
      ];
    } catch (error) {
      // A catalog failure must never write an empty fence (syncGrokConfig
      // guards this; the route inherits the rule). Nothing was written.
      return postCommitRefusal(500, "grok", "write_failed",
        `The model catalog is unavailable, so nothing was written (${error instanceof Error ? error.message : String(error)}). Try again once provider discovery recovers.`, { desiredEnabled });
    }

    const recheck = inspectGrokConfig();
    if (recheck.kind === "not_installed") return postCommitRefusal(404, "grok", "not_installed", NOT_INSTALLED_MESSAGE, { desiredEnabled });
    if (recheck.kind === "orphaned_marker") return postCommitRefusal(409, "grok", "orphaned_marker", ORPHANED_MARKER_MESSAGE, { desiredEnabled });

    const inject = deps.injectGrokConfig ?? injectGrokConfig;
    const result = inject(port, models, {
      ...(hostname !== undefined ? { hostname } : {}),
      // The FULL list plus the exclusion set, never a pre-filtered list: the
      // writer allocates aliases over everything, so a model's alias never
      // depends on its neighbours' switches.
      excluded: new Set(config.grokExcludedModels ?? []),
    });

    if (result.skippedReason === "non-loopback") {
      /*
       * The non-loopback branch reports its own strip only through `changed`,
       * so a strip that REFUSED and a strip that found nothing are
       * indistinguishable in the result. EXHAUSTIVE post-inspection decides —
       * the reported state is whatever the LAST read observed, never what the
       * operation intended (audit r9).
       */
      const after = inspectGrokConfig();
      switch (after.kind) {
        case "orphaned_marker":
          return postCommitRefusal(409, "grok", "orphaned_marker", ORPHANED_MARKER_MESSAGE, { desiredEnabled });
        case "present":
          // A well-formed fence arrived from elsewhere between the strip and
          // this read (`ocx ensure`, another proxy, a hand edit). It is not
          // ours to remove under a policy that just declined to write one,
          // and calling it `absent` would contradict the read.
          return jsonResponse({
            ok: true, clientId: "grok", changed: result.changed,
            state: "current", reason: "non_loopback_superseded",
            desiredEnabled,
            message: "opencodex is bound to a non-loopback address, so this request did not write a block — but a well-formed opencodex block is present in the Grok config, written by something else. The card shows what is on disk.",
          } satisfies NativeToggleEnvelope);
        case "not_installed":
          return postCommitRefusal(404, "grok", "not_installed", NOT_INSTALLED_MESSAGE, { desiredEnabled });
        case "absent":
          return jsonResponse({
            ok: true, clientId: "grok", changed: result.changed,
            state: "absent", reason: "non_loopback_removed",
            desiredEnabled,
            message: "opencodex is bound to a non-loopback address, so Grok cannot be auto-registered. The previously generated block was removed because it pointed at a loopback address that no longer serves.",
          } satisfies NativeToggleEnvelope);
        default: {
          // A future fifth GrokInspection kind must fail to COMPILE, not fall
          // through to a success-looking answer (C-gate nit).
          const exhaustive: never = after;
          throw new Error(`unhandled Grok inspection kind: ${JSON.stringify(exhaustive)}`);
        }
      }
    }

    if (result.skippedReason === "no-grok-home") {
      return postCommitRefusal(404, "grok", "not_installed", NOT_INSTALLED_MESSAGE, { desiredEnabled });
    }
    if (result.skippedReason === "orphaned-marker") {
      return postCommitRefusal(409, "grok", "orphaned_marker", ORPHANED_MARKER_MESSAGE, { desiredEnabled });
    }
    if (!result.ok) {
      return postCommitRefusal(500, "grok", "write_failed", result.message, { desiredEnabled });
    }
    return jsonResponse({
      ok: true, clientId: "grok", changed: result.changed,
      state: "current",
      desiredEnabled,
      message: result.changed ? "Grok integration enabled — the opencodex block was regenerated from the current model list." : "Grok integration is already on",
    } satisfies NativeToggleEnvelope);
  })();
  try {
    return await grokToggleFlight;
  } finally {
    grokToggleFlight = null;
  }
}

let claudeDesktopToggleFlight: Promise<Response> | null = null;

async function handleClaudeDesktopToggle(ctx: ManagementContext): Promise<Response> {
  if (claudeDesktopToggleFlight) {
    return refusal(409, "claude-desktop", "config_busy",
      "Another Claude Desktop change is already in flight. Nothing was written — try again in a moment.");
  }
  claudeDesktopToggleFlight = (async (): Promise<Response> => {
    let body: { enabled?: unknown };
    try {
      body = await readManagementJsonBody(ctx.req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.enabled !== "boolean") return jsonResponse({ error: "enabled must be a boolean" }, 400);

    const { setIntegrationEnabled } = await import("../../codex/desired-state");
    const persisted = setIntegrationEnabled("claude-desktop", body.enabled);
    if (!persisted.ok) {
      return refusal(persisted.retryable ? 409 : 500, "claude-desktop", persisted.retryable ? "config_busy" : "write_failed", persisted.message);
    }
    const desiredEnabled = loadConfig().clientIntegrations?.["claude-desktop"] !== false;
    const current = loadConfig();
    const fingerprint = current.claudeCode?.desktopProfile?.appliedFingerprint ?? null;

    if (!body.enabled) {
      const removed = (ctx.deps.removeDesktop3pStandardPivot ?? removeDesktop3pStandardPivot)({ appliedFingerprint: fingerprint });
      if (removed.kind === "cleanup_incomplete") {
        return postCommitRefusal(500, "claude-desktop", "cleanup_incomplete",
          "Claude Desktop now points at standard mode, but credential cleanup is incomplete.",
          { desiredEnabled, residualPaths: removed.residualPaths ?? [] });
      }
      if (!removed.ok) {
        return postCommitRefusal(409, "claude-desktop", removed.reason === "metadata_unreadable" ? "metadata_unreadable" : "write_failed",
          "Claude Desktop configuration could not be changed safely.", { desiredEnabled });
      }
      return jsonResponse({
        ok: true, clientId: "claude-desktop", changed: removed.changed, state: "absent", desiredEnabled,
        message: removed.changed ? "Claude Desktop integration disabled." : "Claude Desktop integration is already off.",
      } satisfies NativeToggleEnvelope);
    }

    const fetchModels = ctx.deps.fetchAllModels ?? defaultFetchAllModels;
    try {
      const fetched = await fetchModels(current);
      const latest = loadConfig();
      const latestDesiredEnabled = latest.clientIntegrations?.["claude-desktop"] !== false;
      if (!latestDesiredEnabled) {
        return postCommitRefusal(409, "claude-desktop", "desired_state_changed",
          "Claude Desktop enable was cancelled because the desired state changed to off.", { desiredEnabled: latestDesiredEnabled });
      }
      const routed = filterCatalogVisibleModels(fetched, latest).map(model => ({
        provider: model.provider, id: model.id, contextWindow: model.contextWindow,
      }));
      const runtime = (ctx.deps.readRuntimePort ?? readRuntimePort)(process.pid);
      const result = (ctx.deps.writeDesktop3pConfig ?? writeDesktop3pConfig)(
        runtime?.port ?? latest.port,
        [...desktopVisibleNativeSlugs(latest)],
        routed,
        latest.apiKeys?.[0]?.key,
        "static",
        latest.claudeCode?.desktopProfile,
        nativeContextLimits(latest),
      );
      if (!result.written) return postCommitRefusal(500, "claude-desktop", "write_failed", "Claude Desktop apply failed.", { desiredEnabled: latestDesiredEnabled });
      return jsonResponse({
        ok: true, clientId: "claude-desktop", changed: true, state: "current", desiredEnabled: latestDesiredEnabled,
        message: "Claude Desktop integration enabled.",
      } satisfies NativeToggleEnvelope);
    } catch {
      return postCommitRefusal(500, "claude-desktop", "write_failed", "Claude Desktop apply failed.", { desiredEnabled });
    }
  })();
  try {
    return await claudeDesktopToggleFlight;
  } finally {
    claudeDesktopToggleFlight = null;
  }
}

export async function handleNativeIntegrationRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps } = ctx;

  if (url.pathname === "/api/native-integrations" && req.method === "GET") {
    const { getConfigPath } = await import("../../config");
    return jsonResponse({
      clients: [claudeStatus(config, getConfigPath()), grokStatus(config), codexStatus(config, getConfigPath()), desktopStatus(config)],
    } satisfies NativeStatusListEnvelope);
  }

  if (url.pathname === "/api/native-integrations/claude" && req.method === "PUT") {
    let body: { enabled?: unknown };
    try {
      body = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "enabled must be a boolean" }, 400);
    }

    const enabled = body.enabled;
    if (claudeCodeEnabled(config) === enabled) {
      return jsonResponse({
        ok: true, clientId: "claude", changed: false,
        state: enabled ? "current" : "absent",
        desiredEnabled: enabled,
        message: enabled ? "Claude inbound is already on" : "Claude inbound is already off",
      } satisfies NativeToggleEnvelope);
    }

    const next = { ...(config.claudeCode ?? {}), enabled };
    /*
     * Stamp the migration sentinel on every persist of this block, exactly as
     * PUT /api/claude-code does (agent-settings-routes.ts:1068).
     *
     * The migration reads "a claudeCode block with no authMode" as a pre-upgrade
     * subscriber and pins it to literal subscription. Toggling Claude ON is one
     * of the two ways a block gets CREATED, so without this the next startServer
     * would silently convert a user's Auto auth mode into a sticky manual
     * subscription — a failure that surfaces nowhere near this route.
     */
    if (!next.authModeMigratedAt) next.authModeMigratedAt = new Date().toISOString();
    config.claudeCode = next;

    /*
     * `deps.` first: ManagementApiDeps carries this seam so route tests with an
     * in-memory fixture cannot overwrite the developer's real OPENCODEX_HOME.
     */
    const persist = deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode;
    try {
      persist(config);
    } catch (error) {
      if (isConfigLockError(error)) {
        return isLockContention(error)
          ? refusal(409, "claude", "config_busy",
              "Another process is saving the configuration right now. Try again in a moment.")
          : refusal(500, "claude", "write_failed",
              `The configuration lock could not be acquired: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }

    return jsonResponse({
      ok: true, clientId: "claude", changed: true,
      state: enabled ? "current" : "absent",
      desiredEnabled: enabled,
      message: enabled ? "Claude inbound enabled" : "Claude inbound disabled",
    } satisfies NativeToggleEnvelope);
  }

  if (url.pathname === "/api/native-integrations/grok" && req.method === "PUT") {
    return handleGrokToggle(ctx);
  }

  if (url.pathname === "/api/native-integrations/codex" && req.method === "PUT") {
    return handleCodexToggle(ctx);
  }

  if (url.pathname === "/api/native-integrations/claude-desktop" && req.method === "PUT") {
    return handleClaudeDesktopToggle(ctx);
  }

  return null;
}
