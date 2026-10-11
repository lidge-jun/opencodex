/**
 * The read-only half of role auto-assign: size every Codex agent role with one model call, map
 * each size to a concrete model and effort, and return the proposals. Nothing is written here;
 * the dashboard and "ocx agent roles suggest --apply" apply a proposal through the ordinary
 * PUT /api/codex-agent-roles/{role}.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OcxConfig } from "../../types";
import type { CatalogModel } from "../../codex/catalog";
import type { RoleModelCandidate } from "../../codex/role-auto-assign";

export interface RoleSizingCall {
  readonly model: string;
  readonly system: string;
  readonly user: string;
}

export type CompleteRoleSizing = (call: RoleSizingCall, config: OcxConfig) => Promise<{ text: string; error?: string }>;

const SIZING_TIMEOUT_MS = 180_000;
const MAX_SIZING_RESPONSE_BYTES = 1024 * 1024;

/**
 * The completion error can carry upstream response text and exception messages, which may
 * include paths, account identifiers or secrets the redactor does not recognise. Only a fixed
 * category, plus a bare HTTP status, leaves the management response and the CLI.
 */
export function publicSizingError(error: string): string {
  const http = /^[\w .-]* HTTP (\d{3}):/.exec(error);
  if (http) return `HTTP ${http[1]}`;
  if (error.endsWith("response exceeded byte bound")) return "the response was too large";
  if (error.endsWith("returned non-JSON")) return "the response was not JSON";
  if (error.endsWith("returned no text")) return "the response had no text";
  return "the request could not be completed";
}

async function completeThroughProxy(call: RoleSizingCall, config: OcxConfig) {
  const { postLocalChatCompletion } = await import("../../lib/local-chat-completion");
  return postLocalChatCompletion({
    config,
    label: "role sizing",
    logTag: "role-sizing",
    timeoutMs: SIZING_TIMEOUT_MS,
    maxResponseBytes: MAX_SIZING_RESPONSE_BYTES,
    boundWhileStreaming: true,
    body: {
      model: call.model,
      messages: [{ role: "system", content: call.system }, { role: "user", content: call.user }],
    },
  });
}

async function modelCandidates(slugs: readonly string[], models: readonly CatalogModel[]): Promise<RoleModelCandidate[]> {
  const [catalog, { resolveMatchedPrice }] = await Promise.all([
    import("../../codex/catalog"),
    import("../../usage/cost"),
  ]);
  const nativeSlugs = catalog.listCatalogNativeSlugs();
  const routed = new Map(models.map(model => [catalog.catalogModelSlug(model), model]));
  // A routed model that declares no levels still gets the ladder Codex shows for it, the same one
  // the Models page lists, so its proposal carries an effort instead of none. An explicit empty
  // ladder means the model takes no effort control, and the written catalog lists none for it.
  const written = catalog.catalogModelLadders(slugs);
  const unitPrice = (provider: string, modelId: string): number | null => {
    const cost = resolveMatchedPrice(provider, modelId)?.cost4;
    return cost ? cost.input + cost.output : null;
  };
  return slugs.map(slug => {
    const row = routed.get(slug);
    if (row) {
      const ladder = written.get(slug);
      const efforts = Array.isArray(row.reasoningEfforts) ? row.reasoningEfforts : ladder?.efforts ?? [];
      // A row without its own default keeps the one Codex shows, when that rung is on the ladder.
      const shownDefault = ladder?.defaultEffort !== undefined && efforts.includes(ladder.defaultEffort)
        ? ladder.defaultEffort
        : undefined;
      const defaultEffort = row.defaultReasoningEffort ?? shownDefault;
      return {
        model: slug,
        unitPrice: unitPrice(row.provider, row.id),
        efforts,
        ...(defaultEffort ? { defaultEffort } : {}),
      };
    }
    if (nativeSlugs.includes(slug)) {
      const defaultEffort = catalog.nativeDefaultReasoningEffort(slug);
      return {
        model: slug,
        unitPrice: unitPrice("openai", slug),
        efforts: catalog.nativeReasoningEfforts(slug),
        ...(defaultEffort ? { defaultEffort } : {}),
      };
    }
    return { model: slug, unitPrice: null, efforts: [] };
  });
}

async function roleModelCandidates(config: OcxConfig, models: readonly CatalogModel[]): Promise<RoleModelCandidate[]> {
  const [{ listCatalogNativeSlugs }, { subagentSelectableModels }] = await Promise.all([
    import("../../codex/catalog"),
    import("../../codex/subagent-selectable-models"),
  ]);
  return modelCandidates(subagentSelectableModels(config, models, listCatalogNativeSlugs()), models);
}

export class NoSizingModelError extends Error {}

function resolveSizingModel(sizingModel: string | undefined, readConfiguredDefaultModel: () => string | null): string {
  const model = sizingModel?.trim() || readConfiguredDefaultModel();
  if (!model) throw new NoSizingModelError("no default model is set in Codex config.toml; pass a sizing model");
  return model;
}

export async function proposeCodexRoleModels(options: {
  config: OcxConfig;
  codexHome: string;
  sizingModel?: string;
  fetchAllModels: (config: OcxConfig) => Promise<CatalogModel[]>;
  completeRoleSizing?: CompleteRoleSizing;
}) {
  const [roles, sizing, assign, { readConfiguredDefaultModel }] = await Promise.all([
    import("../../codex/agent-role-models"),
    import("../../codex/role-sizing"),
    import("../../codex/role-auto-assign"),
    import("../../codex/catalog/parsing"),
  ]);
  const sizingModel = resolveSizingModel(options.sizingModel, readConfiguredDefaultModel);

  const roleRows = roles.listCodexAgentRoleModels(options.codexHome).map(row => ({
    role: row.role,
    model: row.model,
    effort: roles.readCodexAgentRoleEffort(row.role, options.codexHome),
  }));
  const inputs: { role: string; instructions: string }[] = [];
  const outcomes = new Map<string, import("../../codex/role-sizing").RoleSizingOutcome>();
  for (const row of roleRows) {
    let excerpt: string | null = null;
    try {
      excerpt = sizing.roleInstructionsExcerpt(readFileSync(join(options.codexHome, "agents", `${row.role}.toml`), "utf8"));
    } catch { /* an unreadable role is reported unsized below */ }
    if (excerpt === null) outcomes.set(row.role, { unsized: "the role file has no description or developer_instructions to size from" });
    else inputs.push({ role: row.role, instructions: excerpt });
  }

  let sizingError: string | null = null;
  if (inputs.length > 0) {
    const answer = await (options.completeRoleSizing ?? completeThroughProxy)({
      model: sizingModel,
      system: sizing.ROLE_SIZING_SYSTEM_PROMPT,
      user: sizing.buildRoleSizingUserMessage(inputs),
    }, options.config);
    const names = inputs.map(input => input.role);
    if (answer.error) {
      sizingError = publicSizingError(answer.error);
      for (const role of names) outcomes.set(role, { unsized: `the sizing call failed: ${sizingError}` });
    } else {
      for (const [role, outcome] of sizing.parseRoleSizingResponse(answer.text, names)) outcomes.set(role, outcome);
    }
  }

  const classified = assign.classifyRoleModelCandidates(
    await roleModelCandidates(options.config, await options.fetchAllModels(options.config)),
    options.config.codexRoleTiers,
  );
  return {
    sizingModel,
    sizingError,
    proposals: assign.buildRoleProposals(roleRows, outcomes, classified),
    candidates: classified.map(({ model, tier, tierSource, unitPrice }) => ({ model, tier, tierSource, unitPrice })),
  };
}

export const DELEGATED_WORK_ROLE = "delegated-work";

/**
 * The same sizing for the Subagents page's delegation default: the work a parent hands its
 * preferred subagent is sized as one standing role, and the pick comes from the models that page
 * offers. Effort is always proposed, restricted to the Codex levels the page can save.
 */
export async function proposeDelegationModel(options: {
  config: OcxConfig;
  work: string;
  offered: readonly string[];
  sizingModel?: string;
  models: readonly CatalogModel[];
  completeRoleSizing?: CompleteRoleSizing;
}) {
  const [sizing, assign, { readConfiguredDefaultModel }, { isCodexReasoningEffort }] = await Promise.all([
    import("../../codex/role-sizing"),
    import("../../codex/role-auto-assign"),
    import("../../codex/catalog/parsing"),
    import("../../reasoning-effort"),
  ]);
  const sizingModel = resolveSizingModel(options.sizingModel, readConfiguredDefaultModel);
  const answer = await (options.completeRoleSizing ?? completeThroughProxy)({
    model: sizingModel,
    system: sizing.DELEGATED_WORK_SIZING_SYSTEM_PROMPT,
    user: sizing.buildRoleSizingUserMessage([{ role: DELEGATED_WORK_ROLE, instructions: options.work }]),
  }, options.config);
  const sizingError = answer.error ? publicSizingError(answer.error) : null;
  const outcomes = sizingError
    ? new Map([[DELEGATED_WORK_ROLE, { unsized: `the sizing call failed: ${sizingError}` }]])
    : sizing.parseRoleSizingResponse(answer.text, [DELEGATED_WORK_ROLE]);
  const candidates = (await modelCandidates(options.offered, options.models))
    .map(candidate => ({ ...candidate, efforts: candidate.efforts.filter(isCodexReasoningEffort) }));
  const classified = assign.classifyRoleModelCandidates(candidates, options.config.codexRoleTiers);
  const [proposal] = assign.buildRoleProposals([{
    role: DELEGATED_WORK_ROLE,
    model: options.config.injectionModel ?? null,
    effort: options.config.injectionEffort ?? null,
  }], outcomes, classified);
  return {
    sizingModel,
    sizingError,
    proposal: proposal!,
    candidates: classified.map(({ model, tier, tierSource, unitPrice }) => ({ model, tier, tierSource, unitPrice })),
  };
}
