import type { ManagementContext } from "./context";
import { catalogModelSlug, filterCatalogVisibleModels, nativeModelRows, listCatalogNativeSlugs } from "../../codex/catalog";
import { subagentSelectableModels } from "../../codex/subagent-selectable-models";
import { saveConfigPreservingClaudeCode, deleteConfigTopLevelKey, mutatePersistedConfig, adoptPersistedClaudeCode, initializePersistedConfigIfMissing, observeInitialConfigState } from "../../config";
import { captureConfigTopLevelRollback, parsedConfigRebaseDeletionKeys, projectConfigRebaseProvenance, deleteConfigObjectChildKey } from "../../config/rebase-provenance";
import { InitialConfigPublicationError } from "../../config/initialize";
import { ConfigWritePublishedError } from "../../config/persist-unlocked";
import { commitClaudeCodeBlock } from "../../claude/claude-code-block";
import { resolveSubagentForceModel, SAFE_AGENT_MODEL_ID } from "../../claude/subagent-model";
import { inspectSubagentForceStatus } from "../../claude/subagent-force-status";
import { jsonResponse } from "../auth-cors";
import { isPlainRecord, fetchInitializedModels as fetchAllModels } from "./shared";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";

export async function handleSubagentModelRoutes(ctx: ManagementContext, autoApplyDesktopBestEffort: () => Promise<void>): Promise<Response | null> {
  const { req, url, config, deps, convergeCodexCatalog, syncClaudeAgentDefsBestEffort } = ctx;
  // Featured roster and saved picker order are separate settings. Native Codex advertises
  // the first five eligible visible rows by display priority; OCX guidance uses natural ranks.
  if (url.pathname === "/api/subagent-models" && req.method === "GET") {
    const models = await (deps.fetchAllModels ?? fetchAllModels)(config);
    // Native gpt (passthrough) are also valid subagent picks — they're picker-visible models in the
    // catalog, just buried by priority. List them first so the user can feature them over routed.
    const chosen = config.subagentModels ?? [];
    // A saved roster slot must stay representable even after its model is disabled
    // elsewhere (Models page, provider allowlist, a provider row going away). The
    // dashboard treats `available` as the set of rows it can render, so a chosen id
    // missing from it disappears from the roster UI and the next Save — which PUTs
    // exactly what the UI holds — silently truncates the persisted list. Losing a
    // deliberate 5-model roster to an unrelated visibility toggle is data loss, not a
    // filter. Same reasoning as `fetchGrokCandidateModels`, which deliberately lists a
    // model the user already excluded so its switch remains reachable.
    const available = subagentSelectableModels(config, models, listCatalogNativeSlugs());
    // #857: let CLI/GUI show when a running Codex app-server keeps an older
    // in-memory catalog than the one on disk. Bounded request-path read: the synchronous
    // collector blocked the event loop for the whole Windows CIM walk (4-7s measured).
    const {
      collectCodexAppServerCatalogStateWithin,
      DASHBOARD_CATALOG_STATE_DEADLINE_MS,
    } = await import("../../codex/app-server-processes");
    const catalogState = await collectCodexAppServerCatalogStateWithin(DASHBOARD_CATALOG_STATE_DEADLINE_MS);
    const forceAvailable = subagentSelectableModels({ ...config, subagentModels: [] }, filterCatalogVisibleModels(models, config), listCatalogNativeSlugs());
    return jsonResponse({
      chosen, available, catalogState,
      force: config.claudeCode?.subagentModelForce ?? null,
      forceAvailable,
      forceStatus: config.claudeCode?.subagentModelForce === undefined ? null : await inspectSubagentForceStatus(
        resolveSubagentForceModel(config, {}, { entries: forceAvailable }) !== null,
      ),
      pickerAvailable: [...new Set(filterCatalogVisibleModels(models, config).map(catalogModelSlug).filter(slug => slug.includes("/")))],
      pickerOrder: config.modelPickerOrder ?? [],
      pickerOrderMode: config.modelPickerOrderMode ?? null,
    });
  }
  if (url.pathname === "/api/subagent-models" && req.method === "PUT") {
    // Observe before body/discovery awaits: disappearance of an existing config
    // must never turn a scoped update into first-run initialization.
    const initialConfigState = deps.saveConfigPreservingClaudeCode ? undefined : observeInitialConfigState();
    let rawBody: unknown;
    try { rawBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(rawBody)) return jsonResponse({ error: "JSON body must be an object" }, 400);
    const body = rawBody as { models?: unknown; pickerOrder?: unknown; pickerOrderMode?: unknown; force?: unknown };
    const updatesForce = Object.hasOwn(body, "force");
    const updatesRoster = body.models !== undefined;
    const updatesPicker = body.pickerOrder !== undefined;
    if (!updatesRoster && !updatesPicker && !updatesForce) return jsonResponse({ error: "models, pickerOrder or force is required" }, 400);
    let chosen: string[] | undefined;
    if (updatesRoster) {
      if (!Array.isArray(body.models) || body.models.some(model => typeof model !== "string")) {
        return jsonResponse({ error: "models must be an array of strings" }, 400);
      }
      // Keep the original valid roster contract: no discovery validation, trimming or deduping.
      chosen = body.models.slice(0, 5);
    }
    const mode = body.pickerOrderMode;
    if (mode !== undefined && (!updatesPicker || (mode !== null
      && mode !== "alphabetical" && mode !== "provider" && mode !== "most-used"))) {
      return jsonResponse({ error: "pickerOrderMode requires pickerOrder and must be alphabetical, provider, most-used, or null" }, 400);
    }
    let pickerOrder: string[] | undefined;
    if (updatesPicker) {
      if (body.pickerOrder !== null && (!Array.isArray(body.pickerOrder)
        || body.pickerOrder.some(model => typeof model !== "string" || model.trim() === ""))) {
        return jsonResponse({ error: "pickerOrder must be an array of non-empty routed model ids, or null" }, 400);
      }
      pickerOrder = body.pickerOrder === null ? [] : (body.pickerOrder as string[]).map(model => model.trim());
      if (new Set(pickerOrder).size !== pickerOrder.length) {
        return jsonResponse({ error: "pickerOrder must not contain duplicate ids" }, 400);
      }
      if (pickerOrder.length > 0) {
        const models = await (deps.fetchAllModels ?? fetchAllModels)(config);
        // Evaluate visibility AFTER discovery: a concurrent visibility write may have completed.
        const visible = new Set(filterCatalogVisibleModels(models, config).map(catalogModelSlug).filter(slug => slug.includes("/")));
        // A bare native id orders the complete picker (docs: guides/model-ordering.md).
        for (const row of nativeModelRows(config)) if (!row.disabled) visible.add(row.slug);
        if (pickerOrder.some(model => !visible.has(model))) {
          return jsonResponse({ error: "pickerOrder must contain visible routed or native model ids, each at most once" }, 400);
        }
      }
    }

    if (updatesForce && body.force !== null) {
      if (typeof body.force !== "string" || !SAFE_AGENT_MODEL_ID.test(body.force)) {
        return jsonResponse({ error: "force must be a safe exposed model id or null" }, 400);
      }
      const models = await (deps.fetchAllModels ?? fetchAllModels)(config);
      const exposed = subagentSelectableModels({ ...config, subagentModels: [] }, filterCatalogVisibleModels(models, config), listCatalogNativeSlugs());
      if (!resolveSubagentForceModel({ ...config, claudeCode: { ...config.claudeCode, subagentModelForce: body.force } }, {}, { entries: exposed })) {
        return jsonResponse({ error: "force must resolve to an exposed model" }, 400);
      }
    }

    if (updatesForce && initialConfigState === "invalid") {
      return jsonResponse({ error: "force settings could not be persisted" }, 409);
    }

    // Everything above can await. From this snapshot through persistence there is no yield.
    // Stage deletion intent before adopting the touched fields through the canonical
    // live deletion owner. A failed save restores both fields and pending intent.
    if ((updatesPicker || updatesForce) && config.configRebaseProvenance !== undefined
      && parsedConfigRebaseDeletionKeys(config) === null) {
      // A newer provenance format must not silently discard this clear's intent on rebase.
      return jsonResponse({ error: "unsupported config deletion provenance" }, 409);
    }
    const draft = { ...projectConfigRebaseProvenance(config) };
    if (chosen !== undefined) draft.subagentModels = chosen;
    if (updatesForce) {
      commitClaudeCodeBlock(draft, { ...config.claudeCode });
      if (body.force === null) deleteConfigObjectChildKey(draft, "claudeCode", "subagentModelForce");
      else draft.claudeCode!.subagentModelForce = body.force as string;
    }
    if (pickerOrder !== undefined) {
      if (pickerOrder.length === 0) {
        deleteConfigTopLevelKey(draft, "modelPickerOrder");
        deleteConfigTopLevelKey(draft, "modelPickerOrderMode");
      } else {
        draft.modelPickerOrder = pickerOrder;
        if (mode === "alphabetical" || mode === "provider" || mode === "most-used") draft.modelPickerOrderMode = mode;
        else deleteConfigTopLevelKey(draft, "modelPickerOrderMode");
      }
    }
    const projected = projectConfigRebaseProvenance(draft);
    const touched = [
      ...(updatesRoster ? ["subagentModels" as const] : []),
      ...(updatesForce ? ["claudeCode" as const] : []),
      ...(updatesPicker ? ["modelPickerOrder" as const, "modelPickerOrderMode" as const] : []),
      "configRebaseProvenance" as const,
    ];
    const rollback = captureConfigTopLevelRollback(config, touched);
    try {
      for (const key of touched) {
        if (Object.hasOwn(projected, key)) Object.defineProperty(config, key, {
          value: projected[key], writable: true, enumerable: true, configurable: true,
        });
        else deleteConfigTopLevelKey(config, key);
      }
      if (updatesForce && body.force === null) deleteConfigObjectChildKey(config, "claudeCode", "subagentModelForce");
      if (updatesForce && initialConfigState === "missing") {
        // Create-only publication rechecks under the canonical lock and never
        // replaces a file another writer supplied while discovery was pending.
        if (initializePersistedConfigIfMissing(config) !== "created") {
          rollback();
          return jsonResponse({ error: "force settings could not be persisted" }, 409);
        }
        adoptPersistedClaudeCode(config, structuredClone(config.claudeCode));
      } else if (updatesForce && !deps.saveConfigPreservingClaudeCode) {
        const outcome = mutatePersistedConfig(persisted => {
          commitClaudeCodeBlock(persisted, { ...persisted.claudeCode });
          if (body.force === null) delete persisted.claudeCode!.subagentModelForce;
          else persisted.claudeCode!.subagentModelForce = body.force as string;
          if (updatesRoster) persisted.subagentModels = chosen!;
          if (updatesPicker) {
            if (pickerOrder!.length === 0) {
              deleteConfigTopLevelKey(persisted, "modelPickerOrder");
              deleteConfigTopLevelKey(persisted, "modelPickerOrderMode");
            } else {
              persisted.modelPickerOrder = pickerOrder;
              if (mode === "alphabetical" || mode === "provider" || mode === "most-used") persisted.modelPickerOrderMode = mode;
              else deleteConfigTopLevelKey(persisted, "modelPickerOrderMode");
            }
          }
          return { changed: true, value: structuredClone(persisted.claudeCode) };
        });
        if (outcome.status === "unavailable") {
          rollback();
          return jsonResponse({ error: "force settings could not be persisted" }, 409);
        }
        adoptPersistedClaudeCode(config, outcome.value);
      } else {
        (deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(config);
      }
    } catch (error) {
      // Once publication succeeded (or cannot be ruled out), restoring only the
      // live object would falsely report the old setting while disk may hold new bytes.
      if (!(error instanceof ConfigWritePublishedError)
        && !(error instanceof InitialConfigPublicationError && error.publication !== "not-published")) rollback();
      throw error;
    }
    // Capture the result before convergence yields to another settings mutation.
    const saved = {
      applied: [...(config.subagentModels ?? [])],
      force: config.claudeCode?.subagentModelForce ?? null,
      pickerOrder: [...(config.modelPickerOrder ?? [])],
      pickerOrderMode: config.modelPickerOrderMode ?? null,
    };
    const catalogRefresh = updatesRoster || updatesPicker ? await convergeCodexCatalog() : undefined;
    if (updatesRoster) {
      await syncClaudeAgentDefsBestEffort();
      await autoApplyDesktopBestEffort();
    }
    return jsonResponse({ ok: true, ...saved, catalogRefresh });
  }

  return null;
}
