import { ConfigMutationLockError } from "../../config";
import {
  parseGuardrailsCustomRule,
  parseGuardrailsSettingsPatch,
  type GuardrailsSettingsPatch,
} from "../../guardrails/config-schema";
import {
  GuardrailsConfigRevisionConflictError,
  GuardrailsCustomRuleMutationError,
  mutateAndAdoptGuardrailsConfig,
  mutateAndAdoptGuardrailsCustomRule,
  type GuardrailsCustomRuleMutation,
} from "../../guardrails/config-coordinator";
import {
  GuardrailsRuleCompileError,
  guardrailsBuiltinRuleCatalog,
} from "../../guardrails/registry";
import { GuardrailsScanCapacityError } from "../../guardrails/scanner";
import {
  guardrailsActivity,
  type GuardrailsTelemetryResult,
  type GuardrailsTelemetrySurface,
} from "../../guardrails/telemetry";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import {
  guardrailsOverviewDto,
  guardrailsRulesDto,
  guardrailsSettingsDto,
} from "./guardrails-dto";
import {
  guardrailsExportBundle,
  parseGuardrailsImport,
  prepareGuardrailsImport,
} from "./guardrails-import-export";
import { runGuardrailsTester } from "./guardrails-tester";

function withRevision(response: Response, revision: string): Response {
  response.headers.set("ETag", `"${revision}"`);
  return response;
}

function expectedRevision(ctx: ManagementContext): string | Response {
  const raw = ctx.req.headers.get("if-match")?.trim();
  if (!raw) {
    return jsonResponse({
      error: "If-Match is required for Guardrails mutations",
      code: "guardrails_revision_required",
    }, 428, ctx.req, ctx.config);
  }
  const strong = /^"([^"]+)"$/.exec(raw);
  return strong?.[1] ?? jsonResponse({
    error: "If-Match must contain one strong Guardrails ETag",
    code: "guardrails_revision_invalid",
  }, 400, ctx.req, ctx.config);
}

function customRuleId(url: URL): string | null {
  const prefix = "/api/guardrails/rules/";
  if (!url.pathname.startsWith(prefix)) return null;
  const raw = url.pathname.slice(prefix.length);
  if (!raw || raw.includes("/")) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function builtInToggleRuleId(url: URL): string | null {
  const match = /^\/api\/guardrails\/rules\/([^/]+)\/enabled$/.exec(url.pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

async function readJson(ctx: ManagementContext): Promise<{ body: unknown } | { response: Response }> {
  try {
    return { body: await readManagementJsonBody(ctx.req) };
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return { response: jsonResponse({ error: "invalid JSON body" }, 400, ctx.req, ctx.config) };
  }
}

function mutationError(ctx: ManagementContext, error: unknown): Response | null {
  if (error instanceof GuardrailsConfigRevisionConflictError) {
    return jsonResponse({
      error: error.message,
      code: "guardrails_revision_conflict",
      revision: error.currentRevision,
    }, 412, ctx.req, ctx.config);
  }
  if (error instanceof GuardrailsCustomRuleMutationError) {
    return jsonResponse({ error: error.message }, error.reason === "duplicate" ? 409 : 404, ctx.req, ctx.config);
  }
  if (error instanceof ConfigMutationLockError) {
    return jsonResponse({ error: error.message, code: "config_mutation_busy" }, 409, ctx.req, ctx.config);
  }
  if (error instanceof GuardrailsRuleCompileError) {
    return jsonResponse({ error: error.message, code: "guardrails_rule_invalid" }, 400, ctx.req, ctx.config);
  }
  return null;
}

function persistSettings(
  ctx: ManagementContext,
  patch: GuardrailsSettingsPatch,
  extra: Record<string, unknown> = {},
): Response {
  const revision = expectedRevision(ctx);
  if (revision instanceof Response) return revision;
  try {
    const mutate = ctx.deps.mutateAndAdoptGuardrailsConfig ?? mutateAndAdoptGuardrailsConfig;
    const outcome = mutate(ctx.config, patch, revision);
    if (outcome.status === "unavailable") {
      return jsonResponse({
        error: "Guardrails settings could not be persisted from the current config state",
        code: `config_${outcome.reason}`,
      }, 409, ctx.req, ctx.config);
    }
    const settings = guardrailsSettingsDto(ctx.config);
    return withRevision(
      jsonResponse({ ok: true, persistence: outcome.status, ...settings, ...extra }, 200, ctx.req, ctx.config),
      settings.revision,
    );
  } catch (error) {
    const response = mutationError(ctx, error);
    if (response) return response;
    throw error;
  }
}

function persistCustomRule(
  ctx: ManagementContext,
  mutation: GuardrailsCustomRuleMutation,
): Response {
  const revision = expectedRevision(ctx);
  if (revision instanceof Response) return revision;
  try {
    const mutate = ctx.deps.mutateAndAdoptGuardrailsCustomRule ?? mutateAndAdoptGuardrailsCustomRule;
    const outcome = mutate(ctx.config, mutation, revision);
    if (outcome.status === "unavailable") {
      return jsonResponse({
        error: "Guardrails rules could not be persisted from the current config state",
        code: `config_${outcome.reason}`,
      }, 409, ctx.req, ctx.config);
    }
    const rules = guardrailsRulesDto(ctx.config);
    return withRevision(
      jsonResponse({ ok: true, persistence: outcome.status, ...rules }, 200, ctx.req, ctx.config),
      rules.revision,
    );
  } catch (error) {
    const response = mutationError(ctx, error);
    if (response) return response;
    throw error;
  }
}

function parseActivityQuery(url: URL): Parameters<typeof guardrailsActivity>[0] | null {
  const allowed = new Set(["category", "limit", "mode", "result", "surface"]);
  if ([...url.searchParams.keys()].some(key => !allowed.has(key))) return null;
  const categoryText = url.searchParams.get("category");
  const category = categoryText === null ? undefined : Number(categoryText);
  if (category !== undefined && (!Number.isInteger(category) || category < 1 || category > 6)) return null;
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) return null;
  const mode = url.searchParams.get("mode") ?? undefined;
  if (mode !== undefined && mode !== "enforce" && mode !== "detect") return null;
  const results: readonly GuardrailsTelemetryResult[] = [
    "scanned", "masked", "detected", "blocked", "passthrough",
    "demask_warning", "tool_argument_restore_skipped",
  ];
  const result = url.searchParams.get("result") ?? undefined;
  if (result !== undefined && !results.includes(result as GuardrailsTelemetryResult)) return null;
  const surfaces: readonly GuardrailsTelemetrySurface[] = ["responses", "chat", "messages", "compact"];
  const surface = url.searchParams.get("surface") ?? undefined;
  if (surface !== undefined && !surfaces.includes(surface as GuardrailsTelemetrySurface)) return null;
  return {
    ...(category !== undefined ? { category } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(result !== undefined ? { result: result as GuardrailsTelemetryResult } : {}),
    ...(surface !== undefined ? { surface: surface as GuardrailsTelemetrySurface } : {}),
  };
}

export async function handleGuardrailsRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/guardrails" && req.method === "GET") {
    try {
      const dto = guardrailsOverviewDto(config);
      return withRevision(jsonResponse(dto, 200, req, config), dto.revision);
    } catch {
      return jsonResponse({
        error: "Guardrails rule assets are unavailable or invalid",
        code: "guardrails_assets_invalid",
      }, 503, req, config);
    }
  }
  if (url.pathname === "/api/guardrails/settings" && req.method === "GET") {
    const dto = guardrailsSettingsDto(config);
    return withRevision(jsonResponse(dto, 200, req, config), dto.revision);
  }
  if (url.pathname === "/api/guardrails/rules" && req.method === "GET") {
    try {
      const dto = guardrailsRulesDto(config);
      return withRevision(jsonResponse(dto, 200, req, config), dto.revision);
    } catch {
      return jsonResponse({
        error: "Guardrails rule assets are unavailable or invalid",
        code: "guardrails_assets_invalid",
      }, 503, req, config);
    }
  }
  if (url.pathname === "/api/guardrails/catalog" && req.method === "GET") {
    try {
      return jsonResponse({ builtinRules: guardrailsBuiltinRuleCatalog() }, 200, req, config);
    } catch {
      return jsonResponse({
        error: "Guardrails rule assets are unavailable or invalid",
        code: "guardrails_assets_invalid",
      }, 503, req, config);
    }
  }
  if (url.pathname === "/api/guardrails/activity" && req.method === "GET") {
    const query = parseActivityQuery(url);
    return query
      ? jsonResponse(guardrailsActivity(query), 200, req, config)
      : jsonResponse({ error: "invalid Guardrails activity filter" }, 400, req, config);
  }
  if (url.pathname === "/api/guardrails/export" && req.method === "GET") {
    const response = jsonResponse(guardrailsExportBundle(config.guardrails), 200, req, config);
    response.headers.set("Content-Disposition", 'attachment; filename="opencodex-guardrails.json"');
    return response;
  }
  if (url.pathname === "/api/guardrails/test" && req.method === "POST") {
    const read = await readJson(ctx);
    if ("response" in read) return read.response;
    try {
      const tested = runGuardrailsTester(config, read.body);
      return tested.ok
        ? jsonResponse(tested.result, 200, req, config)
        : jsonResponse({ error: tested.error }, tested.status, req, config);
    } catch (error) {
      if (error instanceof GuardrailsRuleCompileError) {
        return jsonResponse({ error: error.message, code: "guardrails_rule_invalid" }, 400, req, config);
      }
      if (error instanceof GuardrailsScanCapacityError) {
        return jsonResponse({
          error: error.message,
          code: "guardrails_capacity_exceeded",
        }, 413, req, config);
      }
      throw error;
    }
  }
  if (url.pathname === "/api/guardrails/import" && req.method === "POST") {
    const read = await readJson(ctx);
    if ("response" in read) return read.response;
    const parsed = parseGuardrailsImport(read.body);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400, req, config);
    try {
      const prepared = prepareGuardrailsImport(config.guardrails, parsed.request);
      if (!prepared.ok) {
        if (parsed.request.dryRun && prepared.report) {
          return jsonResponse({
            ok: false,
            dryRun: true,
            error: prepared.error,
            ...prepared.report,
          }, 200, req, config);
        }
        return jsonResponse({
          error: prepared.error,
          ...(prepared.conflicts ? { conflicts: prepared.conflicts } : {}),
        }, prepared.conflicts ? 409 : 400, req, config);
      }
      if (parsed.request.dryRun) {
        return jsonResponse({ ok: true, dryRun: true, ...prepared.report }, 200, req, config);
      }
      return persistSettings(ctx, prepared.patch, { dryRun: false, import: prepared.report });
    } catch (error) {
      const response = mutationError(ctx, error);
      if (response) return response;
      throw error;
    }
  }
  if (url.pathname === "/api/guardrails/rules" && req.method === "POST") {
    const read = await readJson(ctx);
    if ("response" in read) return read.response;
    const parsed = parseGuardrailsCustomRule(read.body);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400, req, config);
    return persistCustomRule(ctx, { kind: "create", rule: parsed.rule });
  }

  const toggleRuleId = builtInToggleRuleId(url);
  if (toggleRuleId && req.method === "PUT") {
    if (!guardrailsBuiltinRuleCatalog().some(rule => rule.ruleId === toggleRuleId)) {
      return jsonResponse({ error: "built-in Guardrails rule was not found" }, 404, req, config);
    }
    const read = await readJson(ctx);
    if ("response" in read) return read.response;
    if (!read.body || typeof read.body !== "object" || Array.isArray(read.body)
      || Object.keys(read.body).some(key => key !== "enabled")
      || typeof (read.body as { enabled?: unknown }).enabled !== "boolean") {
      return jsonResponse({ error: "rule toggle body must contain enabled boolean" }, 400, req, config);
    }
    const disabled = new Set(config.guardrails?.disabledBuiltinRuleIds ?? []);
    if ((read.body as { enabled: boolean }).enabled) disabled.delete(toggleRuleId);
    else disabled.add(toggleRuleId);
    return persistSettings(ctx, { disabledBuiltinRuleIds: [...disabled].sort() });
  }

  const ruleId = customRuleId(url);
  if (ruleId && (req.method === "PUT" || req.method === "DELETE")) {
    if (req.method === "DELETE") return persistCustomRule(ctx, { kind: "delete", ruleId });
    const read = await readJson(ctx);
    if ("response" in read) return read.response;
    const parsed = parseGuardrailsCustomRule(read.body);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400, req, config);
    if (parsed.rule.ruleId !== ruleId) {
      return jsonResponse({ error: "custom ruleId cannot be changed" }, 400, req, config);
    }
    return persistCustomRule(ctx, { kind: "replace", ruleId, rule: parsed.rule });
  }

  if (url.pathname === "/api/guardrails/settings" && req.method === "PUT") {
    const read = await readJson(ctx);
    if ("response" in read) return read.response;
    const parsed = parseGuardrailsSettingsPatch(read.body);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400, req, config);
    return persistSettings(ctx, parsed.patch);
  }
  return null;
}
