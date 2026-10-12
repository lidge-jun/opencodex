import { compactionRoutingSchema, memoryModelsSchema } from "../config/schema/leaf-validators";
import { runCatalogAction } from "./catalog-command-result";
import { readJsonInput, serializeManagementJson } from "./json-input";
import { printSettingsResult } from "./settings-result";
import {
  CliUsageError, printData, runtimeBaseUrl, runtimeRequest, takeFlag,
  takeOptionWithSyntax, type RuntimeApiDeps,
} from "./runtime-api";

type SettingCommand = "memory-models" | "compaction-routing";

function usage(sub: SettingCommand): string {
  const fields = sub === "memory-models"
    ? "[--extract-model <model> [--extract-effort <effort>]] [--consolidation-model <model> [--consolidation-effort <effort>]]"
    : "--model <model> [--effort <effort>] [--triggers <manual,auto>] [--sources <selector,...>]";
  return `Usage: ocx agent ${sub} show|clear [--json]\n       ocx agent ${sub} set (--file <FILE|-> | ${fields}) [--json]`;
}

function scalarBlock(sub: SettingCommand, values: Record<string, string>): Record<string, unknown> {
  if (sub === "memory-models") {
    const block: Record<string, unknown> = {};
    for (const phase of ["extract", "consolidation"]) {
      const model = values[`--${phase}-model`], effort = values[`--${phase}-effort`];
      if (effort !== undefined && model === undefined) {
        throw new CliUsageError("A memory phase effort requires its model", usage(sub));
      }
      if (model !== undefined) block[phase] = { model, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
    }
    if (!Object.keys(block).length) throw new CliUsageError("Set requires at least one memory phase model or an explicit file", usage(sub));
    return block;
  }
  return {
    ...(values["--model"] === undefined ? {} : { model: values["--model"] }),
    ...(values["--effort"] === undefined ? {} : { reasoningEffort: values["--effort"] }),
    // Deliberately preserve every CSV token: schema validation rejects blanks,
    // duplicates and whitespace instead of changing the requested scope.
    ...(values["--triggers"] === undefined ? {} : { triggers: values["--triggers"].split(",") }),
    ...(values["--sources"] === undefined ? {} : { sourceModels: values["--sources"].split(",") }),
  };
}

function normalizedBlock(sub: SettingCommand, value: unknown, input: boolean): Record<string, unknown> | null {
  if (!input && value === null) return null;
  const parsed = sub === "memory-models" ? memoryModelsSchema.safeParse(value) : compactionRoutingSchema.safeParse(value);
  if (!parsed.success) {
    if (input) throw new CliUsageError("Invalid model override block; check the supported fields and model/effort values", usage(sub));
    throw new Error("Invalid settings response");
  }
  return parsed.data;
}

/** Task-only settings replacement; no local fallback, model probe or pipeline toggle. */
export async function handleAgentSettingsCommand(
  sub: SettingCommand, argv: string[], deps: RuntimeApiDeps = {},
): Promise<number> {
  return runCatalogAction(async () => {
    const args = [...argv];
    const action = args.shift();
    if (action !== "show" && action !== "set" && action !== "clear") {
      throw new CliUsageError("Expected show, set or clear", usage(sub));
    }
    const wantsJson = takeFlag(args, "--json");
    const file = takeOptionWithSyntax(args, "--file")?.value;
    const flags = sub === "memory-models"
      ? ["--extract-model", "--extract-effort", "--consolidation-model", "--consolidation-effort"]
      : ["--model", "--effort", "--triggers", "--sources"];
    const values: Record<string, string> = {};
    for (const flag of flags) {
      const value = takeOptionWithSyntax(args, flag)?.value;
      if (value !== undefined) values[flag] = value;
    }
    if (args.length) throw new CliUsageError("Unexpected or repeated settings argument", usage(sub));
    const hasFields = Object.keys(values).length > 0;
    if (action !== "set" && (file !== undefined || hasFields)) {
      throw new CliUsageError("Only set accepts a file or model options", usage(sub));
    }
    if (file !== undefined && hasFields) throw new CliUsageError("--file cannot be combined with model options", usage(sub));
    const key = sub === "memory-models" ? "memoryModels" : "compactionRouting";
    const block = action === "set"
      ? normalizedBlock(sub, file === undefined ? scalarBlock(sub, values) : await readJsonInput(file, deps), true)
      : null;
    const body = action === "show" ? undefined : serializeManagementJson({ [key]: block });
    const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    const response = await runtimeRequest("/api/settings", {
      method: action === "show" ? "GET" : "PUT", redirect: "error", ...(body === undefined ? {} : { body }),
    }, pinned);
    if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Invalid settings response");
    const record = response as Record<string, unknown>;
    if (action !== "show" && record.ok !== true) throw new Error("Settings acceptance was not reported");
    const observed = normalizedBlock(sub, record[key], false);
    const data = { [key]: observed };
    const lines = [observed === null || Object.keys(observed).length === 0
      ? `${sub}: no custom overrides; existing routing remains in use.`
      : `${sub}: ${JSON.stringify(observed)}`];
    if (action === "show") {
      printData(data, wantsJson, lines);
      return 0;
    }
    return printSettingsResult(data, record.catalogRefreshPending, wantsJson, lines);
  });
}
