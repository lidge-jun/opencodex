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

async function roleModelCandidates(config: OcxConfig, models: readonly CatalogModel[]): Promise<RoleModelCandidate[]> {
  const [catalog, { subagentSelectableModels }, { resolveMatchedPrice }] = await Promise.all([
    import("../../codex/catalog"),
    import("../../codex/subagent-selectable-models"),
    import("../../usage/cost"),
  ]);
  const nativeSlugs = catalog.listCatalogNativeSlugs();
  const routed = new Map(models.map(model => [catalog.catalogModelSlug(model), model]));
  const unitPrice = (provider: string, modelId: string): number | null => {
    const cost = resolveMatchedPrice(provider, modelId)?.cost4;
    return cost ? cost.input + cost.output : null;
  };
  return subagentSelectableModels(config, models, nativeSlugs).map(slug => {
    const row = routed.get(slug);
    if (row) {
      return {
        model: slug,
        unitPrice: unitPrice(row.provider, row.id),
        efforts: row.reasoningEfforts ?? [],
        ...(row.defaultReasoningEffort ? { defaultEffort: row.defaultReasoningEffort } : {}),
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

export class NoSizingModelError extends Error {}

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
  const sizingModel = options.sizingModel?.trim() || readConfiguredDefaultModel();
  if (!sizingModel) throw new NoSizingModelError("no default model is set in Codex config.toml; pass a sizing model");

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
      sizingError = answer.error;
      for (const role of names) outcomes.set(role, { unsized: `the sizing call failed: ${answer.error}` });
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
