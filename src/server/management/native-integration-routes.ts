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
 * devlog/_plan/260803_integrations_toggle_all/, and 007 records why Codex and
 * Claude Desktop are NOT here: their state spans several artifacts and a live
 * database, so they need a durable operation record this module deliberately
 * does not have.
 *
 * Design of record: devlog/_plan/260803_integrations_toggle_all/030 (routes),
 * 011 (Claude Code), 012 (Grok).
 */
import { readRuntimePort, saveConfigPreservingClaudeCode } from "../../config";
import { filterCatalogVisibleModels, nativeOpenAiContextWindow, visibleNativeSlugs } from "../../codex/catalog";
import { injectGrokConfig, stripGrokConfig, type GrokInjectModel } from "../../grok/inject";
import { inspectGrokConfig } from "../../grok/inspect";
import { grokConfigPath } from "../../grok/status";
import { assertNativeTeardownOwned } from "../../integrations/native/ownership-preflight";
import type { OcxConfig } from "../../types";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";

export type NativeIntegrationClientId = "claude" | "grok";

/** Every reason this module can decline, in one place (audit r3 #6). */
export type NativeRefusalReason =
  | "not_installed"
  | "orphaned_marker"
  | "home_mismatch"
  | "config_busy"
  | "write_failed";

export interface NativeStatus {
  clientId: NativeIntegrationClientId;
  state: "absent" | "current" | "unsafe";
  installed: boolean;
  configPath: string;
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
  /** Present when the outcome needs more than success/failure to be honest. */
  reason?: string;
}

export interface NativeRefusalEnvelope {
  error: string;
  code: "native_integration_refused" | "native_integration_failed";
  clientId: NativeIntegrationClientId;
  reason: NativeRefusalReason;
  message: string;
}

function refusal(
  status: number,
  clientId: NativeIntegrationClientId,
  reason: NativeRefusalReason,
  message: string,
): Response {
  return jsonResponse({
    error: status >= 500 ? "native integration change failed" : "native integration change refused",
    code: status >= 500 ? "native_integration_failed" : "native_integration_refused",
    clientId, reason, message,
  } satisfies NativeRefusalEnvelope, status);
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
    // Nothing can refuse this disable: no external file, no shared teardown.
    disableBlocked: null,
  };
}

/**
 * Grok's GET row (030 §field table). `disableBlocked` is ADVISORY — the file
 * can change before the PUT, which re-checks with the same inspector and whose
 * answer is authoritative.
 */
function grokStatus(): NativeStatus {
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

    if (!enabled) {
      /*
       * Disable only: a strip is a SHARED teardown — it must not run under a
       * service installed from another home (audit r1 #5). Enable is not
       * gated: writing our own fence tears nothing down.
       */
      const owned = assertNativeTeardownOwned();
      if (!owned.ok) return refusal(409, "grok", "home_mismatch", owned.message);

      const result = stripGrokConfig();
      if (result.skippedReason === "no-grok-home") {
        return refusal(404, "grok", "not_installed", NOT_INSTALLED_MESSAGE);
      }
      if (result.skippedReason === "orphaned-marker" || !result.ok) {
        // Orphaned can still arrive between the preflight and the strip; the
        // writer refuses it correctly and we map the refusal, never a retry lie.
        return result.skippedReason === "orphaned-marker"
          ? refusal(409, "grok", "orphaned_marker", ORPHANED_MARKER_MESSAGE)
          : refusal(500, "grok", "write_failed", result.message);
      }
      // The writer's own read IS the last read within this synchronous
      // operation (012 Rev 3 N4): strip removed the fence, so absent.
      return jsonResponse({
        ok: true, clientId: "grok", changed: result.changed,
        state: "absent",
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
          const contextWindow = nativeOpenAiContextWindow(id);
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
      return refusal(500, "grok", "write_failed",
        `The model catalog is unavailable, so nothing was written (${error instanceof Error ? error.message : String(error)}). Try again once provider discovery recovers.`);
    }

    const recheck = inspectGrokConfig();
    if (recheck.kind === "not_installed") return refusal(404, "grok", "not_installed", NOT_INSTALLED_MESSAGE);
    if (recheck.kind === "orphaned_marker") return refusal(409, "grok", "orphaned_marker", ORPHANED_MARKER_MESSAGE);

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
          return refusal(409, "grok", "orphaned_marker", ORPHANED_MARKER_MESSAGE);
        case "present":
          // A well-formed fence arrived from elsewhere between the strip and
          // this read (`ocx ensure`, another proxy, a hand edit). It is not
          // ours to remove under a policy that just declined to write one,
          // and calling it `absent` would contradict the read.
          return jsonResponse({
            ok: true, clientId: "grok", changed: result.changed,
            state: "current", reason: "non_loopback_superseded",
            message: "opencodex is bound to a non-loopback address, so this request did not write a block — but a well-formed opencodex block is present in the Grok config, written by something else. The card shows what is on disk.",
          } satisfies NativeToggleEnvelope);
        case "not_installed":
          return refusal(404, "grok", "not_installed", NOT_INSTALLED_MESSAGE);
        case "absent":
          return jsonResponse({
            ok: true, clientId: "grok", changed: result.changed,
            state: "absent", reason: "non_loopback_removed",
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
      return refusal(404, "grok", "not_installed", NOT_INSTALLED_MESSAGE);
    }
    if (result.skippedReason === "orphaned-marker") {
      return refusal(409, "grok", "orphaned_marker", ORPHANED_MARKER_MESSAGE);
    }
    if (!result.ok) {
      return refusal(500, "grok", "write_failed", result.message);
    }
    return jsonResponse({
      ok: true, clientId: "grok", changed: result.changed,
      state: "current",
      message: result.changed ? "Grok integration enabled — the opencodex block was regenerated from the current model list." : "Grok integration is already on",
    } satisfies NativeToggleEnvelope);
  })();
  try {
    return await grokToggleFlight;
  } finally {
    grokToggleFlight = null;
  }
}

export async function handleNativeIntegrationRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps } = ctx;

  if (url.pathname === "/api/native-integrations" && req.method === "GET") {
    const { getConfigPath } = await import("../../config");
    return jsonResponse({
      clients: [claudeStatus(config, getConfigPath()), grokStatus()],
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
    if (typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "enabled must be a boolean" }, 400);
    }

    const enabled = body.enabled;
    if (claudeCodeEnabled(config) === enabled) {
      return jsonResponse({
        ok: true, clientId: "claude", changed: false,
        state: enabled ? "current" : "absent",
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
      message: enabled ? "Claude inbound enabled" : "Claude inbound disabled",
    } satisfies NativeToggleEnvelope);
  }

  if (url.pathname === "/api/native-integrations/grok" && req.method === "PUT") {
    return handleGrokToggle(ctx);
  }

  return null;
}
